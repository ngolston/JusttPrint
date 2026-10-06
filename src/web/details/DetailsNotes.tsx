import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { htmlToMarkdown, render, sanitizeUrl } from '../notes/markdown';
import { askText, exposeGlobal } from '../page';
import { Pencil } from 'lucide-react';

interface NotesModel {
  filePath: string;
  notes?: string | null;
}

declare global {
  interface Window {
    /** The details panel's notes (library/details.ts drives it). */
    detailsNotes?: { show: (model: NotesModel) => void; clear: () => void };
  }
}

type Format = 'bold' | 'italic' | 'strike' | 'h2' | 'list' | 'link' | 'code';

const TOOLBAR: { kind: Format; title: string; label: ReactNode }[] = [
  { kind: 'bold', title: 'Bold (Ctrl+B)', label: <strong>B</strong> },
  { kind: 'italic', title: 'Italic (Ctrl+I)', label: <em>I</em> },
  { kind: 'strike', title: 'Strikethrough', label: <s>S</s> },
  { kind: 'h2', title: 'Heading', label: 'H' },
  { kind: 'list', title: 'Bullet list', label: '•' },
  { kind: 'link', title: 'Link', label: 'Link' },
  { kind: 'code', title: 'Code', label: '</>' }
];

function selectRange(range: Range) {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Apply a toolbar format to the selection in the rich-text editor. */
async function applyFormat(rich: HTMLElement, kind: Format) {
  rich.focus();
  try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* ignore */ }
  const selection = window.getSelection();
  if (kind === 'bold') document.execCommand('bold');
  else if (kind === 'italic') document.execCommand('italic');
  else if (kind === 'strike') document.execCommand('strikeThrough');
  else if (kind === 'list') document.execCommand('insertUnorderedList');
  else if (kind === 'h2') {
    let anchor = selection?.anchorNode || null;
    if (anchor && anchor.nodeType === 3) anchor = anchor.parentNode;
    const inHeading = !!(anchor as Element | null)?.closest?.('h2');
    document.execCommand('formatBlock', false, inHeading ? 'p' : 'H2');
  } else if (kind === 'link') {
    const range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const safe = sanitizeUrl(await askText('Link', 'Link URL', 'https://'));
    if (!safe || !range) return;
    rich.focus();
    selectRange(range);
    if (range.collapsed) {
      const a = document.createElement('a');
      a.href = safe;
      a.textContent = safe;
      range.insertNode(a);
      range.setStartAfter(a);
      range.setEndAfter(a);
      selectRange(range);
    } else {
      document.execCommand('createLink', false, safe);
    }
  } else if (kind === 'code' && selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    const code = document.createElement('code');
    if (range.collapsed) {
      code.textContent = 'code';
      range.insertNode(code);
      range.selectNodeContents(code);
      selectRange(range);
    } else {
      try {
        range.surroundContents(code);
      } catch {
        code.textContent = range.toString() || 'code';
        range.deleteContents();
        range.insertNode(code);
      }
    }
  }
}

/** Links in rendered notes open in a new tab through the bridge. */
function openLink(event: MouseEvent): boolean {
  const link = (event.target as Element).closest?.('a');
  if (!link) return false;
  const href = link.getAttribute('href');
  if (href && window.electron?.openExternal) {
    event.preventDefault();
    window.electron.openExternal(href);
  }
  return true;
}

/**
 * The details panel's notes: a rendered Markdown preview (#details-notes-slot) and the Edit
 * Notes dialog with a rich-text editor that saves Markdown. Registers window.detailsNotes.
 */
export function DetailsNotes() {
  const [slot] = useState(() => document.getElementById('details-notes-slot'));
  const [model, setModel] = useState<NotesModel | null>(null);
  const [notes, setNotes] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const richRef = useRef<HTMLDivElement>(null);
  const editing = useRef<NotesModel | null>(null);

  useEffect(() => exposeGlobal('detailsNotes', {
    show: (next: NotesModel) => {
      setModel(next);
      setNotes(next.notes || '');
    },
    clear: () => {
      setModel(null);
      setNotes('');
    }
  }), []);

  function openEditor() {
    const dialog = dialogRef.current;
    const rich = richRef.current;
    if (!dialog || !rich || !model) return;
    editing.current = model;
    rich.innerHTML = notes.trim() ? render(notes) : '';
    dialog.showModal();
    rich.focus();
  }

  async function save() {
    const target = editing.current;
    const value = htmlToMarkdown(richRef.current);
    dialogRef.current?.close();
    if (!target) return;
    if (target === model) setNotes(value);
    await window.detailsHost?.saveField(target.filePath, 'notes', value);
  }

  function onEditorKeyDown(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !richRef.current) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i') {
      event.preventDefault();
      applyFormat(richRef.current, key === 'b' ? 'bold' : 'italic');
    }
  }

  const html = notes.trim() ? render(notes) : '<p class="notes-preview-empty">Click to add notes...</p>';

  return (
    <>
      {slot && createPortal(
        <div className="form-group">
          <label>Notes:</label>
          <div className="notes-input-container">
            <div id="model-notes-preview" className="notes-preview notes-sidebar-preview" aria-label="Notes"
              dangerouslySetInnerHTML={{ __html: html }}
              onClick={(event) => { if (!openLink(event)) openEditor(); }} />
            <button type="button" id="open-notes-modal-button" className="icon-button" title="Edit notes"
              aria-label="Edit notes" onClick={(event) => { event.preventDefault(); openEditor(); }}><Pencil size={14} aria-hidden="true" /></button>
          </div>
        </div>,
        slot
      )}
      <dialog id="notes-modal-dialog" className="modal notes-modal" ref={dialogRef}
        onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current?.close(); }}>
        <form method="dialog" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <h3>Edit Notes</h3>
          <div className="form-group">
            <div className="notes-editor" data-notes-editor="modal">
              <div className="notes-toolbar" role="toolbar" aria-label="Notes formatting">
                {TOOLBAR.map(({ kind, title, label }) => (
                  <button key={kind} type="button" data-md={kind} title={title}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { if (richRef.current) applyFormat(richRef.current, kind); }}>{label}</button>
                ))}
              </div>
              <div id="notes-richtext" className="notes-richtext" contentEditable suppressContentEditableWarning role="textbox"
                aria-multiline="true" aria-label="Notes" ref={richRef} onKeyDown={onEditorKeyDown} />
            </div>
          </div>
          <div className="dialog-buttons">
            <button type="submit" id="save-notes-button">Save</button>
            <button type="button" id="cancel-notes-button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
