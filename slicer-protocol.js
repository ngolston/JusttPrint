'use strict';

/**
 * justtprint:// URL shared by the browser UI and the local helper.
 * The helper downloads the models and starts the slicer on this computer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.JusttPrintSlicerProtocol = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROTOCOL = 'justtprint:';
  const MAX_URL_LENGTH = 30000;

  function currentPlatform() {
    if (typeof process !== 'undefined' && process.platform) return process.platform;
    return '';
  }

  function buildJusttPrintOpenUrl({ origin, slicerName, slicerPath, filePaths, downloadToken }) {
    const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
    if (!origin) throw new Error('Missing JusttPrint server address');
    if (!slicerPath) throw new Error('Missing slicer path');
    if (!files.length) throw new Error('No model files to open in slicer');

    const url = new URL('justtprint://open/');
    url.searchParams.set('v', '1');
    url.searchParams.set('origin', new URL(origin).origin);
    url.searchParams.set('slicer', slicerName || 'Slicer');
    url.searchParams.set('slicerPath', slicerPath);
    if (downloadToken) url.searchParams.set('token', downloadToken);
    files.forEach((filePath) => url.searchParams.append('file', filePath));
    const href = url.toString();
    if (href.length > MAX_URL_LENGTH) {
      throw new Error('Too many files to send to the slicer in one step');
    }
    return href;
  }

  function parseJusttPrintProtocolUrl(raw) {
    let text = String(raw || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1);
    }
    if (!/^justtprint:/i.test(text)) {
      throw new Error('Not a justtprint URL');
    }
    const url = new URL(text.replace(/^justtprint:/i, 'https:'));
    const filePaths = url.searchParams.getAll('file').filter(Boolean);
    if (!filePaths.length) {
      throw new Error('The slicer link has no model files');
    }
    const origin = url.searchParams.get('origin');
    if (!origin) throw new Error('The slicer link has no server address');
    return {
      origin: new URL(origin).origin,
      slicerName: url.searchParams.get('slicer') || 'Slicer',
      slicerPath: url.searchParams.get('slicerPath') || '',
      downloadToken: url.searchParams.get('token') || '',
      filePaths
    };
  }

  function assertSafeSlicerPath(slicerPath, platform = currentPlatform()) {
    const raw = String(slicerPath || '').trim();
    if (!raw) throw new Error('Slicer path is empty');
    if (/[\0\r\n]/.test(raw)) throw new Error('Slicer path contains a newline');
    if (/[;&|`$<>]/.test(raw)) throw new Error('Slicer path contains shell syntax');
    if (/^flatpak\s+run\s+\S+/i.test(raw) || /^snap\s+run\s+\S+/i.test(raw)) {
      if (platform === 'win32') throw new Error('flatpak and snap slicers only run on Linux');
      return raw;
    }
    const windowsPath = /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\/.test(raw);
    if (platform === 'win32') {
      if (!windowsPath) throw new Error('Slicer path must be a Windows path such as C:\\Program Files\\OrcaSlicer\\orca-slicer.exe');
      return raw;
    }
    if (windowsPath) throw new Error('A Windows slicer path cannot run on this computer');
    if (!raw.startsWith('/')) throw new Error('Slicer path must be an absolute path');
    return raw;
  }

  function assertOriginAllowed(allowedOrigins, origin) {
    let actual;
    try {
      actual = new URL(origin).origin;
    } catch (error) {
      throw new Error('Invalid server origin');
    }
    const allowed = (Array.isArray(allowedOrigins) ? allowedOrigins : []).map((entry) => {
      try {
        return new URL(entry).origin;
      } catch (error) {
        return '';
      }
    }).filter(Boolean);
    if (!allowed.includes(actual)) {
      throw new Error(
        'This JusttPrint server is not allowed: ' + actual +
        '. Run: node justtprint-helper.js install --origin ' + actual
      );
    }
    return actual;
  }

  function resolveHelperSlicer(localSlicers, requested, platform = currentPlatform()) {
    const name = String((requested && requested.slicerName) || '').trim();
    const local = (Array.isArray(localSlicers) ? localSlicers : []).find((slicer) => {
      return slicer && slicer.path && String(slicer.name || '').toLowerCase() === name.toLowerCase();
    });
    if (local) {
      return {
        name: local.name,
        path: assertSafeSlicerPath(local.path, platform),
        source: 'local'
      };
    }
    if (!requested || !requested.slicerPath) {
      throw new Error('No slicer path. Add the slicer in JusttPrint settings, or run: node justtprint-helper.js add-slicer --name "OrcaSlicer" --path /path/to/slicer');
    }
    return {
      name: name || 'Slicer',
      path: assertSafeSlicerPath(requested.slicerPath, platform),
      source: 'server'
    };
  }

  function buildModelDownloadUrl(origin, filePath, downloadToken) {
    const base = new URL(origin);
    const url = base.origin + '/api/download/' + encodeURIComponent(filePath);
    return downloadToken ? url + '?token=' + encodeURIComponent(downloadToken) : url;
  }

  function commandFilePaths(commandData) {
    if (commandData && Array.isArray(commandData.filePaths) && commandData.filePaths.length) {
      return commandData.filePaths.filter(Boolean);
    }
    if (commandData && commandData.filePath) return [commandData.filePath];
    return [];
  }

  function launchFromCommand(commandData) {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return { ok: false, reason: 'no-document' };
    }
    const href = buildJusttPrintOpenUrl({
      origin: window.location.origin,
      slicerName: commandData && commandData.slicerName,
      slicerPath: commandData && commandData.slicerPath,
      filePaths: commandFilePaths(commandData),
      downloadToken: commandData && commandData.downloadToken
    });
    const now = Date.now();
    if (href === launchFromCommand.lastHref && now - (launchFromCommand.lastAt || 0) < 4000) {
      return { ok: true, deduped: true, href };
    }
    launchFromCommand.lastHref = href;
    launchFromCommand.lastAt = now;

    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    frame.src = href;
    document.body.appendChild(frame);
    setTimeout(() => {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }, 3000);
    return { ok: true, href };
  }

  return {
    PROTOCOL,
    MAX_URL_LENGTH,
    buildJusttPrintOpenUrl,
    parseJusttPrintProtocolUrl,
    assertSafeSlicerPath,
    assertOriginAllowed,
    resolveHelperSlicer,
    buildModelDownloadUrl,
    commandFilePaths,
    launchFromCommand
  };
});
