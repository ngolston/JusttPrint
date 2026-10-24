import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Boxes, Copy, FolderOpen, FolderPlus, Library, Pencil } from 'lucide-react';
import { isPreviewablePath } from '../preview/studio';
import { callAction, LIBRARY_CHANGED } from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { Prop } from '../details/ModelDetailsPanel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { KitChecklist } from '../kits/KitChecklist';
import { folderCrumbs, folderFilterFor, formatFileSize } from '../library/paths';
import { stlHomeDirectories } from '../scan/stlHome';
import { render as renderMarkdown } from '../notes/markdown';
import { onServerEvent, showMessage } from '../page';
import { useCan } from '../session';
import { navigate } from '../shell/routes';
import { loadSlicers, offerSlicerSettings, sendToSlicer, type Slicer } from '../slicer';
import { showCategory } from './CategoriesPage';
import { ModelMediaSection } from '../media/ModelMediaSection';
import { FileRow, type FolderFile } from './ModelPage';

/** A folder as a model (get-folder, src/core/folder-models.js). */
interface Folder {
  path: string;
  name: string;
  files: (FolderFile & { id: number; designer: string | null; dateAdded: string | null })[];
  notes: string;
  designers: string[];
  licenses: string[];
  sources: string[];
  tags: string[];
  categories: string[];
  size: number;
  added: string | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function showInLibrary(change: () => void) {
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    change();
  });
}

