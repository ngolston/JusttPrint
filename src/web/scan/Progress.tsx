import { useState } from 'react';
import { createPortal } from 'react-dom';
import { jobActions, useThumbnailJob, type Job } from '../thumbnails/jobs';
import { useScanProgress } from './scan';

const percentOf = (job: Job) => (job.total > 0 ? Math.min(100, Math.floor((job.processed / job.total) * 100)) : 0);

/** The sidebar's progress: the running scan, and a thumbnail job sent to the background. */
export function SidebarProgress() {
  const [slot] = useState(() => document.getElementById('sidebar-progress-slot'));
  const scan = useScanProgress();
  const job = useThumbnailJob();
  const background = job && job.background && !job.done ? job : null;
  if (!slot || (!scan && !background)) return null;
  const jobText = background && (background.stopping ? 'Stopping...' : background.total > 0
    ? `${background.title}: ${background.processed}/${background.total} (${percentOf(background)}%)`
    : background.phase || `${background.title}: running in the background...`);
  return createPortal(
    <div className="progress-section" id="progress-section">
      {scan && (
        <div className="progress-container" id="scan-progress-container">
          <div className="progress-bar" id="scan-progress-bar" style={{ width: `${scan.percent ?? 100}%` }} />
          <div className="progress-text" id="scan-progress-text">{scan.text}</div>
        </div>
      )}
      {background && (
        <div className="progress-container" id="render-progress-container">
          <div className="progress-bar" id="render-progress-bar" style={{ width: `${percentOf(background)}%` }} />
          <div className="progress-text" id="render-progress-text">{jobText}</div>
        </div>
      )}
      {background && (
        <button id="stop-thumbnail-generation" className="stop-button" disabled={background.stopping} onClick={jobActions.stop}>Stop Processing</button>
      )}
      <div className="performance-notice">{scan ? 'Scanning may impact performance.' : 'Thumbnails are rendered on the JusttPrint backend.'}</div>
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
        <h3 className="tp-title" id="thumbnail-progress-title">{job.title}</h3>
        <p className="tp-phase" id="thumbnail-progress-phase">{job.phase}</p>
        <div className={`tp-track${counted || job.done ? '' : ' tp-indeterminate'}`} id="thumbnail-progress-track">
          <div className="tp-fill" id="thumbnail-progress-fill" style={counted ? { width: `${percent}%` } : undefined} />
        </div>
        <div className="tp-meta">
          <span id="thumbnail-progress-count">{counted ? `${Math.min(job.processed, job.total)} / ${job.total}` : ''}</span>
          <span id="thumbnail-progress-percent">{counted ? `${percent}%` : ''}</span>
        </div>
        {!job.done && (
          <div className="tp-actions">
            <button type="button" className="tp-background" id="thumbnail-progress-background" disabled={job.stopping}
              onClick={jobActions.background}>Background</button>
            <button type="button" className="tp-cancel" id="thumbnail-progress-cancel" disabled={job.stopping}
              onClick={jobActions.stop}>{job.stopping ? 'Stopping...' : 'Stop'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
