import { useEffect, useRef, useState } from 'react';
import { callAction, models, settings } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { onServerEvent, refreshTagRelatedUi, showMessage } from '../page';
import {
  STRATEGY_HELP, canApply, emptyReview, finishBatch, mergeTags, pickedTags, rateLimitDetail, setTicked, tickKey, upsertEntry,
  type MergeStrategy, type Review, type ReviewEntry
} from './review';

interface ModelRecord {
  filePath: string;
  fileName?: string;
  thumbnail?: string | null;
  tags?: string[];
}

const PLACEHOLDER = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>';

/** The first stored image (data URL) of a model's thumbnail field, if any. */
function storedThumbnail(model: ModelRecord): string | null {
  const first = String(model.thumbnail || '').split('::').find((t) => t.startsWith('data:image'));
  return first || null;
}

function toEntry(filePath: string, model: ModelRecord | null, existing?: string[], over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    filePath,
    fileName: model?.fileName || filePath.split(/[/\\]/).pop() || filePath,
    thumbnail: model ? storedThumbnail(model) : null,
    existingTags: existing ?? model?.tags ?? [],
    ...over
  };
}

function Thumbnail({ entry }: { entry: ReviewEntry }) {
  const [src, setSrc] = useState(entry.thumbnail);
  // 3MF and similar files keep their images apart from the model record.
  useEffect(() => {
    if (src || !/\.(3mf|lys|f3d|chitubox|voxl)$/i.test(entry.filePath)) return;
    let current = true;
    callAction<string | null>('getThumbnail', entry.filePath).then((image) => { if (current && image?.startsWith('data:image')) setSrc(image); }, () => {});
    return () => { current = false; };
  }, [entry.filePath]);
  return (
    <div className="tag-review-thumb">
      {src ? <img src={src} alt="" onError={() => setSrc(null)} /> : <img className="is-placeholder" src={PLACEHOLDER} alt="" />}
    </div>
  );
}

/**
 * Review Generated Tags: AI tag suggestions arrive per model (server events from Generate Tags in
 * the model menu); tick the ones to keep and apply them with the merge strategy from AI Config.
 */