/** The folder's pictures: one per file that has one, large, with a strip to pick from. */
function Pictures({ files }: { files: Folder['files'] }) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const images = files.map((file) => file.image).filter((image): image is string => !!image && !broken.has(image));
  const [index, setIndex] = useState(0);
  const drop = (src: string) => setBroken((now) => new Set(now).add(src));
  if (!images.length) return null;
  const shown = images[index < images.length ? index : 0];
  return (
    <div className="jp-model-page__gallery">
      <div className="jp-model-page__stage">
        <img src={shown} alt="" draggable={false} onError={() => drop(shown)} />
      </div>
      {images.length > 1 && (
        <div className="jp-details__strip" role="listbox" aria-label="Pictures" aria-orientation="horizontal">
          {images.slice(0, 40).map((src, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === index}
              aria-label={`Picture ${i + 1} of ${images.length}`}
              className={cx('jp-details__thumb', i === index && 'is-selected')}
              onClick={() => setIndex(i)}
            >
              <img src={src} alt="" draggable={false} onError={() => drop(src)} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The folder's own notes: shown, and changed by editors. */
function FolderNotes({ folder, onSaved }: { folder: Folder; onSaved: () => void }) {
  const canEdit = useCan('editor');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.notes);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await callAction('save-folder-notes', folder.path, draft);
      setEditing(false);
      onSaved();
    } catch (error) {
      await showMessage('Notes', errorText(error));
    } finally {
      setSaving(false);
    }
  }

  if (!folder.notes.trim() && !canEdit) return null;
  return (
    <section className="jp-card jp-model-page__notes" aria-labelledby="jp-folder-notes">
      <div className="jp-kit__head">
        <h2 className="jp-panel-title" id="jp-folder-notes">
          Notes
        </h2>
        {canEdit && !editing && (
          <Button
            size="sm"
            icon={Pencil}
            id="jp-folder-notes-edit"
            onClick={() => {
              setDraft(folder.notes);
              setEditing(true);
            }}
          >
            {folder.notes.trim() ? 'Edit' : 'Add Notes'}
          </Button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            className="jp-input jp-folder-page__notes-input"
            id="jp-folder-notes-input"
            rows={8}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Notes about this folder (Markdown)"
          />
          <div className="jp-category-scan__buttons">
            <Button variant="primary" id="jp-folder-notes-save" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </>
      ) : folder.notes.trim() ? (
        <div className="jp-model-page__markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(folder.notes) }} />
      ) : (
        <p className="jp-meta">Notes about the whole model: how it goes together, what to print it in, what is left to do.</p>
      )}
    </section>
  );
}

/**
 * A folder shown as one model (#/folder/<path>, Folders as models): its pictures, notes, kit
 * progress and files on the left; what its files share and actions for all of them on the right.
 */
export function FolderPage({ path }: { path: string }) {
  const canEdit = useCan('editor');
  const [folder, setFolder] = useState<Folder | null | undefined>(undefined);
  const [slicers, setSlicers] = useState<Slicer[]>([]);
  const [libraryRoots, setLibraryRoots] = useState<string[]>([]);
  useEffect(() => {
    void stlHomeDirectories()
      .then(setLibraryRoots)
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    callAction<Folder | null>('get-folder', path).then(setFolder, () => setFolder(null));
  }, [path]);

  useEffect(() => {
    setFolder(undefined);
    load();
    loadSlicers().then(setSlicers, () => {});
    document.getElementById('jp-content')?.scrollTo(0, 0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    const offs = [onServerEvent('refresh-grid', soon), onServerEvent('folder-changed', soon), onServerEvent('categories-changed', soon)];
    window.addEventListener(LIBRARY_CHANGED, soon);
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
      window.removeEventListener(LIBRARY_CHANGED, soon);
    };
  }, [load]);

  if (folder === undefined) {
    return (
      <div className="jp-page__inner jp-model-page">
        <Skeleton height={420} />
      </div>
    );
  }
  if (!folder) {
    return (
      <div className="jp-page__inner jp-model-page">
        <Panel>
          <EmptyState icon={FolderOpen} title="No models in this folder" action={<Button onClick={() => navigate('library')}>Back to the Library</Button>}>
            The folder may have been moved or emptied.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  const paths = folder.files.map((file) => file.filePath);
  // Library / Toys / Robots: the folders above this one, below the library folder.
  const crumbs = folderCrumbs(folder.path, libraryRoots).slice(0, -1);
  const showFolder = () => showInLibrary(() => filterActions.setDirectory(folderFilterFor(folder.files[0].filePath)));
  const list = (items: string[], onPick?: (item: string) => void) => (
    <span className="jp-details__categories">
      {items.map((item) =>
        onPick ? (
          <button key={item} type="button" className="jp-chip" onClick={() => onPick(item)}>
            {item}
          </button>
        ) : (
          <span key={item} className="jp-chip">
            {item}
          </span>
        )
      )}
    </span>
  );
  const facts = [`${folder.files.length} ${folder.files.length === 1 ? 'file' : 'files'}`, folder.size ? formatFileSize(folder.size) : '']
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="jp-page__inner jp-model-page jp-folder-page" data-folder={folder.path}>
      <nav className="jp-model-page__crumbs" aria-label="Where this folder is">
        <button type="button" className="jp-model-page__back" onClick={() => navigate('library')}>
          <ArrowLeft size={16} aria-hidden="true" />
          Library
        </button>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="jp-model-page__crumb">
            <span aria-hidden="true">/</span>
            <button
              type="button"
              className="jp-link-button"
              title={`Show the folder ${crumb.path}`}
              onClick={() => showInLibrary(() => filterActions.setDirectory(crumb.path))}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      <header className="jp-model-page__header jp-model-page__header--page">
        <div className="jp-model-page__heading">
          <h1 className="jp-page-title" id="jp-folder-title" title={folder.path}>
            {folder.name}
          </h1>
          <div className="jp-model-page__byline jp-model-page__facts">
            {folder.designers.slice(0, 3).map((name) => (
              <button key={name} type="button" className="jp-link-button" onClick={() => showInLibrary(() => filterActions.setValue('designer', name))}>
                By {name}
              </button>
            ))}
            {folder.categories.length ? (
              <button type="button" className="jp-link-button" onClick={() => showCategory(folder.categories[0])}>
                {folder.categories[0]}
              </button>
            ) : null}
            <span className="jp-model-page__fact">{facts}</span>
          </div>
        </div>
        <div className="jp-model-page__toolbar" id="jp-folder-actions">
          <Button
            variant="primary"
            id="jp-folder-slicer"
            title={slicers[0] ? `Open every file in ${slicers[0].name}` : 'Set up a slicer first'}
            onClick={() => void (slicers[0] ? sendToSlicer(paths, slicers[0]) : offerSlicerSettings())}
          >
            Open All in Slicer
          </Button>
          {paths.filter(isPreviewablePath).length > 1 && (
            <Button icon={Boxes} id="jp-folder-assembly" onClick={() => window.openAssembly?.(folder.path)}>
              Assembly View
            </Button>
          )}
          {canEdit && (
            <Button icon={FolderPlus} onClick={() => window.openAddToCollection?.(paths)}>
              Add to Collection
            </Button>
          )}
          <Button icon={Library} onClick={showFolder}>
            Show in Library
          </Button>
        </div>
      </header>

      <div className="jp-model-page__grid">
        <div className="jp-model-page__main">
          <Pictures files={folder.files} />
          <FolderNotes folder={folder} onSaved={load} />
          {/* The folder is the model here: it may become a model folder whatever is in it. */}
          <ModelMediaSection key={folder.path} folder={folder.path} alone />
          <section className="jp-model-page__files" aria-labelledby="jp-folder-files">
            <h2 className="jp-panel-title" id="jp-folder-files">
              Files
            </h2>
            <ul className="jp-model-page__file-rows" id="jp-folder-file-grid">
              {folder.files.map((file) => (
                <FileRow key={file.filePath} file={file} current={false} />
              ))}
            </ul>
          </section>
        </div>

        <aside className="jp-model-page__side">
          <section className="jp-card jp-model-page__panel" aria-labelledby="jp-folder-details">
            <h2 className="jp-panel-title" id="jp-folder-details">
              Details
            </h2>
            <div className="jp-props">
              {folder.designers.length > 0 && (
                <Prop label={folder.designers.length === 1 ? 'Designer' : 'Designers'}>
                  {list(folder.designers, (name) => showInLibrary(() => filterActions.setValue('designer', name)))}
                </Prop>
              )}
              {folder.licenses.length > 0 && <Prop label="License">{folder.licenses.join(', ')}</Prop>}
              {folder.tags.length > 0 && <Prop label="Tags">{list(folder.tags, (name) => showInLibrary(() => filterActions.setTags([name])))}</Prop>}
              {folder.categories.length > 0 && <Prop label="Category">{list(folder.categories, showCategory)}</Prop>}
              {folder.sources.length > 0 && (
                <Prop label="Source">
                  {folder.sources.map((source) =>
                    /^https?:\/\//i.test(source) ? (
                      <a key={source} href={source} target="_blank" rel="noopener noreferrer">
                        {source.replace(/^https?:\/\/(www\.)?/i, '')}
                      </a>
                    ) : (
                      <span key={source}>{source}</span>
                    )
                  )}
                </Prop>
              )}
              <Prop label="Folder" title={folder.path}>
                <span className="jp-model-page__folder">
                  <button type="button" className="jp-link-button" title={`Show the folder ${folder.path}`} onClick={showFolder}>
                    …/{folder.name}
                  </button>
                  <IconButton
                    size="sm"
                    icon={Copy}
                    label="Copy the folder's full path"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(folder.path);
                      } catch {
                        await showMessage('Folder', folder.path);
                      }
                    }}
                  />
                </span>
              </Prop>
            </div>
            <p className="jp-meta jp-model-page__empty-note">Empty fields are hidden.</p>
          </section>
          <KitChecklist target={folder.path} />
        </aside>
      </div>
    </div>
  );
}
