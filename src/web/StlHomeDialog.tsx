import { useEffect, useRef, useState } from 'react';
import { settings } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';
import { scanFolders } from './scan/scan';

declare global {
  interface Window {
    openStlHome?: () => void;
  }
}

const dirKey = (dir: string) => dir.replace(/[\\/]+$/, '').toLowerCase();

/** A stored JSON list of paths, trimmed and without duplicates. */
function parseDirList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.map((item) => String(item ?? '').trim()).filter((dir) => {
      if (!dir || seen.has(dirKey(dir))) return false;
      seen.add(dirKey(dir));
      return true;
    });
  } catch {
    return [];
  }
}

/** The old single stlHome setting: one path, or several separated by newlines, commas or semicolons. */
function parseLegacyHome(raw: string | null): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) return parseDirList(text);
  return parseDirList(JSON.stringify(text.split(/[\r\n,;]+/)));
}

interface Form {
  homes: string[];
  excluded: string[];
  frequency: string;
  pathMetadata: boolean;
  direction: 'fromModel' | 'fromRoot';
  useDesigner: boolean;
  useParentModel: boolean;
  designerIndex: string;
  parentModelIndex: string;
}

const EMPTY: Form = {
  homes: [], excluded: [], frequency: '60', pathMetadata: false, direction: 'fromModel',
  useDesigner: true, useParentModel: true, designerIndex: '1', parentModelIndex: '0'
};

async function loadForm(): Promise<Form> {
  const keys = ['stlHomeDirectories', 'stlHome', 'stlHomeExcludeDirectories', 'stlHomeUpdateFrequency', 'pathMetadataStlHomeEnabled',
    'pathMetadataStlHomeDirection', 'pathMetadataUseDesigner', 'pathMetadataUseParentModel', 'pathMetadataDesignerIndex', 'pathMetadataParentModelIndex'];
  const [homes, legacy, excluded, frequency, enabled, direction, useDesigner, useParent, designerIndex, parentIndex] =
    await Promise.all(keys.map((key) => settings.get<string | null>(key)));
  const list = parseDirList(homes);
  return {
    homes: list.length ? list : parseLegacyHome(legacy),
    excluded: parseDirList(excluded),
    frequency: frequency || '60',
    pathMetadata: enabled === '1',
    direction: direction === 'fromRoot' ? 'fromRoot' : 'fromModel',
    useDesigner: useDesigner !== '0',
    useParentModel: useParent !== '0',
    designerIndex: designerIndex != null && designerIndex !== '' ? String(designerIndex) : '1',
    parentModelIndex: parentIndex != null && parentIndex !== '' ? String(parentIndex) : '0'
  };
}

