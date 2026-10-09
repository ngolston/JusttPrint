import { useEffect, useRef, useState } from 'react';
import { fileTypes, settings, type FileTypeEntry } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openFileTypeSettings?: () => void;
  }
}

const METADATA_FIELDS = [
  ['enable3MFDesigner', 'enable-3mf-designer', 'Designer'],
  ['enable3MFParentModel', 'enable-3mf-parent-model', 'Parent Model'],
  ['enable3MFLicense', 'enable-3mf-license', 'License Type'],
  ['enable3MFNotes', 'enable-3mf-notes', 'Notes']
] as const;

type MetadataKey = (typeof METADATA_FIELDS)[number][0];

interface FileTypeSettings {
  zip: boolean;
  scanTypes: string[];
  excludeFolders: string;
  autoTagFromFolder: boolean;
  metadata: Record<MetadataKey, boolean>;
}

const DEFAULTS: FileTypeSettings = {
  zip: false,
  scanTypes: [],
  excludeFolders: '',
  autoTagFromFolder: false,
  metadata: { enable3MFDesigner: true, enable3MFParentModel: true, enable3MFLicense: true, enable3MFNotes: true }
};

function parseIds(raw: string | null): string[] {
  try {
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

async function loadSettings(): Promise<{ values: FileTypeSettings; saved: string[] }> {
  const get = (key: string) => settings.get<string | null>(key);
  const [zip, scanTypes, excludeFolders, autoTag, ...metadata] = await Promise.all([
    get('enableZipArchives'),
    get('scanAdditionalFileTypes'),
    get('scanExcludeFolders'),
    get('autoTagFromFolderOnScan'),
    ...METADATA_FIELDS.map(([key]) => get(key))
  ]);
  const saved = parseIds(scanTypes);
  return {
    saved,
    values: {
      zip: zip === '1',
      scanTypes: saved,
      excludeFolders: excludeFolders || '',
      autoTagFromFolder: autoTag === '1',
      // Unset means on.
      metadata: Object.fromEntries(METADATA_FIELDS.map(([key], index) => [key, metadata[index] !== '0'])) as Record<MetadataKey, boolean>
    }
  };
}

/**
 * Settings → File Type: ZIP scanning, the extra file types a scan picks up, skipped folders,
 * Tag from Folder on scan, and which 3MF metadata fills model details. Unticking a file type
 * that is in the library asks before removing those models. Registers window.openFileTypeSettings.
 */
export function FileTypeSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [catalog, setCatalog] = useState<FileTypeEntry[]>([]);
  const [values, setValues] = useState<FileTypeSettings>(DEFAULTS);
  const [savedTypes, setSavedTypes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openFileTypeSettings', () => {
        (async () => {
          try {
            const [entries, loaded] = await Promise.all([fileTypes.catalog(), loadSettings()]);
            setCatalog(entries);
            setValues(loaded.values);
            setSavedTypes(loaded.saved);
          } catch (error) {
            console.error('Could not load the file type settings:', error);
          }
          if (!dialogRef.current?.open) dialogRef.current?.showModal();
        })();
      }),
    []
  );

  const update = (change: Partial<FileTypeSettings>) => setValues((previous) => ({ ...previous, ...change }));

  function toggleType(id: string, checked: boolean) {
    setValues((previous) => ({
      ...previous,
      scanTypes: checked ? [...previous.scanTypes, id] : previous.scanTypes.filter((other) => other !== id)
    }));
  }

  /** Asks before removing models of unticked types. False when the user said No. */
  async function removeUntickedTypes(): Promise<boolean> {
    const unticked = savedTypes.filter((id) => !values.scanTypes.includes(id));
    if (!unticked.length) return true;
    const count = await fileTypes.countModels(unticked);
    if (count <= 0) return true;
    const labels = unticked.map((id) => catalog.find((entry) => entry.id === id)?.label || id).join(', ');
    const message =
      count === 1
        ? `Unchecking "${labels}" will remove 1 file of that type from the library. This cannot be undone. Continue?`
        : `Unchecking ${labels} will remove ${count} files of those types from the library. This cannot be undone. Continue?`;
    if ((await showMessage('Remove file type from library?', message, ['Yes', 'No'])) !== 'Yes') return false;
    await fileTypes.removeModels(unticked);
    await window.performCombinedSearch?.();
    return true;
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      if (!(await removeUntickedTypes())) return;
      // Keep the catalog order, and drop ids the catalog no longer has.
      const scanTypes = catalog.length ? catalog.map((entry) => entry.id).filter((id) => values.scanTypes.includes(id)) : values.scanTypes;
      await settings.save('enableZipArchives', values.zip ? '1' : '0');
      await settings.save('scanAdditionalFileTypes', JSON.stringify(scanTypes));
      for (const [key] of METADATA_FIELDS) await settings.save(key, values.metadata[key] ? '1' : '0');
      await settings.save('scanExcludeFolders', values.excludeFolders);
      await settings.save('autoTagFromFolderOnScan', values.autoTagFromFolder ? '1' : '0');
      setSavedTypes(scanTypes);
      dialogRef.current?.close();
      await window.populateFileTypeFilter?.();
    } catch (error) {
      await showMessage('Error', `Failed to save file type settings: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      id="file-type-settings-dialog"
      title="File Type Settings"
      dialogRef={dialogRef}
      description={
        <p className="warning-text">
          Warning: Enabling ZIP archive support may significantly impact scanning performance, especially with large archives or directories containing many ZIP
          files. ZIP files will be opened and scanned during directory scans, which can be slow and memory-intensive.
        </p>
      }
      footer={
        <>
          <button type="button" id="save-file-type-settings" className="is-primary" disabled={saving} onClick={save}>
            Save
          </button>
          <button type="button" id="cancel-file-type-settings" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      <div className="settings-group">
        <h4>Supported File Types</h4>
        <div className="form-group checkbox-container">
          <input type="checkbox" id="enable-zip-archives" checked={values.zip} onChange={(event) => update({ zip: event.target.checked })} />
          <label htmlFor="enable-zip-archives">Enable ZIP Archive Support:</label>
        </div>
        <p className="setting-description">
          When enabled, JusttPrint will scan inside ZIP files for 3D models (STL and 3MF files). Each model found within a ZIP file will be indexed separately.
        </p>
      </div>
      <div className="settings-group">
        <h4>Additional file types to discover during scan</h4>
        <p className="setting-description">
          These types will be discovered when scanning folders. Most do not support 3D preview; a placeholder with the file type (e.g. OBJ, STEP) will be shown
          and you can add your own images.
        </p>
        <div id="scan-additional-types-container" className="scan-file-types-grid">
          {catalog.map((entry) => (
            <div key={entry.id} className="scan-file-type-option">
              <input
                type="checkbox"
                id={`scan-type-${entry.id}`}
                checked={values.scanTypes.includes(entry.id)}
                onChange={(event) => toggleType(entry.id, event.target.checked)}
              />
              <label htmlFor={`scan-type-${entry.id}`}>{entry.label}</label>
            </div>
          ))}
        </div>
      </div>
      <div className="settings-group">
        <h4>Skip folders</h4>
        <p className="setting-description">
          Folders whose names start with a dot are always skipped, including <code>.manyfold</code>, <code>.git</code>, and AppleDouble <code>._</code> files.
          Add more folder names to skip, one per line.
        </p>
        <div className="form-group">
          <label htmlFor="scan-exclude-folders">Extra folder names:</label>
          <textarea
            id="scan-exclude-folders"
            rows={4}
            placeholder={'cache\nderivatives'}
            value={values.excludeFolders}
            onChange={(event) => update({ excludeFolders: event.target.value })}
          />
        </div>
      </div>
      <div className="settings-group">
        <h4>Tag from Folder</h4>
        <div className="form-group checkbox-container">
          <input
            type="checkbox"
            id="auto-tag-from-folder-on-scan"
            checked={values.autoTagFromFolder}
            onChange={(event) => update({ autoTagFromFolder: event.target.checked })}
          />
          <label htmlFor="auto-tag-from-folder-on-scan">Apply Tag from Folder to newly added files</label>
        </div>
        <p className="setting-description">
          When a scan adds a file, add parent folder names as tags. Uses Folder levels from AI Configuration. Files already in the library are left unchanged,
          and tags already on a model are kept. This does not call AI.
        </p>
      </div>
      <div className="settings-group">
        <h4>3MF Metadata</h4>
        <p className="setting-description">
          When checked, if available, the model details will be pulled from the 3MF metadata when the 3MF file is added to the library. Not all 3MF models
          contain complete metadata.
        </p>
        {METADATA_FIELDS.map(([key, id, label]) => (
          <div key={key} className="form-group checkbox-container">
            <input
              type="checkbox"
              id={id}
              checked={values.metadata[key]}
              onChange={(event) => update({ metadata: { ...values.metadata, [key]: event.target.checked } })}
            />
            <label htmlFor={id}>{label}</label>
          </div>
        ))}
      </div>
    </ModalDialog>
  );
}
