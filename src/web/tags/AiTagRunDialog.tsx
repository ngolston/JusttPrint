/**
 * AI Tagging (the sidebar's Tools): tag models with the AI service now. Choose which models (those
 * without tags, those the Library shows, or the chosen ones) and start; the run then shows in the
 * sidebar and its tags open for review, as Generate Tags in a model's menu does (that same menu
 * action runs it). Without an AI service set up, the AI settings open instead.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Settings, Sparkles } from 'lucide-react';
import { callAction, categories as categoryApi } from '../api';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';
import { currentToken, subscribe as subscribePuter } from '../ai/puterAuth';
import type { ContextMenuData } from '../menus/ContextMenu';
import { exposeGlobal, showMessage } from '../page';
import { selection } from '../selection';

declare global {
  interface Window {
    openAiTagging?: () => void;
  }
}

type Target = 'untagged' | 'shown' | 'chosen';

const paths = (models: unknown) =>
  ((Array.isArray(models) ? models : []) as { filePath?: unknown }[])
    .map((model) => (typeof model?.filePath === 'string' ? model.filePath : ''))
    .filter((filePath) => filePath && !filePath.startsWith('url::'));

/** Run Generate Tags (the model menu's action, src/server/ipc/context-menu.js) on these models. */
export async function generateTags(filePaths: string[]): Promise<boolean> {
  const menu = await callAction<ContextMenuData | null>('show-context-menu', filePaths);
  const index = menu?.items.findIndex((item) => item.label === 'Generate Tags') ?? -1;
  if (!menu || index < 0) return false;
  await callAction('execute-context-menu-action', menu.requestId, index, null);
  return true;
}

const count = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'model' : 'models'}`;

export function AiTagRunDialog() {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<Record<Target, string[]> | null>(null);
  const [target, setTarget] = useState<Target>('untagged');
  const [starting, setStarting] = useState(false);
  const puterSignedIn = useSyncExternalStore(subscribePuter, () => !!currentToken());
  const [service, setService] = useState('');

  useEffect(
    () =>
      exposeGlobal('openAiTagging', async () => {
        const scan = await categoryApi.scan().catch(() => null);
        // No AI service yet: set it up first.
        if (!scan?.aiReady) {
          window.openAiConfig?.();
          return;
        }
        setService(scan.aiService || '');
        setLists(null);
        setOpen(true);
        const [untagged, shown] = await Promise.all([
          callAction<unknown>('get-models-filtered', { tags: ['__none__'], tagCombine: 'OR' }).catch(() => []),
          window.getCombinedFilteredModels?.().catch(() => []) ?? Promise.resolve([])
        ]);
        const next = { untagged: paths(untagged), shown: paths(shown), chosen: paths(selection.values().map((filePath) => ({ filePath }))) };
        setLists(next);
        setTarget(next.chosen.length > 1 ? 'chosen' : next.untagged.length ? 'untagged' : 'shown');
      }),
    []
  );

  const puterMissing = service === 'puter' && !puterSignedIn;
  const chosen = lists?.[target] || [];

  async function start() {
    if (!chosen.length) return;
    setStarting(true);
    try {
      if (!(await generateTags(chosen))) {
        await showMessage('AI Tagging', 'AI Tagging is not available for these models. Check the AI service in Settings → AI.');
        return;
      }
      setOpen(false);
    } catch (error) {
      await showMessage('AI Tagging', error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  const option = (id: Target, label: string, hint: string) => {
    const n = lists?.[id].length ?? 0;
    return (
      <label className={`jp-ai-run__option${n ? '' : ' is-empty'}`}>
        <input type="radio" name="jp-ai-run-target" id={`jp-ai-run-${id}`} checked={target === id} disabled={!lists || !n} onChange={() => setTarget(id)} />
        <span className="jp-ai-run__text">
          <span className="jp-ai-run__label">{label}</span>
          <span className="jp-meta">{hint}</span>
        </span>
        <span className="jp-ai-run__count">{lists ? count(n) : '…'}</span>
      </label>
    );
  };

  return (
    <Modal
      id="jp-ai-run-dialog"
      open={open}
      onClose={() => setOpen(false)}
      className="jp-ai-run"
      title="AI Tagging"
      footer={
        <>
          <Button
            icon={Settings}
            variant="ghost"
            className="jp-ai-run__settings"
            onClick={() => {
              setOpen(false);
              window.openAiConfig?.();
            }}
          >
            AI settings
          </Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" icon={Sparkles} id="jp-ai-run-start" disabled={!chosen.length || starting || puterMissing} onClick={() => void start()}>
            {chosen.length ? `Tag ${count(chosen.length)}` : 'Tag'}
          </Button>
        </>
      }
    >
      <p className="jp-meta jp-ai-run__intro">
        The AI looks at each model's picture and suggests tags (and its Category). You review the tags before they are added.
      </p>
      <div className="jp-ai-run__options" role="radiogroup" aria-label="Which models">
        {option('untagged', 'Models without tags', 'The usual choice.')}
        {option('shown', 'The models the Library shows', 'With its tabs and filters.')}
        {option('chosen', 'The chosen models', 'Ticked in the Library.')}
      </div>
      {puterMissing && <p className="jp-ai-run__note">Sign in to Puter first (AI settings): the AI runs through your Puter account in this browser.</p>}
    </Modal>
  );
}