/** An editable list of directories: Remove per row, and a path field with Add (or Enter). */
function DirList({ id, items, empty, placeholder, onChange }: {
  id: string; items: string[]; empty: string; placeholder: string; onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  function add() {
    const dir = draft.trim();
    if (!dir || items.some((item) => dirKey(item) === dirKey(dir))) return;
    onChange([...items, dir]);
    setDraft('');
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }));
  }

  return (
    <>
      <ul id={`${id}-list`} className="stl-home-exclude-list">
        {items.length === 0 ? <li className="stl-home-exclude-empty">{empty}</li> : items.map((item, index) => (
          <li key={item} className="stl-home-exclude-item">
            <span className="stl-home-exclude-path" title={item}>{item}</span>
            <button type="button" className="secondary-button stl-home-exclude-remove"
              onClick={() => onChange(items.filter((_, other) => other !== index))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="stl-home-exclude-add-row" ref={endRef}>
        <input type="text" id={`${id}-input`} placeholder={placeholder} autoComplete="off" value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" id={`${id}-add`} className="secondary-button" onClick={add}>Add</button>
      </div>
    </>
  );
}

/**
 * Settings → STL Home: the library directories scanned on a timer, directories to skip, and
 * reading Designer and Parent model from folder names. Registers window.openStlHome.
 */
export function StlHomeDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => exposeGlobal('openStlHome', () => {
    loadForm()
      .then(setForm)
      .catch((error) => console.error('[STL Home] Could not load the settings:', error))
      .finally(() => { if (!dialogRef.current?.open) dialogRef.current?.showModal(); });
  }), []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const values: [string, string][] = [
        ['stlHomeDirectories', JSON.stringify(form.homes)],
        ['stlHome', form.homes[0] || ''],
        ['stlHomeExcludeDirectories', JSON.stringify(form.excluded)],
        ['stlHomeUpdateFrequency', form.frequency || '60'],
        ['pathMetadataStlHomeEnabled', form.pathMetadata ? '1' : '0'],
        ['pathMetadataStlHomeDirection', form.direction],
        ['pathMetadataUseDesigner', form.useDesigner ? '1' : '0'],
        ['pathMetadataUseParentModel', form.useParentModel ? '1' : '0'],
        ['pathMetadataDesignerIndex', form.designerIndex || '1'],
        ['pathMetadataParentModelIndex', form.parentModelIndex || '0']
      ];
      for (const [key, value] of values) await settings.save(key, value);
      dialogRef.current?.close();
      // Scan the directories now; the server then rescans them on its interval.
      if (form.homes.length) scanFolders(form.homes, { stlHome: true }).catch((error) => console.error('STL Home scan on save:', error));
    } catch (error) {
      await showMessage('Error', `Failed to save STL Home: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const indexField = (useKey: 'useDesigner' | 'useParentModel', indexKey: 'designerIndex' | 'parentModelIndex', id: string, label: string) => (
    <div className="form-group path-metadata-col">
      <div className="form-group checkbox-container stl-home-path-metadata-checkbox-row stl-home-use-row">
        <input type="checkbox" id={`stl-home-use-${id}`} checked={form[useKey]} onChange={(event) => set(useKey, event.target.checked)} />
        <label htmlFor={`stl-home-use-${id}`}>Use folder path for {label}</label>
      </div>
      <label htmlFor={`stl-home-${id}-index`}>Folder level:</label>
      <input type="number" id={`stl-home-${id}-index`} min="0" value={form[indexKey]} onChange={(event) => set(indexKey, event.target.value)} />
    </div>
  );

  return (
    <ModalDialog id="stl-home-dialog" title="STL Home" dialogRef={dialogRef}
      description={(
        <>
          <p className="warning-text">Warning: Scanning large directories may impact performance.</p>
          <p className="setting-description">Directories in this list are scanned when you save, and again on the schedule below.</p>
        </>
      )}
      footer={(
        <>
          <button type="button" id="save-stl-home-button" className="is-primary" disabled={saving} onClick={save}>Save</button>
          <button type="button" id="cancel-stl-home-button" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </>
      )}>
      <div className="form-group" id="stl-home-directories-group">
        <label htmlFor="stl-home-directories-input">Directories</label>
        <p className="setting-description">Paths on the server. Add more than one to cover separate libraries.</p>
        <DirList id="stl-home-directories" items={form.homes} empty="No directories selected." placeholder="Enter a directory path"
          onChange={(homes) => set('homes', homes)} />
      </div>
      <div className="form-group" id="stl-home-update-frequency-group">
        <label htmlFor="stl-home-update-frequency">Update Frequency (minutes):</label>
        <input type="number" id="stl-home-update-frequency" min="1" max="1440" value={form.frequency}
          onChange={(event) => set('frequency', event.target.value)} />
        <p className="setting-description">How frequently the STL Home directories will be scanned for new files.</p>
      </div>
      <div className="form-group" id="stl-home-exclude-group">
        <label htmlFor="stl-home-exclude-input">Excluded directories</label>
        <p className="setting-description">STL Home scans skip these directories and everything inside them. Use a full path, or a path relative to the STL Home directory being scanned. Folders starting with a dot, such as .manyfold and .git, are always skipped. Models already in the library stay until you remove them, except files found in those hidden folders, which the next scan can drop from the library.</p>
        <DirList id="stl-home-exclude" items={form.excluded} empty="No directories excluded." placeholder="Enter a path to exclude"
          onChange={(excluded) => set('excluded', excluded)} />
      </div>
      <div className="form-group" id="stl-home-path-metadata-group">
        <div className="form-group checkbox-container stl-home-path-metadata-checkbox-row">
          <input type="checkbox" id="stl-home-path-metadata-enabled" checked={form.pathMetadata} onChange={(event) => set('pathMetadata', event.target.checked)} />
          <label htmlFor="stl-home-path-metadata-enabled">Enable: use folder path to set Designer and Parent model</label>
        </div>
        <div id="stl-home-path-metadata-options" className={`stl-home-path-metadata-options${form.pathMetadata ? '' : ' grayed'}`}>
          <div className="form-group stl-home-path-direction-row">
            <label htmlFor="stl-home-path-direction">Use folder path:</label>
            <select id="stl-home-path-direction" value={form.direction} onChange={(event) => set('direction', event.target.value as Form['direction'])}>
              <option value="fromModel">From Model</option>
              <option value="fromRoot">From Root</option>
            </select>
          </div>
          <p className="setting-description stl-home-path-intro">When you run “Scan STL Home”, folder names are used to set Designer and Parent model. Values are only applied when the field is empty.</p>
          <p className="setting-description stl-home-path-direction-desc">
            {form.direction === 'fromRoot'
              ? 'From Root: level 0 = the STL Home directory that contains the file, 1 = first folder under it, 2 = second, etc.'
              : 'From Model: level 0 = parent of file, 1 = grandparent, 2 = great-grandparent, etc.'}
          </p>
          <p className="setting-description stl-home-path-example"><span className="path-example">Example: /models/DESIGNER/PARENT/MODEL.3MF</span> — From Model: level 0 = PARENT, level 1 = DESIGNER. From Root: level 0 = models (STL Home), level 1 = DESIGNER, level 2 = PARENT.</p>
          <div className="path-metadata-indices">
            {indexField('useDesigner', 'designerIndex', 'designer', 'Designer')}
            {indexField('useParentModel', 'parentModelIndex', 'parent-model', 'Parent model')}
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
