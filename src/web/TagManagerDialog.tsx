import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { tags as tagApi, type Tag } from './api';
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
      onClose={() => {
        if (changed.current) void refreshAfterTagManagerClose();
      }}
    >
      <div className="form-group">
        <label htmlFor="new-tag-manager-name">Create New Tag</label>
        <div className="input-with-icon">
          <input
            type="text"
            id="new-tag-manager-name"
            placeholder="Enter tag name..."
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void addTag();
              }
            }}
          />
          <button type="button" id="add-tag-manager-button" className="icon-button" title="Create tag" onClick={addTag}>
            +
          </button>
        </div>
      </div>
      {lastChange && (
        <div className="tag-manager-undo" role="status">
          <span>{lastChange.label}</span>
          <button
            type="button"
            className="btn btn-secondary"
            id="tag-manager-undo"
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
          </button>
        </div>
      )}
      <div className="form-group tag-manager-existing-group">
        <label htmlFor="tag-manager-search">Existing Tags</label>
        <p className="tag-manager-hint">Click a tag to rename it. Clear the name and press Enter to delete.</p>
        <div className="input-with-icon">
          <input type="text" id="tag-manager-search" placeholder="Search tags..." value={search} onChange={(event) => setSearch(event.target.value)} />
          <button type="button" id="clear-tag-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>
            ×
          </button>
        </div>
        <div id="tag-manager-list" className="tags-list">
          {shown.map((tag) => (
            <TagChip key={tag.id} tag={tag} onRename={(name) => rename(tag, name)} onDelete={() => removeTag(tag)} />
          ))}
        </div>
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
    <div className="tag" data-tag-id={tag.id} data-tag-name={tag.name} title={`${tag.name} — click to rename`} onClick={startEditing}>
      {editing ? (
        <input
          type="text"
          className="tag-edit-input"
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
      <span className="tag-count">{tag.model_count}</span>
      <span
        className="tag-remove"
        title="Delete tag"
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
