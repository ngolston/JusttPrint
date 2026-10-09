import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Download, Link2, Trash2 } from 'lucide-react';
import { shareLinks, type ShareLink, type ShareTarget } from '../api';
import { Button, IconButton } from '../components/Button';
import { Modal } from '../components/Overlay';
import { timeAgo } from '../home/format';
import { copyText, exposeGlobal, onServerEvent, showMessage } from '../page';

declare global {
  interface Window {
    /** Share a model or a collection: create read-only links with QR codes. */
    openShare?: (target: ShareTarget, name?: string) => void;
  }
}

const EXPIRY: [number, string][] = [
  [0, 'Never'],
  [1, 'After 1 day'],
  [7, 'After 7 days'],
  [30, 'After 30 days'],
  [90, 'After 90 days']
];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function fileLabel(filePath: string) {
  return filePath.split('::').pop()?.split(/[\\/]/).pop() || filePath;
}

export function expiryLabel(link: Pick<ShareLink, 'expiresAt' | 'expired'>, now = Date.now()): string {
  if (!link.expiresAt) return 'Never expires';
  if (link.expired) return 'Expired';
  const days = Math.ceil((Date.parse(link.expiresAt) - now) / (24 * 60 * 60 * 1000));
  return days <= 1 ? 'Expires within a day' : `Expires in ${days} days`;
}

/** The QR code of a link, as SVG markup and a PNG to save. */
function useQr(url: string | null) {
  const [svg, setSvg] = useState('');
  const [png, setPng] = useState('');
  useEffect(() => {
    if (!url) {
      setSvg('');
      setPng('');
      return;
    }
    let current = true;
    const options = { margin: 1, errorCorrectionLevel: 'M' as const, color: { dark: '#000000', light: '#ffffff' } };
    QRCode.toString(url, { ...options, type: 'svg' }).then(
      (markup) => {
        if (current) setSvg(markup);
      },
      () => {}
    );
    QRCode.toDataURL(url, { ...options, width: 512 }).then(
      (data) => {
        if (current) setPng(data);
      },
      () => {}
    );
    return () => {
      current = false;
    };
  }, [url]);
  return { svg, png };
}

/**
 * Share (model menu → Share…, a collection's Share button): read-only links that open without
 * logging in, with a QR code to scan or print. Editors and admins.
 */
export function ShareDialog() {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [name, setName] = useState('');
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [allowDownload, setAllowDownload] = useState(true);
  const [expires, setExpires] = useState(0);
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const shownUrl = created ? shareLinks.url(created.token) : null;
  const qr = useQr(shownUrl);

  async function reload(next: ShareTarget) {
    try {
      setLinks(await shareLinks.list(next));
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  useEffect(() => {
    const show = (next: ShareTarget, label?: string) => {
      setTarget(next);
      setName(label || (next.filePath ? fileLabel(next.filePath) : 'Collection'));
      setCreated(null);
      setStatus('');
      setLinks(null);
      setOpen(true);
      void reload(next);
    };
    const offGlobal = exposeGlobal('openShare', show);
    const offEvent = onServerEvent('open-share-dialog', (next: ShareTarget) => {
      if (next) show(next);
    });
    return () => {
      offGlobal();
      offEvent();
    };
  }, []);

  async function create() {
    if (!target) return;
    setBusy(true);
    setStatus('');
    try {
      const link = await shareLinks.create(target, { allowDownload, expiresInDays: expires });
      setCreated(link);
      await reload(target);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    if (await copyText(url)) setStatus('Link copied.');
    else {
      urlRef.current?.select();
      setStatus('Select the link and copy it.');
    }
  }

  async function revoke(link: ShareLink) {
    const answer = await showMessage('Turn Off Link', 'Turn off this link? Anyone who has it can no longer open it.', ['Turn Off', 'Cancel']);
    if (answer !== 'Turn Off' || !target) return;
    try {
      await shareLinks.revoke(link.token);
      if (created?.token === link.token) setCreated(null);
      setStatus('The link is off.');
      await reload(target);
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={`Share ${name}`}
      className="jp-share"
      footer={<Button onClick={() => setOpen(false)}>Close</Button>}
    >
      <p className="jp-meta jp-share__intro">
        Anyone with the link can see {target?.kind === 'collection' ? 'the models in this collection (also ones added later)' : 'this model'}: names, pictures,
        designer, license, tags and source. Notes and file locations are never shown. No login is needed.
      </p>

      {created && shownUrl ? (
        <div className="jp-share__created">
          <div className="jp-share__qr" role="img" aria-label="QR code of the link" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <div className="jp-share__link">
            <label className="jp-label" htmlFor="jp-share-url">
              Link
            </label>
            <input id="jp-share-url" ref={urlRef} className="jp-input" readOnly value={shownUrl} onFocus={(event) => event.target.select()} />
            <div className="jp-share__buttons">
              <Button variant="primary" icon={Copy} id="jp-share-copy" onClick={() => copy(shownUrl)}>
                Copy Link
              </Button>
              {qr.png && (
                <a className="jp-btn jp-btn--secondary jp-btn--md" href={qr.png} download={`${name.replace(/[^\w.-]+/g, '_')}-qr.png`}>
                  <Download size={16} aria-hidden="true" />
                  <span>Save QR Code</span>
                </a>
              )}
            </div>
            <p className="jp-meta">
              {created.allowDownload ? 'Downloads allowed' : 'View only'} · {expiryLabel(created)}
            </p>
          </div>
        </div>
      ) : (
        <div className="jp-share__form">
          <label className="jp-share__check">
            <input type="checkbox" id="jp-share-download" checked={allowDownload} onChange={(event) => setAllowDownload(event.target.checked)} />
            <span>Allow downloading the files</span>
          </label>
          <label className="jp-share__expiry">
            <span className="jp-label">Link expires</span>
            <select id="jp-share-expires" className="jp-input" value={expires} onChange={(event) => setExpires(Number(event.target.value))}>
              {EXPIRY.map(([days, label]) => (
                <option key={days} value={days}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button variant="primary" icon={Link2} id="jp-share-create" disabled={busy} onClick={create}>
            Create Link
          </Button>
        </div>
      )}
      <p className="jp-share__status" role="status" id="jp-share-status">
        {status}
      </p>

      <h3 className="jp-share__heading">Links to {target?.kind === 'collection' ? 'this collection' : 'this model'}</h3>
      {links === null ? (
        <p className="jp-meta">Loading…</p>
      ) : links.length === 0 ? (
        <p className="jp-meta">None yet.</p>
      ) : (
        <ul className="jp-share__list" id="jp-share-links">
          {links.map((link) => (
            <li key={link.token} className={link.expired ? 'is-expired' : undefined}>
              <span className="jp-share__list-text">
                <span className="jp-share__list-url">{shareLinks.url(link.token)}</span>
                <span className="jp-meta">
                  {link.allowDownload ? 'Downloads' : 'View only'} · {expiryLabel(link)} · {link.views} {link.views === 1 ? 'view' : 'views'}
                  {link.createdBy ? ` · by ${link.createdBy}` : ''} · {timeAgo(link.createdAt)}
                </span>
              </span>
              {!link.expired && <IconButton icon={Copy} size="sm" label="Copy this link" onClick={() => copy(shareLinks.url(link.token))} />}
              <IconButton icon={Trash2} size="sm" label="Turn off this link" onClick={() => revoke(link)} />
            </li>
          ))}
        </ul>
      )}
      {created && (
        <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
          Create Another Link
        </Button>
      )}
    </Modal>
  );
}
