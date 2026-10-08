import { useEffect, useRef, useState } from 'react';
import { libraryValues, models, tags as tagApi } from '../api';
import { selection } from '../selection';

/** The lists the ☰ buttons search: designers, parent models, licenses and tags. */
export type ListField = 'designer' | 'parent' | 'license' | 'tag';

interface Item {
  label: string;
  /** What a pick returns: the label. */
  value: string;
}

interface Request {
  field: ListField;
  remove: boolean;
  resolve: (value: string | null) => void;
}

const TITLES: Record<ListField, [string, string?]> = {
  designer: ['Select Designer'], parent: ['Select Parent Model'], license: ['Select License'],
  tag: ['Select Tag', 'Remove Tag']
};

const named = (labels: (string | null | undefined)[]): Item[] =>
  [...new Set(labels.map((l) => String(l ?? '').trim()).filter(Boolean))].map((label) => ({ label, value: label }));

/** The items for a list; "remove" lists only what the selected models have. */
async function loadItems(field: ListField, remove: boolean): Promise<Item[]> {
  if (remove && field === 'tag') {
    const selected = await Promise.all(selection.values().map((p) => models.get<{ tags?: string[] }>(p).catch(() => null)));
    return named(selected.flatMap((m) => (Array.isArray(m?.tags) ? m!.tags : [])));
  }
  switch (field) {
    case 'designer': return named(await libraryValues.designers());
    case 'parent': return named(await libraryValues.parentModels());
    case 'license': return named(await libraryValues.licenses());
    case 'tag': return named((await tagApi.list()).map((t) => t.name));
  }
}

let open: ((request: Request) => void) | null = null;

/** Search a list and pick one item. Resolves to the pick, or null when cancelled. */
export function pickFromList(field: ListField, remove = false): Promise<string | null> {
  return new Promise((resolve) => {
    if (open) open({ field, remove, resolve });
    else resolve(null);
  });
}

/** The searchable list dialog (#searchable-list-dialog). */
export function ListPicker() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const pending = useRef<Request | null>(null);

  useEffect(() => {
    open = (next) => {
      pending.current?.resolve(null);
      pending.current = next;
      setRequest(next);
      setItems(null);
      setError(false);
      setQuery('');
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
      loadItems(next.field, next.remove)
        .then((list) => { if (pending.current === next) setItems(list.sort((a, b) => a.label.localeCompare(b.label))); })
        .catch((err) => {
          console.error('Error loading items for the list:', err);
          if (pending.current === next) setError(true);
        });
    };
    return () => { open = null; };
  }, []);

  const finish = (value: string | null) => {
    const current = pending.current;
    pending.current = null;
    if (dialogRef.current?.open) dialogRef.current.close();
    current?.resolve(value);
  };

  const term = query.trim().toLowerCase();
  const shown = (items || []).filter((item) => !term || item.label.toLowerCase().includes(term));
  const [title, removeTitle] = request ? TITLES[request.field] : ['Select Item'];
  return (
    <dialog id="searchable-list-dialog" className="modal" ref={dialogRef} onClose={() => finish(null)}>
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <h3 id="searchable-list-title">{request?.remove && removeTitle ? removeTitle : title}</h3>
        <div className="form-group">
          <input type="text" id="searchable-list-search" placeholder="Search..." autoComplete="off" ref={inputRef} value={query}
            onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="searchable-list-container">
          <ul id="searchable-list-items" className="searchable-list">
            {error && <li style={{ color: '#ff4444', cursor: 'default' }}>Error loading items</li>}
            {!error && items && !shown.length && <li style={{ color: '#888', cursor: 'default' }}>No items found</li>}
            {shown.map((item) => <li key={item.value} onClick={() => finish(item.value)}>{item.label}</li>)}
          </ul>
        </div>
        <div className="dialog-buttons">
          <button type="button" id="searchable-list-cancel" onClick={() => finish(null)}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
