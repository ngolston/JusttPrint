import { useEffect, useState } from 'react';
import { FolderPlus, Plus } from 'lucide-react';
import { collections, type CollectionSummary } from '../api';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';
import { exposeGlobal, onServerEvent } from '../page';

declare global {
  interface Window {
    /** Add models (file paths) to collections. */
    openAddToCollection?: (filePaths: string[]) => void;
  }
}

type Row = CollectionSummary & { selectedInIt: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What ticking and unticking changes: the collections to add to and to take the models out of. */
export function collectionChanges(rows: { id: number; selectedInIt: number }[], ticked: Set<number>, models: number) {
  const add = rows.filter((row) => ticked.has(row.id) && row.selectedInIt < models).map((row) => row.id);
  const take = rows.filter((row) => !ticked.has(row.id) && row.selectedInIt > 0).map((row) => row.id);
  return { add, take };
}

/**
 * Add to Collection (model menu): tick the collections the models belong in, or make a new one.
 * A collection holding some of the models shows a dash until you tick or untick it.
 */
export function AddToCollectionDialog() {
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [models, setModels] = useState(0);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(filePaths: string[]) {
    try {
      const result = await collections.membership(filePaths);
      setRows(result.collections);
      setModels(result.models);
      setTicked(new Set(result.collections.filter((c) => result.models > 0 && c.selectedInIt === result.models).map((c) => c.id)));
      setTouched(new Set());
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  useEffect(() => {
    const show = (filePaths: string[]) => {
      const list = (filePaths || []).filter(Boolean);
      if (!list.length) return;
      setPaths(list);
      setRows(null);
      setStatus('');
      setNewName('');
      setOpen(true);
      void load(list);
    };
    const offGlobal = exposeGlobal('openAddToCollection', show);
    const offEvent = onServerEvent('open-add-to-collection', show);
    return () => { offGlobal(); offEvent(); };
  }, []);

  function toggle(id: number) {
    setTicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setTouched((previous) => new Set(previous).add(id));
  }

  async function createAndAdd() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const made = await collections.create(name);
      await collections.add(made.id, paths);
      setNewName('');
      setStatus(`Added to ${made.name}.`);
      await load(paths);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!rows) return;
    setBusy(true);
    try {
      // Only collections the user ticked or unticked change; a partly-selected one left alone stays as it is.
      const { add, take } = collectionChanges(rows.filter((row) => touched.has(row.id)), ticked, models);
      for (const id of add) await collections.add(id, paths);
      for (const id of take) await collections.take(id, paths);
      setOpen(false);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const count = paths.length;
  return (
    <Modal open={open} onClose={() => setOpen(false)} title={count === 1 ? 'Add to Collection' : `Add ${count} Models to Collections`} className="jp-collect"
      footer={(
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" id="jp-collect-save" disabled={busy || !rows || touched.size === 0} onClick={save}>Save</Button>
        </>
      )}>
      {rows === null ? <p className="jp-meta">Loading…</p> : rows.length === 0 ? (
        <p className="jp-meta">No collections yet. Make the first one below.</p>
      ) : (
        <ul className="jp-collect__list" id="jp-collect-list">
          {rows.map((row) => {
            const partly = !touched.has(row.id) && row.selectedInIt > 0 && row.selectedInIt < models;
            return (
              <li key={row.id}>
                <label className="jp-collect__row">
                  <input type="checkbox" checked={ticked.has(row.id)} ref={(el) => { if (el) el.indeterminate = partly; }}
                    onChange={() => toggle(row.id)} />
                  <span className="jp-collect__name">{row.name}</span>
                  <span className="jp-meta">{row.modelCount} {row.modelCount === 1 ? 'model' : 'models'}{partly ? ` · ${row.selectedInIt} of these` : ''}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="jp-collect__new">
        <FolderPlus size={18} aria-hidden="true" />
        <input className="jp-input" id="jp-collect-new-name" placeholder="New collection name" value={newName} maxLength={120}
          onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createAndAdd(); }} />
        <Button icon={Plus} id="jp-collect-create" disabled={busy || !newName.trim()} onClick={createAndAdd}>Create and Add</Button>
      </div>
      <p className="jp-meta" role="status" id="jp-collect-status">{status}</p>
    </Modal>
  );
}
