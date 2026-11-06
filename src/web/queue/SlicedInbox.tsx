import { useCallback, useEffect, useState } from 'react';
import { FileBox, FolderInput, RefreshCw, Search } from 'lucide-react';
import { slicedInbox, type InboxItem, type InboxStatus, type ModelChoice } from '../api';
import { Button } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { timeAgo } from '../home/format';
import { onServerEvent, showMessage } from '../page';
import { useCan } from '../session';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Choose the model for a waiting file: the closest ones, or any found by name. */
function ChooseModel({ item, onFiled }: { item: InboxItem; onFiled: () => void }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<ModelChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (text.trim().length < 2) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      slicedInbox.findModels(text).then(
        (list) => live && setFound(list),
        () => live && setFound([])
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  async function file(model: ModelChoice) {
    setBusy(true);
    try {
      const done = await slicedInbox.file(item.id, model.filePath);
      onFiled();
      await showMessage('Filed', `${item.fileName} is beside ${done.model.name}${done.queued ? ', and it is in the queue' : ''}.`);
    } catch (error) {
      await showMessage('Sliced files inbox', errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function ignore() {
    setBusy(true);
    try {
      await slicedInbox.ignore(item.id);
      onFiled();
    } catch (error) {
      await showMessage('Sliced files inbox', errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const choices = found ?? item.suggestions;
  return (
    <div className="jp-inbox__choose">
      <label className="jp-inbox__search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          className="jp-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Find the model by name"
          aria-label={`Find the model for ${item.fileName}`}
        />
      </label>
      {choices.length > 0 ? (
        <ul className="jp-inbox__choices" aria-label={`Models for ${item.fileName}`}>
          {choices.map((model) => (
            <li key={model.filePath}>
              <button type="button" className="jp-btn jp-btn--secondary jp-btn--sm" disabled={busy} onClick={() => void file(model)} title={model.filePath}>
                File under {model.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        found && <p className="jp-meta">No model has that in its name.</p>
      )}
      <button type="button" className="jp-link" disabled={busy} onClick={() => void ignore()}>
        Ignore it
      </button>
    </div>
  );
}

/** The folder setting (admins). */
function FolderForm({ folder, onSaved, onCancel }: { folder: string; onSaved: () => void; onCancel?: () => void }) {
  const [value, setValue] = useState(folder);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(next: string) {
    setBusy(true);
    setError(null);
    try {
      await slicedInbox.setFolder(next);
      onSaved();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="jp-inbox__folder-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(value);
      }}
    >
      <label className="jp-send__field">
        <span>Inbox folder (on the server)</span>
        <input
          id="jp-inbox-folder"
          className="jp-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="/mnt/sliced"
          spellCheck={false}
        />
      </label>
      <div className="jp-inbox__folder-actions">
        <Button type="submit" variant="primary" size="sm" disabled={busy || !value.trim()}>
          Save
        </Button>
        {folder && (
          <Button size="sm" disabled={busy} onClick={() => void save('')}>
            Turn Off
          </Button>
        )}
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p className="jp-send__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The Print Queue page's sliced-files inbox: OrcaSlicer exports sliced projects to a folder, and
 * each one is filed beside its model and queued (src/server/sliced-inbox.js). Files no model
 * matches wait here for someone to choose.
 */
export function SlicedInbox() {
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const admin = useCan('admin');
  const load = useCallback(() => {
    slicedInbox.status().then(setStatus, () => setStatus(null));
  }, []);
  useEffect(() => {
    load();
    const offInbox = onServerEvent('sliced-inbox-changed', load);
    const offModels = onServerEvent('models-changed', load);
    return () => {
      offInbox();
      offModels();
    };
  }, [load]);
  if (!status) return null;

  const waiting = status.items.filter((item) => item.status === 'waiting');
  const filed = status.items.filter((item) => item.status === 'filed').slice(0, 5);

  async function checkNow() {
    setChecking(true);
    try {
      const done = await slicedInbox.check();
      load();
      if (!done.filed && !done.waiting) await showMessage('Sliced files inbox', 'Nothing new in the inbox folder.');
    } catch (error) {
      await showMessage('Sliced files inbox', errorText(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="jp-card jp-queue__section jp-inbox" aria-labelledby="jp-queue-inbox">
      <header className="jp-card__header">
        <h2 className="jp-panel-title" id="jp-queue-inbox">
          Sliced files inbox
          {waiting.length ? <span className="jp-queue__count">{waiting.length}</span> : null}
        </h2>
        {status.folder && !editing && (
          <span className="jp-inbox__header-actions">
            <EditOnly>
              <Button size="sm" icon={RefreshCw} disabled={checking} onClick={() => void checkNow()}>
                Check Now
              </Button>
            </EditOnly>
            {admin && (
              <Button size="sm" icon={FolderInput} onClick={() => setEditing(true)}>
                Change Folder
              </Button>
            )}
          </span>
        )}
      </header>
      {!status.folder || editing ? (
        <div className="jp-inbox__setup">
          <p className="jp-meta">
            Export sliced files from OrcaSlicer (Export plate sliced file) into one folder, and JusttPrint files each one beside its model and adds the model to
            the queue, ready to Send. It matches them by name, so keep the project named like the model.
          </p>
          {admin ? (
            <FolderForm
              folder={status.folder}
              onSaved={() => {
                setEditing(false);
                load();
              }}
              onCancel={status.folder ? () => setEditing(false) : undefined}
            />
          ) : (
            <p className="jp-meta">An admin chooses the folder here.</p>
          )}
        </div>
      ) : (
        <>
          <p className="jp-meta">
            Sliced files exported to <code>{status.folder}</code> are filed beside their models and queued.
          </p>
          {status.error && (
            <p className="jp-send__error" role="alert">
              {status.error}
            </p>
          )}
          {waiting.length > 0 && (
            <ul className="jp-inbox__list" aria-label="Waiting for a model">
              {waiting.map((item) => (
                <li key={item.id} className="jp-inbox__item">
                  <div className="jp-inbox__file">
                    <FileBox size={16} aria-hidden="true" />
                    <strong>{item.fileName}</strong>
                    <span className="jp-meta">{item.message}</span>
                  </div>
                  <EditOnly>
                    <ChooseModel item={item} onFiled={load} />
                  </EditOnly>
                </li>
              ))}
            </ul>
          )}
          {filed.length > 0 && (
            <ul className="jp-inbox__filed" aria-label="Filed lately">
              {filed.map((item) => (
                <li key={item.id}>
                  <span>{item.fileName}</span>
                  <span className="jp-meta">
                    {['beside ' + (item.model?.name || 'its model'), item.queued ? 'queued' : item.message, timeAgo(item.at)].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!waiting.length && !filed.length && <p className="jp-meta">Nothing has come in yet.</p>}
        </>
      )}
    </section>
  );
}
