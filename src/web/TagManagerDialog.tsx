import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { tags as tagApi, type Tag } from './api';
import { Plus, Undo2 } from 'lucide-react';
import { Button } from './components/Button';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, refreshAfterTagManagerClose } from './page';
import { createTag, deleteTag, renameTag } from './tags/manage';
import { lastUndoId, onUndoChange, undoLast, type UndoEntry } from './library/undo';

declare global {
  interface Window {
    openTagManager?: () => void;
    /** Reload the list if the Tag Manager is open (tags created elsewhere on the page). */
    reloadTagManager?: () => void;
  }
}

/**
 * Settings → Tag Manager: create tags, rename them inline (renaming onto an existing name merges),
 * and delete them. Registers window.openTagManager.
 */
export function TagManagerDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const changed = useRef(false);
  // The newest tag change made while the dialog is open, to undo here (the page's notice is behind the dialog).
  const [lastChange, setLastChange] = useState<UndoEntry | null>(null);
  // An undo still refreshing the page: the next one waits for it (undoLast ignores clicks meanwhile).
  const [undoing, setUndoing] = useState(false);
  const openedAt = useRef(0);

  useEffect(
    () =>
      onUndoChange((latest) => {
        setLastChange(latest && latest.kind === 'tag' && latest.id > openedAt.current ? latest : null);
      }),
    []
  );

  async function load() {
    try {
      setAllTags(await tagApi.list());
    } catch (error) {
      console.error('Error loading tags:', error);
    }
  }

  /** After a change (tags/manage.ts already refreshed the pickers and filters): reload the list. */
  async function afterChange() {
    changed.current = true;
    await load();
  }

  useEffect(() => {
    const cleanups = [
      exposeGlobal('openTagManager', () => {
        changed.current = false;
        openedAt.current = lastUndoId();
        setLastChange(null);
        setSearch('');
        setNewName('');
        setAllTags([]);
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
        void load();
      }),
      exposeGlobal('reloadTagManager', () => {
        if (dialogRef.current?.open) void load();
      })
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  async function addTag() {
    if (await createTag(newName)) {
      setNewName('');
      await afterChange();
    }
  }

  async function removeTag(tag: Tag): Promise<boolean> {
    const done = await deleteTag(tag);
    if (done) await afterChange();
    return done;
  }

  async function rename(tag: Tag, name: string): Promise<boolean> {
    const done = await renameTag(allTags, tag, name);
    if (done) await afterChange();
    return done;
  }

  const term = search.trim().toLowerCase();
  const shown = allTags.filter((tag) => !term || tag.name.toLowerCase().includes(term)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <ModalDialog
      id="tag-manager-dialog"
      title="Tag Manager"
      dialogRef={dialogRef}
      fullscreenToggle
      plain
      className="jp-mgr"
      headerClassName="jp-mgr__header"
      headerRowClassName="jp-mgr__header-row"
      footerClassName="jp-mgr__footer dialog-buttons"
      description={<p className="jp-meta">Create, rename, merge and delete tags. Renaming a tag to an existing name merges the two.</p>}
      footer={
        <Button id="tag-manager-close" onClick={() => dialogRef.current?.close()}>
          Close
        </Button>
      }
      onClose={() => {
        if (changed.current) void refreshAfterTagManagerClose();
      }}
    >
      <div className="jp-mgr__body">
        <section className="jp-mgr__section">
          <label className="jp-label" htmlFor="new-tag-manager-name">
            New tag
          </label>
          <div className="jp-mgr__inline">
            <input
              type="text"
              id="new-tag-manager-name"
              className="jp-input"
              placeholder="Tag name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addTag();
                }
              }}
            />
            <Button id="add-tag-manager-button" variant="primary" icon={Plus} title="Create tag" onClick={addTag}>
              Add Tag
            </Button>
          </div>
          {lastChange && (
            <div className="tag-manager-undo" role="status">
              <span>{lastChange.label}</span>
              <Button
                size="sm"
                id="tag-manager-undo"
                icon={Undo2}
                disabled={undoing}
                onClick={async () => {
                  setUndoing(true);
                  try {
                    const label = await undoLast(lastChange.id);
                    if (label) {
                      changed.current = true;
                      await load();
                    }
                  } finally {
                    setUndoing(false);
                  }
                }}
              >
                Undo
              </Button>
            </div>
          )}
        </section>
        <section className="jp-mgr__section jp-mgr__section--grow">
          <div className="jp-mgr__toolbar">
            <div className="input-with-icon jp-mgr__search">
              <input
                type="text"
                id="tag-manager-search"
                className="jp-input"
                placeholder="Search tags"
                aria-label="Search tags"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" id="clear-tag-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>
                ×
              </button>
            </div>
            <span className="jp-meta">{`${shown.length} tag${shown.length === 1 ? '' : 's'}`}</span>
          </div>
          <p className="jp-meta jp-mgr__hint">Click a tag to rename it. Clear its name and press Enter to delete it.</p>
          <div id="tag-manager-list" className="jp-mgr__chips">
            {shown.length === 0 ? (
              <p className="jp-meta">{search.trim() ? 'No tags match the search.' : 'No tags yet.'}</p>
            ) : (
              shown.map((tag) => <TagChip key={tag.id} tag={tag} onRename={(name) => rename(tag, name)} onDelete={() => removeTag(tag)} />)
            )}
          </div>
        </section>
      </div>
    </ModalDialog>
  );
}

function TagChip({ tag, onRename, onDelete }: { tag: Tag; onRename: (name: string) => Promise<boolean>; onDelete: () => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);
  // Enter and the blur that follows must not commit twice.
  const committing = useRef(false);

  function startEditing() {
    if (editing) return;
    setDraft(tag.name);
    setEditing(true);
  }

  async function commit() {
    if (committing.current) return;
    const name = draft.trim();
    if (name === tag.name) {
      setEditing(false);
      return;
    }
    committing.current = true;
    const done = await onRename(name);
    committing.current = false;
    // On success the list reloads; otherwise show the old name again.
    if (!done) setEditing(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void commit();
    } else if (event.key === 'Escape') {
      // Leave the dialog open; only stop editing.
      event.preventDefault();
      event.stopPropagation();
      committing.current = true;
      setEditing(false);
      queueMicrotask(() => {
        committing.current = false;
      });
    }
  }

  return (
    <div className="tag jp-mgr__chip" data-tag-id={tag.id} data-tag-name={tag.name} title={`${tag.name} — click to rename`} onClick={startEditing}>
      {editing ? (
        <input
          type="text"
          className="tag-edit-input jp-input"
          aria-label={`Rename tag ${tag.name}`}
          spellCheck={false}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(event) => event.target.select()}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => void commit()}
        />
      ) : (
        <span className="tag-text">{tag.name}</span>
      )}
      <span className="tag-count jp-mgr__chip-count">{tag.model_count}</span>
      <span
        className="tag-remove jp-mgr__chip-remove"
        title="Delete tag"
        aria-label={`Delete tag ${tag.name}`}
        role="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onDelete();
        }}
      >
        ×
      </span>
    </div>
  );
}