export function TagPreviewDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [strategy, setStrategy] = useState<MergeStrategy>('merge');
  const [applying, setApplying] = useState<{ done: number; total: number } | null>(null);
  /** Closed by the user: later events of the same run do not reopen it. */
  const closedRun = useRef(false);
  const rateLimitShown = useRef(false);

  useEffect(() => {
    const start = (next: Review) => {
      closedRun.current = false;
      rateLimitShown.current = false;
      setReview(next);
      settings.get<string | null>('aiTagMergeStrategy').then((s) => setStrategy((s as MergeStrategy) || 'merge'), () => {});
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    };
    const update = (change: (review: Review) => Review) => {
      if (closedRun.current) return;
      setReview((review) => (review ? change(review) : review));
    };
    const offs = [
      onServerEvent('start-single-tag-generation', (filePath: string, data: { model?: ModelRecord; existingTags?: string[] }) => {
        start(upsertEntry(emptyReview(false, 1, false), toEntry(filePath, data?.model || null, data?.existingTags)));
      }),
      onServerEvent('start-batch-tag-generation', async (count: number, filePaths: string[]) => {
        start(emptyReview(true, count, true));
        // List every model at once, each "Generating..." until its tags arrive.
        for (const filePath of [...new Set(filePaths || [])]) {
          const model = await models.get<ModelRecord>(filePath).catch(() => null);
          if (model) update((review) => upsertEntry(review, toEntry(filePath, model)));
        }
      }),
      onServerEvent('tags-generated', async (filePath: string, tags: string[] | null, error: string | null) => {
        if (closedRun.current) return;
        const model = await models.get<ModelRecord>(filePath).catch(() => null);
        if (!model) return;
        update((review) => upsertEntry(review, toEntry(filePath, model, undefined, { generatedTags: tags || [], error })));
        const detail = rateLimitDetail(error);
        if (detail && !rateLimitShown.current) {
          rateLimitShown.current = true;
          showMessage('Rate Limit Exceeded', detail);
        }
      }),
      onServerEvent('batch-tag-generation-complete', () => update(finishBatch))
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const close = () => dialogRef.current?.close();
  const picks = review ? pickedTags(review) : [];
  const ready = review ? canApply(review) : false;

  const apply = async () => {
    if (!review) return;
    if (!picks.length) {
      await showMessage('Info', 'No tags were selected to apply.');
      close();
      return;
    }
    let done = 0;
    let failed = 0;
    let applied = 0;
    setApplying({ done, total: picks.length });
    // Five at a time.
    for (let i = 0; i < picks.length; i += 5) {
      await Promise.all(picks.slice(i, i + 5).map(async ({ entry, tags }) => {
        try {
          const model = await models.get<ModelRecord>(entry.filePath);
          if (!model) throw new Error('Model not found');
          await callAction('save-model', { ...model, tags: mergeTags(entry.existingTags, tags, strategy) });
          applied += tags.length;
        } catch (error) {
          console.error(`Error applying tags to ${entry.filePath}:`, error);
          failed++;
        }
        done++;
        setApplying({ done, total: picks.length });
      }));
    }
    setApplying(null);
    const succeeded = picks.length - failed;
    if (succeeded > 0) {
      await refreshTagRelatedUi();
      await showMessage('Success', failed
        ? `Tags applied to ${succeeded} model(s) (${failed} failed). ${applied} tag(s) applied.`
        : `Tags applied successfully to ${succeeded} model(s)! ${applied} tag(s) applied.`);
    } else {
      await showMessage('Error', 'Failed to apply tags.');
    }
    close();
  };

  let title = 'Review Generated Tags';
  if (review && (review.entries.length > 1 || review.batch)) {
    const finished = review.entries.filter((e) => e.generatedTags !== undefined).length;
    const withTags = review.entries.filter((e) => e.generatedTags?.length).length;
    title += review.running
      ? ` (${finished}/${review.expected || review.entries.length} processed, ${withTags} with tags)`
      : ` (${review.entries.length} models, ${withTags} with tags)`;
  }
  const single = review && !review.batch && review.entries.length === 1 ? review.entries[0] : null;
  const rateLimited = review?.entries.map((e) => rateLimitDetail(e.error)).find(Boolean);

  return (
    <ModalDialog id="tag-preview-dialog" title={title} dialogRef={dialogRef}
      onClose={() => { closedRun.current = true; setReview(null); }}
      footer={(
        <>
          <button type="button" id="tag-preview-apply" disabled={!ready || !!applying} title={ready ? undefined : 'Please wait for tags to finish generating'}
            onClick={apply}>{applying ? `Applying ${applying.done} / ${applying.total}...` : 'Apply Selected Tags'}</button>
          <button type="button" id="tag-preview-cancel" disabled={!!applying} onClick={close}>Cancel</button>
        </>
      )}>
      {single && (
        <div id="tag-preview-model-info" className="tag-review-model-info">
          <div className="tag-review-label">Model:</div>
          <div id="tag-preview-model-name" className="tag-review-model-name">{single.fileName}</div>
          <div id="tag-preview-model-path" className="tag-review-model-path">{single.filePath}</div>
        </div>
      )}
      <p className="setting-description">
        Review and select which tags to apply to {single ? 'this model' : 'these models'}. Uncheck any tags you don't want to include.
      </p>
      <p id="tag-preview-status" className="setting-description" hidden={!rateLimited}>{rateLimited && `Rate limit exceeded: ${rateLimited}`}</p>
      <div id="tag-preview-container" className="tag-review-list">
        {review && !review.entries.length && <div className="tag-review-waiting">Generating tags for {review.expected} model(s)...</div>}
        {review?.entries.map((entry) => {
          const tags = entry.generatedTags || [];
          const keys = tags.map((tag) => tickKey(entry.filePath, tag));
          const limit = rateLimitDetail(entry.error);
          return (
            <div key={entry.filePath} className="tag-review-model" data-file-path={entry.filePath}>
              <div className="tag-review-model-header">
                <Thumbnail entry={entry} />
                <div className="tag-review-model-text">
                  <div className="tag-review-model-name">{entry.fileName}</div>
                  <div className="tag-review-model-path">{entry.filePath}</div>
                </div>
              </div>
              {entry.existingTags.length > 0 && (
                <div className="tag-review-existing">
                  <div className="tag-review-label">Existing tags ({entry.existingTags.length}):</div>
                  {entry.existingTags.map((tag) => <span key={tag} className="tag-review-chip">{tag}</span>)}
                </div>
              )}
              {tags.length > 0 ? (
                <>
                  <div className="tag-review-generated-label">Generated tags ({tags.length}):</div>
                  <div className="tag-review-tags">
                    {tags.map((tag, i) => (
                      <label key={tag} className="tag-review-tag">
                        <input type="checkbox" value={tag} data-file-path={entry.filePath} checked={!review.unticked.has(keys[i])}
                          onChange={(e) => setReview(setTicked(review, [keys[i]], e.target.checked))} />
                        <span>{tag}</span>
                      </label>
                    ))}
                  </div>
                  <div className="tag-review-bulk">
                    <button type="button" onClick={() => setReview(setTicked(review, keys, true))}>Select All</button>
                    <button type="button" onClick={() => setReview(setTicked(review, keys, false))}>Clear Selection</button>
                  </div>
                </>
              ) : (
                <div className={`tag-review-status${limit ? ' is-error' : ''}`}>
                  {entry.generatedTags === undefined ? 'Generating tags...' : limit ? `Rate limit exceeded: ${limit}` : entry.error || 'No tags generated for this model'}
                </div>
              )}
            </div>
          );
        })}
        {review && (
          <div id="tag-preview-merge-strategy" className="tag-review-strategy">
            <div>Merge Strategy: <span>{strategy}</span></div>
            <div>{STRATEGY_HELP[strategy] || STRATEGY_HELP.merge}</div>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
