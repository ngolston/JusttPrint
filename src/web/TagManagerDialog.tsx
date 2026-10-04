import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { tags as tagApi, type Tag } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, refreshAfterTagManagerClose, refreshTagRelatedUi, showMessage } from './page';

declare global {
  interface Window {
    openTagManager?: () => void;
    /** Reload the list if the Tag Manager is open (tags created elsewhere on the page). */
    reloadTagManager?: () => void;
  }
}

/** Asks before deleting a tag that models use. Resolves to true when it may go. */
async function confirmDelete(tag: Tag, message?: string): Promise<boolean> {
  if (tag.model_count === 0 && !message) return true;
  const text = message ?? `This tag is used by ${tag.model_count} model(s). Are you sure you want to delete it?`;
  return (await showMessage('Delete Tag', text, ['Yes', 'No'])) === 'Yes';
}

/**
 * Tools → Tag Manager: create tags, rename them inline (renaming onto an existing name merges),
 * and delete them. Registers window.openTagManager.
 */
export function TagManagerDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const changed = useRef(false);

  async function load() {
    try {
      setAllTags(await tagApi.list());
    } catch (error) {
      console.error('Error loading tags:', error);
    }
  }

  /** After a change: reload the list and the tag pickers and filters elsewhere on the page. */
  async function afterChange() {
    changed.current = true;
    await load();
    await refreshTagRelatedUi();
  }

  useEffect(() => {
    const cleanups = [
      exposeGlobal('openTagManager', () => {
        changed.current = false;
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

  async function createTag() {
    const name = newName.trim();
    if (!name) return;
    try {
      await tagApi.create(name);
      setNewName('');
      await afterChange();
    } catch (error) {
      console.error('Error saving tag:', error);
      await showMessage('Error', 'Failed to create tag');
    }
  }

  async function deleteTag(tag: Tag, message?: string): Promise<boolean> {
    if (!(await confirmDelete(tag, message))) return false;
    try {
      await tagApi.remove(tag.id);
      await afterChange();
      return true;
    } catch (error) {
      console.error('Error deleting tag:', error);
      await showMessage('Error', 'Failed to delete tag');
      return false;
    }
  }

  /** Rename, merge into an existing tag of that name, or delete when the name is cleared. */
  async function renameTag(tag: Tag, name: string): Promise<boolean> {
    if (!name) {
      const message = tag.model_count > 0
        ? `This tag is used by ${tag.model_count} model(s). Delete "${tag.name}"?`
        : `Delete the tag "${tag.name}"?`;
      return deleteTag(tag, message);
    }
    const existing = allTags.find((item) => item.id !== tag.id && item.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const answer = await showMessage(
        'Merge Tags',
        `A tag named "${existing.name}" already exists. Merge "${tag.name}" into "${existing.name}"? Models that had either tag will keep "${existing.name}".`,
        ['Merge', 'Cancel']
      );
      if (answer !== 'Merge') return false;
    }
    try {
      await tagApi.rename(tag.id, name);
      await afterChange();
      return true;
    } catch (error) {
      console.error('Error updating tag:', error);
      await showMessage('Error', 'Failed to update tag');
      return false;
    }
  }

  const term = search.trim().toLowerCase();
  const shown = allTags
    .filter((tag) => !term || tag.name.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <ModalDialog id="tag-manager-dialog" title="Tag Manager" dialogRef={dialogRef} fullscreenToggle
      onClose={() => { if (changed.current) void refreshAfterTagManagerClose(); }}>
      <div className="form-group">
        <label htmlFor="new-tag-manager-name">Create New Tag</label>
        <div className="input-with-icon">
          <input type="text" id="new-tag-manager-name" placeholder="Enter tag name..." value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void createTag(); } }} />
          <button type="button" id="add-tag-manager-button" className="icon-button" title="Create tag" onClick={createTag}>+</button>
        </div>
      </div>
      <div className="form-group tag-manager-existing-group">
        <label htmlFor="tag-manager-search">Existing Tags</label>
        <p className="tag-manager-hint">Click a tag to rename it. Clear the name and press Enter to delete.</p>
        <div className="input-with-icon">
          <input type="text" id="tag-manager-search" placeholder="Search tags..." value={search}
            onChange={(event) => setSearch(event.target.value)} />
          <button type="button" id="clear-tag-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>×</button>
        </div>
        <div id="tag-manager-list" className="tags-list">
          {shown.map((tag) => (
            <TagChip key={tag.id} tag={tag} onRename={(name) => renameTag(tag, name)} onDelete={() => deleteTag(tag)} />
          ))}
        </div>
      </div>
    </ModalDialog>
  );
}

function TagChip({ tag, onRename, onDelete }: {
  tag: Tag;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
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
      queueMicrotask(() => { committing.current = false; });
    }
  }

  return (
    <div className="tag" data-tag-id={tag.id} data-tag-name={tag.name} title={`${tag.name} — click to rename`} onClick={startEditing}>
      {editing ? (
        <input type="text" className="tag-edit-input" aria-label={`Rename tag ${tag.name}`} spellCheck={false} autoFocus
          value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown}
          onFocus={(event) => event.target.select()} onClick={(event) => event.stopPropagation()}
          onBlur={() => void commit()} />
      ) : (
        <span className="tag-text">{tag.name}</span>
      )}
      <span className="tag-count">{tag.model_count}</span>
      <span className="tag-remove" title="Delete tag" role="button"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); void onDelete(); }}>×</span>
    </div>
  );
}
