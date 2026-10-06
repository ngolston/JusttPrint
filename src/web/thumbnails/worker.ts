/**
 * The bulk thumbnail job, run by the server's headless thumbnail worker (this page opened at
 * /?pv-thumbnail-worker=1). One model at a time; progress goes to the server, which passes it
 * to every open page (jobs.ts).
 */
import { callAction, settings } from '../api';
import { isFailurePlaceholder } from './formats';
import { handlePageEvent, type JobMode } from './jobs';
import { makeThumbnail } from './pipeline';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let busy = false;
let cancelled = false;

/** Make and save one model's thumbnail. Failures save '3d.png', so the model is tried again later. */
async function generate(filePath: string, maxRenderBytes: number) {
  try {
    const { image, stored } = await makeThumbnail(filePath, { maxRenderBytes });
    if (stored) return;
    const keep = !!image && image.startsWith('data:image') && !isFailurePlaceholder(image);
    await callAction('save-thumbnail', filePath, keep ? image : '3d.png');
  } catch (error) {
    console.error(`Failed to generate thumbnail for ${filePath}:`, error);
    await callAction('save-thumbnail', filePath, '3d.png').catch(() => {});
  }
}

async function runJob(mode: JobMode) {
  if (busy) return console.warn('[Server thumbnails] Ignoring job; worker already busy');
  busy = true;
  cancelled = false;
  const report = (progress: object) => callAction('report-server-thumbnail-progress', { mode, ...progress }).catch(() => {});
  try {
    const models = await callAction<{ filePath?: string }[]>(mode === 'missing' ? 'get-models-without-thumbnails' : 'get-all-model-references');
    const paths = [...new Set((models || []).map((m) => m.filePath).filter((p): p is string => !!p))];
    const total = paths.length;
    await report({ phase: total ? `Generating thumbnails for ${total} model${total === 1 ? '' : 's'}...` : 'Nothing to generate', processed: 0, total });
    const maxMb = parseInt(String(await settings.get<string | null>('maxFileSizeMB').catch(() => null)), 10) || 50;
    let processed = 0;
    for (const filePath of paths) {
      if (cancelled) break;
      await generate(filePath, maxMb * 1024 * 1024);
      processed++;
      await report({ processed, total, phase: `Processing ${processed}/${total}` });
      // Give the GPU a breath, and a fresh WebGL context now and then.
      await pause(25);
      if (processed % 15 === 0) {
        await window.thumbnailRenderer?.reset();
        await pause(50);
      }
    }
    if (!cancelled && total) await report({ processed: total, total, phase: 'Finished.' });
    await callAction('report-server-thumbnail-complete', { cancelled, mode, count: total });
  } catch (error) {
    console.error('[Server thumbnails] Worker job failed:', error);
    await callAction('report-server-thumbnail-error', { message: error instanceof Error ? error.message : String(error) }).catch(() => {});
  } finally {
    busy = false;
    cancelled = false;
  }
}

if (new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1') {
  handlePageEvent('run-server-thumbnail-job', (payload?: { mode?: JobMode }) => { runJob(payload?.mode === 'all' ? 'all' : 'missing'); });
  handlePageEvent('cancel-server-thumbnail-job', () => { cancelled = true; });
}
