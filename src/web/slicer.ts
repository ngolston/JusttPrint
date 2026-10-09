/**
 * Send to Slicer from the page: the configured slicers, and sending files to one. The server
 * answers with a command that the helper on this computer runs (window.electron.launchSlicerCommand,
 * server-bridge.js). Used by the 3D preview and the details panel's Open in Slicer.
 */
import { showMessage } from './page';

export interface Slicer {
  id: number | null;
  name: string;
  path: string;
}

interface SlicerBridge {
  getSlicers?: () => Promise<unknown>;
  getSetting?: (key: string) => Promise<string | null>;
  openFileInSlicer?: (options: { filePaths: string[]; slicerId: number | null; slicerName: string }) => Promise<{ command?: unknown } | null>;
  launchSlicerCommand?: (command: unknown) => void;
}

const bridge = () => window.electron as (SlicerBridge & typeof window.electron) | undefined;

/** The configured slicers (or the single slicer path of older versions). */
export async function loadSlicers(): Promise<Slicer[]> {
  let list: unknown = [];
  try {
    list = (await bridge()?.getSlicers?.()) || [];
  } catch (error) {
    console.error('Error loading slicers:', error);
  }
  if (Array.isArray(list) && list.length === 1 && Array.isArray(list[0])) list = list[0];
  const slicers = (Array.isArray(list) ? list : []).filter((s): s is Slicer => !!s && !!s.name && !!s.path);
  if (slicers.length) return slicers;
  try {
    const legacyPath = await bridge()?.getSetting?.('slicerPath');
    if (legacyPath) return [{ id: null, name: 'Slicer', path: legacyPath }];
  } catch {
    /* none */
  }
  return [];
}

export async function sendToSlicer(filePaths: string[], slicer: Slicer) {
  const b = bridge();
  if (!b?.openFileInSlicer || !b.launchSlicerCommand) {
    await showMessage('Send to Slicer', 'Send to slicer is not available in this mode.');
    return;
  }
  try {
    const result = await b.openFileInSlicer({ filePaths, slicerId: slicer.id, slicerName: slicer.name });
    if (result?.command) b.launchSlicerCommand(result.command);
  } catch (error) {
    await showMessage('Send to Slicer', `Could not send to slicer:\n${(error as Error)?.message || error}`);
  }
}

/** No slicer is set up yet: offer Slicer Settings. */
export async function offerSlicerSettings() {
  const answer = await showMessage('Send to Slicer', 'No slicer configured. Open Slicer Settings now?', ['Open Slicer Settings', 'Cancel']);
  if (answer === 'Open Slicer Settings') window.openSlicerSettings?.();
}
