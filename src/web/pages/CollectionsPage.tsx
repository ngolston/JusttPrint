import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FolderHeart, Pencil, Plus, Share2, Trash2, X } from 'lucide-react';
import { collections, type CollectionDetail, type CollectionModel, type CollectionSummary } from '../api';
import { StatusBadge, printStatusInfo } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { EmptyState, Skeleton } from '../components/Panel';
import { cardTitle, formatOf } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { timeAgo } from '../home/format';
import { showModelDetails } from '../library/details';
import { askText, onServerEvent, showMessage } from '../page';
import { effectiveStatus, type PrintModel } from '../print/printStatus';
import { selection } from '../selection';
import { navigate } from '../shell/routes';
import { fetchPrimaryThumbnail } from '../thumbnails/cache';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function openModel(filePath: string) {
  navigate('library');
  selection.set([filePath]);
  void showModelDetails(filePath);
}

/** Loads again when any browser changes a collection. */
function useReload(load: () => void) {
  useEffect(() => {
    load();
    return onServerEvent('collections-changed', load);
  }, [load]);
}

function Thumb({ filePath }: { filePath: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!filePath) return undefined;
    let live = true;
    fetchPrimaryThumbnail(filePath).then((thumb) => { if (live) setSrc(thumb); }, () => {});
    return () => { live = false; };
  }, [filePath]);
  return <img src={src || 'assets/3d.png'} alt="" loading="lazy" />;
}

async function newCollection() {
  const name = (await askText('New Collection', 'Name of the collection:'))?.trim();
  if (!name) return;
  try {
    const made = await collections.create(name);
    navigate('collections', String(made.id));
  } catch (error) {
    await showMessage('New Collection', errorText(error));
  }
}

