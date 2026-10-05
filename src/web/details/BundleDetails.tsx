import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { tags as tagApi } from '../api';
import { askText, exposeGlobal } from '../page';
import { bundleSummary, type PrintModel } from '../print/printStatus';
import { formatFileSize } from '../StatsDialog';
import { showFolder } from '../folders/store';
import { pickFromList } from '../components/ListPicker';

interface BundleChild extends PrintModel {
  filePath: string;
  fileName?: string | null;
  size?: number | null;
}

/** A ZIP or folder bundle as the grid groups it. */
export interface BundleRecord {
  groupKey: string;
  groupLabel?: string | null;
  children: BundleChild[];
}

export interface BundleShow {
  record: BundleRecord;
  kind: 'zip' | 'folder' | string;
  /** The ZIP file or the folder holding the bundle. */
  containerPath: string;
}

/** What the bundle panel asks of renderer.js. */
export interface BundleHost {
  /** Show one model of the bundle in the details panel. */
  openModel(filePath: string): void;
  /** The tags on any model in the bundle. */
  tagNames(record: BundleRecord): Promise<string[]>;
  /** Add or remove tags on every model in the bundle (and update their cards). */
  changeTags(record: BundleRecord, change: { addTags?: string[]; removeTags?: string[] }): Promise<boolean>;
  /** A new tag exists: refresh the tag filter and the other pickers. */
  tagCreated(): Promise<void>;
}

declare global {
  interface Window {
    bundleHost?: BundleHost;
    /** The ZIP / folder bundle panel (renderer.js showBundleDetails drives it). */
    bundleDetails?: { show: (bundle: BundleShow) => void; clear: () => void; reloadOptions: () => void };
  }
}

const sortNames = (names: string[]) => [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

function entryName(child: BundleChild) {
  const entryPath = child.filePath?.includes('::')
    ? (child.filePath.split('::')[1] || child.fileName || '')
    : (child.fileName || child.filePath || '');
  return { entryPath, displayName: String(entryPath).split(/[/\\]/).pop() || entryPath || '—' };
}

/**
 * The bundle panel's title (in the static header) and body (#bundle-details-slot): path,
 * counts, tags shared across the bundle, and its models. Registers window.bundleDetails.
 */
export function BundleDetails() {
  const [titleSlot] = useState(() => document.getElementById('bundle-details-title'));
  const [bodySlot] = useState(() => document.getElementById('bundle-details-slot'));
  const [bundle, setBundle] = useState<BundleShow | null>(null);
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const host = window.bundleHost;

  const reloadOptions = () => {
    tagApi.list().then((list) => setAllTags(sortNames(list.map((t) => t.name)))).catch(() => {});
  };

  useEffect(() => exposeGlobal('bundleDetails', {
    show: (next: BundleShow) => {
      setBundle(next);
      setActivePath(null);
      setTagNames([]);
      reloadOptions();
      window.bundleHost?.tagNames(next.record).then((names) => setTagNames(sortNames(names))).catch(() => {});
    },
    clear: () => {
      setBundle(null);
      setTagNames([]);
    },
    reloadOptions
  }), []);

  async function changeTags(change: { addTags?: string[]; removeTags?: string[] }) {
    if (!bundle || !host) return;
    const add = change.addTags || [];
    const remove = new Set(change.removeTags || []);
    setTagNames((current) => sortNames([...current.filter((t) => !remove.has(t)), ...add]));
    await host.changeTags(bundle.record, change);
  }

  async function addTag(name: string | null | undefined) {
    const tag = String(name || '').trim();
    if (tag && !tagNames.includes(tag)) await changeTags({ addTags: [tag] });
  }

  async function addNewTag() {
    const typed = (await askText('New tag', 'Enter a tag to add to every model in this archive:'))?.trim();
    if (!typed) return;
    try {
      const saved = await tagApi.create(typed);
      await addTag(saved?.name || typed);
      reloadOptions();
      await host?.tagCreated();
    } catch (error) {
      console.error('Error creating tag:', error);
    }
  }

  if (!bundle) return null;
  const { record, kind, containerPath } = bundle;
  const children = [...record.children].sort((a, b) =>
    String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, { sensitivity: 'base' }));
  const totalBytes = children.reduce((sum, c) => sum + (Number(c.size) || 0), 0);
  const print = bundleSummary(children);
  const kindLabel = kind === 'zip' ? 'ZIP archive' : 'Folder bundle';

  return (
    <>
      {titleSlot && createPortal(record.groupLabel || 'Bundle', titleSlot)}
      {bodySlot && createPortal(
        <>
          <p id="bundle-details-subtitle" className="bundle-details-subtitle">
            {`${kindLabel} • ${children.length} file${children.length === 1 ? '' : 's'}`}
          </p>
          <div className="form-group">
            <label>Container path</label>
            <div className="bundle-details-path-row">
              <input type="text" id="bundle-details-path" readOnly value={containerPath} />
              <button type="button" id="bundle-details-show-path" className="icon-button" title="Show this folder in the library"
                disabled={!containerPath}
                onClick={(event) => {
                  event.preventDefault();
                  if (containerPath) showFolder(containerPath);
                }}>↗</button>
            </div>
          </div>
          <div className="bundle-details-stats" id="bundle-details-stats">
            <span><strong>{children.length}</strong> models</span>
            <span><strong>{formatFileSize(totalBytes)}</strong> combined size</span>
            <span><strong>{print.printedCount}/{children.length}</strong> printed{print.totalCount ? ` (${print.label})` : ''}</span>
          </div>
          <div className="form-group">
            <label>Tags:</label>
            <div className="tags-container">
              <div className="tags-input-container">
                <select id="bundle-tag-select" value="" onChange={(e) => addTag(e.target.value)}>
                  <option value="">Select a tag...</option>
                  {allTags.filter((t) => !tagNames.includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <button type="button" className="list-button icon-button" title="Search existing tags"
                  onClick={async () => addTag(await pickFromList('tag'))}>☰</button>
                <button type="button" id="bundle-add-tag" className="icon-button" title="Add a new tag to all models in this archive"
                  onClick={addNewTag}>+</button>
              </div>
              <div id="bundle-tags" className="tags-list">
                {tagNames.map((name) => (
                  <div key={name} className="tag" data-tag-name={name} title={name}>
                    <span className="tag-text">{name}</span>
                    <span className="tag-remove" onClick={() => changeTags({ removeTags: [name] })}>×</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="form-group">
            <label>Models</label>
            <ul id="bundle-contents-list" className="bundle-contents-list" aria-label="Models in archive">
              {children.map((child) => {
                const { entryPath, displayName } = entryName(child);
                return (
                  <li key={child.filePath}>
                    <button type="button" className={`bundle-contents-list-item${activePath === child.filePath ? ' is-active' : ''}`}
                      title={entryPath || displayName}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setActivePath(child.filePath);
                        if (child.filePath) host?.openModel(child.filePath);
                      }}>{displayName}</button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>,
        bodySlot
      )}
    </>
  );
}
