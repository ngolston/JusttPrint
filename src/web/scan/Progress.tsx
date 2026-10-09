import { useState } from 'react';
import { createPortal } from 'react-dom';
import { jobActions, useThumbnailJob, type Job } from '../thumbnails/jobs';
import { useScanProgress } from './scan';
import { percentOf as aiPercent, progressText as aiText, stopAiTagJob, useAiTagJob } from '../tags/aiJob';
import { useCan, useCurrentUser } from '../session';

const percentOf = (job: Job) => (job.total > 0 ? Math.min(100, Math.floor((job.processed / job.total) * 100)) : 0);

/**
 * The sidebar's progress: the running scan, a thumbnail job sent to the background, and AI
 * tagging (anyone's while it runs; a finished run only for whoever started it, until reviewed).
 */
export function SidebarProgress() {
  const [slot] = useState(() => document.getElementById('sidebar-progress-slot'));
  const scan = useScanProgress();
  const job = useThumbnailJob();
  const ai = useAiTagJob();
  const me = useCurrentUser();
  const canEdit = useCan('editor');
  const background = job && job.background && !job.done ? job : null;
  const mine = !!ai.job && (!ai.job.by || ai.job.by === me?.username);
  const tagging = ai.job && (ai.job.running || (mine && !ai.reviewing)) ? ai.job : null;
  if (!slot || (!scan && !background && !tagging)) return null;
  const jobText =
    background &&
    (background.stopping
      ? 'Stopping...'
      : background.total > 0
        ? `${background.title}: ${background.processed}/${background.total} (${percentOf(background)}%)`
        : background.phase || `${background.title}: running in the background...`);
  return createPortal(
    <div className="progress-section" id="progress-section">
      {scan && (
        <div className="progress-container" id="scan-progress-container">
          <div className="progress-bar" id="scan-progress-bar" style={{ width: `${scan.percent ?? 100}%` }} />
          <div className="progress-text" id="scan-progress-text">
            {scan.text}
          </div>
        </div>
      )}
      {background && (
        <div className="progress-container" id="render-progress-container">
          <div className="progress-bar" id="render-progress-bar" style={{ width: `${percentOf(background)}%` }} />
          <div className="progress-text" id="render-progress-text">
            {jobText}
          </div>
        </div>
      )}
      {background && (
        <button id="stop-thumbnail-generation" className="stop-button" disabled={background.stopping} onClick={jobActions.stop}>
          Stop Processing
        </button>
      )}
      {tagging && (
        <div className="progress-container" id="ai-tag-progress-container">
          <div className="progress-bar" id="ai-tag-progress-bar" style={{ width: `${tagging.running ? aiPercent(tagging) : 100}%` }} />
          <div className="progress-text" id="ai-tag-progress-text">
            {aiText(tagging)}
            {!mine && tagging.by ? ` (${tagging.by})` : ''}
          </div>
        </div>
      )}
      {tagging && (mine || (canEdit && tagging.running)) && (
        <div className="progress-actions">
          {mine && !ai.reviewing && (
            <button type="button" id="ai-tag-review" className="jp-job-button" onClick={() => window.openAiTagReview?.()}>
              Review
            </button>
          )}
          {tagging.running && canEdit && (
            <button type="button" id="ai-tag-stop" className="stop-button" disabled={tagging.stopping} onClick={() => stopAiTagJob()}>
              Stop
            </button>
          )}
        </div>
      )}
      {(scan || background) && (
        <div className="performance-notice">{scan ? 'Scanning may impact performance.' : 'Thumbnails are rendered on the JusttPrint backend.'}</div>
      )}
    </div>,
    slot
  );
}

/** The dialog for a thumbnail job started here (until sent to the background). */
export function ThumbnailJobDialog() {
  const job = useThumbnailJob();
  if (!job || job.background) return null;
  const percent = percentOf(job);
  const counted = job.total > 0;
  return (
    <div id="thumbnail-progress-overlay" className="tp-overlay" role="dialog" aria-modal="true" aria-labelledby="thumbnail-progress-title">
      <div className="tp-panel">
        <h3 className="tp-title" id="thumbnail-progress-title">
          {job.title}
        </h3>
        <p className="tp-phase" id="thumbnail-progress-phase">
          {job.phase}
        </p>
        <div className={`tp-track${counted || job.done ? '' : ' tp-indeterminate'}`} id="thumbnail-progress-track">
          <div className="tp-fill" id="thumbnail-progress-fill" style={counted ? { width: `${percent}%` } : undefined} />
        </div>
        <div className="tp-meta">
          <span id="thumbnail-progress-count">{counted ? `${Math.min(job.processed, job.total)} / ${job.total}` : ''}</span>
          <span id="thumbnail-progress-percent">{counted ? `${percent}%` : ''}</span>
        </div>
        {!job.done && (
          <div className="tp-actions">
            <button type="button" className="tp-background" id="thumbnail-progress-background" disabled={job.stopping} onClick={jobActions.background}>
              Background
            </button>
            <button type="button" className="tp-cancel" id="thumbnail-progress-cancel" disabled={job.stopping} onClick={jobActions.stop}>
              {job.stopping ? 'Stopping...' : 'Stop'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