function CollectionList() {
  const [list, setList] = useState<CollectionSummary[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { collections.list().then(setList, (err) => setError(errorText(err))); }, []);
  useReload(load);

  return (
    <div className="jp-page__inner jp-collections">
      <header className="jp-page__header jp-collections__header">
        <div>
          <h1 className="jp-page-title">Collections</h1>
          <p className="jp-meta">Groups of models from any folders: a project, a gift list, spare parts for a printer.</p>
        </div>
        <EditOnly><Button variant="primary" icon={Plus} id="jp-new-collection" onClick={newCollection}>New Collection</Button></EditOnly>
      </header>
      {error && <EmptyState icon={FolderHeart} title="Could not load the collections" tone="danger">{error}</EmptyState>}
      {!list && !error && <div className="jp-collections__grid">{[0, 1, 2].map((i) => <Skeleton key={i} height={220} radius="lg" />)}</div>}
      {list && list.length === 0 && (
        <EmptyState icon={FolderHeart} title="No collections yet"
          action={<EditOnly><Button variant="primary" icon={Plus} onClick={newCollection}>New Collection</Button></EditOnly>}>
          Make one here, or choose Add to Collection in a model&apos;s menu.
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <ul className="jp-collections__grid" id="jp-collection-list">
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className="jp-recent-card jp-collection-card" data-collection-id={c.id} onClick={() => navigate('collections', String(c.id))}>
                <span className="jp-recent-card__image"><Thumb filePath={c.coverPath} /></span>
                <span className="jp-recent-card__body">
                  <span className="jp-recent-card__title">{c.name}</span>
                  <span className="jp-recent-card__byline">{c.modelCount} {c.modelCount === 1 ? 'model' : 'models'} · changed {timeAgo(c.updatedAt)}</span>
                  {c.description && <span className="jp-collection-card__description">{c.description}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModelTile({ model, onRemove }: { model: CollectionModel; onRemove: () => void }) {
  const grid = model as unknown as GridModel;
  const status = printStatusInfo(effectiveStatus(model as unknown as PrintModel));
  const format = formatOf(grid);
  return (
    <li className="jp-collection-model">
      <button type="button" className="jp-recent-card" data-filepath={model.filePath} onClick={() => openModel(model.filePath)}
        title="Show in the library">
        <span className="jp-recent-card__image"><Thumb filePath={model.filePath} /></span>
        <span className="jp-recent-card__body">
          <span className="jp-recent-card__title">{cardTitle(grid)}</span>
          <span className="jp-recent-card__byline">{model.designer || ' '}</span>
          <span className="jp-model-card__badges">
            {format && <span className="jp-badge">{format}</span>}
            <StatusBadge tone={status.tone} icon={status.icon}>{status.label}</StatusBadge>
          </span>
        </span>
      </button>
      <EditOnly>
        <IconButton className="jp-collection-model__remove" icon={X} size="sm" label={`Remove ${cardTitle(grid)} from the collection`} onClick={onRemove} />
      </EditOnly>
    </li>
  );
}

function CollectionView({ id }: { id: number }) {
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { collections.get(id).then(setDetail, (err) => setError(errorText(err))); }, [id]);
  useReload(load);

  async function rename() {
    if (!detail) return;
    const name = (await askText('Rename Collection', 'New name:', detail.name))?.trim();
    if (!name || name === detail.name) return;
    try { await collections.update(id, { name }); load(); } catch (err) { await showMessage('Rename Collection', errorText(err)); }
  }

  async function describe() {
    if (!detail) return;
    const description = await askText('Description', 'What is this collection for?', detail.description);
    if (description === null) return;
    try { await collections.update(id, { description }); load(); } catch (err) { await showMessage('Description', errorText(err)); }
  }

  async function remove() {
    if (!detail) return;
    const answer = await showMessage('Delete Collection', `Delete ${detail.name}? The models stay in the library; only the collection and its share links go.`, ['Delete', 'Cancel']);
    if (answer !== 'Delete') return;
    try { await collections.remove(id); navigate('collections'); } catch (err) { await showMessage('Delete Collection', errorText(err)); }
  }

  async function take(model: CollectionModel) {
    try { await collections.take(id, [model.filePath]); load(); } catch (err) { await showMessage('Remove from Collection', errorText(err)); }
  }

  if (error) {
    return (
      <div className="jp-page__inner">
        <EmptyState icon={FolderHeart} title="This collection is not available" tone="danger"
          action={<Button icon={ArrowLeft} onClick={() => navigate('collections')}>All Collections</Button>}>{error}</EmptyState>
      </div>
    );
  }
  return (
    <div className="jp-page__inner jp-collections">
      <button type="button" className="jp-link jp-collections__back" onClick={() => navigate('collections')}>
        <ArrowLeft size={14} aria-hidden="true" /> All collections
      </button>
      <header className="jp-page__header jp-collections__header">
        <div>
          <h1 className="jp-page-title" id="jp-collection-title">{detail?.name ?? ''}</h1>
          <p className="jp-meta">
            {detail ? `${detail.models.length} ${detail.models.length === 1 ? 'model' : 'models'}` : ''}
            {detail?.createdBy ? ` · made by ${detail.createdBy}` : ''}
          </p>
          {detail?.description && <p className="jp-collections__description">{detail.description}</p>}
        </div>
        <EditOnly>
          <div className="jp-collections__tools">
            <Button icon={Share2} id="jp-share-collection" disabled={!detail} onClick={() => detail && window.openShare?.({ kind: 'collection', targetId: id }, detail.name)}>Share</Button>
            <Button icon={Pencil} onClick={rename} disabled={!detail}>Rename</Button>
            <Button onClick={describe} disabled={!detail}>Description</Button>
            <IconButton icon={Trash2} label="Delete this collection" onClick={remove} disabled={!detail} />
          </div>
        </EditOnly>
      </header>
      {!detail && <div className="jp-collections__grid">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={220} radius="lg" />)}</div>}
      {detail && detail.models.length === 0 && (
        <EmptyState icon={FolderHeart} title="Nothing in this collection yet">
          In the library, open a model&apos;s menu (right-click, or …) and choose Add to Collection. Select several models first to add them at once.
        </EmptyState>
      )}
      {detail && detail.models.length > 0 && (
        <ul className="jp-collections__grid" id="jp-collection-models">
          {detail.models.map((model) => <ModelTile key={model.id} model={model} onRemove={() => take(model)} />)}
        </ul>
      )}
    </div>
  );
}

/** Collections (#/collections) and one collection (#/collections/<id>). */
export function CollectionsPage({ section }: { section: string }) {
  const id = Number(section);
  return Number.isInteger(id) && id > 0 ? <CollectionView key={id} id={id} /> : <CollectionList />;
}
