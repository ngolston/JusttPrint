import { useMemo, useState } from 'react';
import { BookOpen, CircleDot, MapPin, Plus, Upload } from 'lucide-react';
import { filament, type FilamentSummary, type Spool } from '../api';
import { BentoGrid, Tile, TileFigure } from '../components/Bento';
import { Button, cx } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { SpoolRing } from '../components/Filament';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { useCan } from '../session';
import { useLibraryData } from '../shell/libraryData';
import { dryingProgress, formatTimeLeft, formatWeight, LOW_GRAMS, matchesFilter, matchesSearch, spoolWhere, type SpoolFilter } from '../filament/format';
import {
  CatalogDialog,
  DryDialog,
  FinishDryingDialog,
  MoveDialog,
  PlacesDialog,
  SpoolFormDialog,
  SpoolmanDialog,
  WeighDialog,
  type SpoolPreset
} from '../filament/SpoolDialogs';
import { SpoolDrawer, type SpoolAction } from '../filament/SpoolDrawer';

const loadPage = async () => {
  const [spools, summary] = await Promise.all([filament.spools(true), filament.summary()]);
  return { spools, summary };
};

type Dialog =
  | { kind: 'spool'; spool?: Spool; preset?: SpoolPreset }
  | { kind: 'weigh' | 'dry' | 'move'; spool: Spool }
  | { kind: 'finish-drying'; sessionId: number; name: string }
  | { kind: 'catalog' | 'spoolman' | 'places' };

/** "24 spools · 3 running low · 1 drying". */
function headline(summary: FilamentSummary, drying: number) {
  if (!summary.spoolCount) return 'The filament you own, how much is left, and where it is.';
  return [
    `${summary.spoolCount} ${summary.spoolCount === 1 ? 'spool' : 'spools'}`,
    summary.lowCount ? `${summary.lowCount} running low` : '',
    drying ? `${drying} drying` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

function OnHand({ summary, rows }: { summary: FilamentSummary; rows: number }) {
  const top = summary.materials[0]?.grams || 1;
  return (
    <Tile variant="ink" title="On hand" cols={2} rows={rows}>
      <div className="jp-filament__onhand">
        <TileFigure value={formatWeight(summary.grams)} label={`${summary.spoolCount} ${summary.spoolCount === 1 ? 'spool' : 'spools'}`} size="lg" />
      </div>
      {summary.colors.length > 0 && (
        <div className="jp-filament__palette" role="img" aria-label="Your colors, sized by how much of each you have">
          {summary.colors.map((c, index) => (
            <span key={`${c.color}-${index}`} style={{ flexGrow: c.grams, background: c.color }} title={`${c.name}: ${formatWeight(c.grams)}`} />
          ))}
        </div>
      )}
      <ul className="jp-filament__materials" aria-label="Grams per material">
        {summary.materials.slice(0, 6).map((m, index) => (
          <li key={m.material}>
            <span className="jp-filament__material">{m.material}</span>
            <span className="jp-filament__bar">
              <span className={cx(index === 0 && 'is-top')} style={{ width: `${Math.max(2, Math.round((m.grams / top) * 100))}%` }} />
            </span>
            <span className="jp-filament__kg">{formatWeight(m.grams)}</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

function Dryer({ spools, onFinish }: { spools: Spool[]; onFinish: (spool: Spool) => void }) {
  const canEdit = useCan('editor');
  return (
    <Tile title="Dryer" cols={2}>
      {spools.map((spool) => {
        const drying = spool.drying!;
        const progress = dryingProgress(drying.started_at, drying.target_hours);
        return (
          <div key={spool.id} className="jp-filament__drying">
            <SpoolRing
              color={spool.color_hex || '#9aa4b4'}
              remaining={progress.share * 1000}
              capacity={1000}
              size={64}
              name={`${spool.display_name}, drying`}
            />
            <div className="jp-filament__drying-text">
              <div className="jp-model-title">{spool.display_name}</div>
              <div className="jp-meta">
                {drying.drying_temp} °C · {formatTimeLeft(progress.leftMs)}
              </div>
            </div>
            {canEdit && (
              <Button size="sm" onClick={() => onFinish(spool)}>
                Finish
              </Button>
            )}
          </div>
        );
      })}
    </Tile>
  );
}

function SpoolCard({ spool, onOpen }: { spool: Spool; onOpen: () => void }) {
  const empty = spool.remaining < 50 && spool.status !== 'archived';
  return (
    <li>
      <button type="button" className={cx('jp-spool-card', empty && 'is-empty', spool.status === 'archived' && 'is-archived')} onClick={onOpen}>
        <span className="jp-spool-card__top">
          <SpoolRing color={spool.color_hex || '#9aa4b4'} remaining={spool.remaining} capacity={spool.initial_weight} size={64} />
          <span className="jp-spool-card__names">
            <span className="jp-spool-card__name">{spool.display_name}</span>
            <span className="jp-spool-card__brand">{spool.brand_name || 'No brand'}</span>
          </span>
        </span>
        <span className="jp-spool-card__grams">
          <span className={cx('jp-spool-card__left', empty && 'is-empty')}>{formatWeight(spool.remaining)}</span>
          <span className="jp-meta">of {formatWeight(spool.initial_weight)}</span>
        </span>
        <span className="jp-spool-card__pills">
          <span className="jp-pill">{spool.material_type || spool.material}</span>
          <span className="jp-pill">{spoolWhere(spool)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Filament (docs/design-bento.md, J2 · Filament; docs/merge-10.md, Phase 3): what is on hand and
 * drying, ways to add spools, and every spool with its ring. A spool opens its drawer, where it is
 * weighed, dried, moved, edited or archived. Tiles whose data comes in later phases (reorder,
 * loaded in printers, use this month) are left out until then.
 */
export function FilamentPage() {
  const data = useLibraryData(loadPage);
  const [filter, setFilter] = useState<SpoolFilter>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const spools = data?.spools;
  const summary = data?.summary;
  const drying = useMemo(() => (spools || []).filter((spool) => spool.drying && spool.status !== 'archived'), [spools]);
  const shown = useMemo(() => (spools || []).filter((spool) => matchesFilter(spool, filter) && matchesSearch(spool, search)), [spools, filter, search]);
  const materials = summary?.materials.map((m) => m.material) || [];
  const chips: [SpoolFilter, string][] = [
    ['all', 'All'],
    ['low', `Running low (under ${LOW_GRAMS} g)`],
    ...(drying.length ? [['drying', 'Drying'] as [SpoolFilter, string]] : []),
    ...materials.slice(0, 6).map((m) => [`material:${m}`, m] as [SpoolFilter, string]),
    ...(summary?.archivedCount ? [['archived', `Archived (${summary.archivedCount})`] as [SpoolFilter, string]] : [])
  ];

  const onAction = (action: SpoolAction, spool: Spool) => {
    if (action === 'edit') setDialog({ kind: 'spool', spool });
    else if (action === 'finish-drying' && spool.drying) setDialog({ kind: 'finish-drying', sessionId: spool.drying.id, name: spool.display_name });
    else if (action === 'weigh' || action === 'dry' || action === 'move') setDialog({ kind: action, spool });
  };

  const addButtons = (
    <EditOnly>
      <div className="jp-filament__add-buttons">
        <Button variant="primary" icon={BookOpen} onClick={() => setDialog({ kind: 'catalog' })} id="jp-add-from-catalog">
          Add from catalogue
        </Button>
        <Button icon={Plus} onClick={() => setDialog({ kind: 'spool' })} id="jp-add-spool">
          Add by hand
        </Button>
        <Button variant="ghost" icon={Upload} onClick={() => setDialog({ kind: 'spoolman' })} id="jp-import-spoolman">
          Import from Spoolman
        </Button>
      </div>
    </EditOnly>
  );

  return (
    <div className="jp-page__inner jp-filament">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-display">Filament</h1>
          <p className="jp-meta jp-filament__headline">
            {summary ? headline(summary, drying.length) : 'The filament you own, how much is left, and where it is.'}
          </p>
        </div>
        <EditOnly>
          <div className="jp-printers__header-actions">
            <Button icon={MapPin} onClick={() => setDialog({ kind: 'places' })} id="jp-filament-places">
              Places
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: 'spool' })}>
              Add spool
            </Button>
          </div>
        </EditOnly>
      </header>

      {!data || !summary || !spools ? (
        <div className="jp-home__skeleton">
          <Skeleton height={210} />
          <Skeleton height={120} />
        </div>
      ) : !spools.length ? (
        <Panel>
          <EmptyState icon={CircleDot} title="No spools yet" action={addButtons}>
            Pick your filament from the catalogue, type it in, or bring over your Spoolman inventory.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <BentoGrid label="Filament overview">
            {summary.spoolCount > 0 && <OnHand summary={summary} rows={drying.length ? 2 : 1} />}
            <Tile variant="quiet" title="Add a spool" cols={2}>
              <p className="jp-filament__add-text">Pick it from the filament catalogue, type it in, or bring over your Spoolman inventory.</p>
              {addButtons}
            </Tile>
            {drying.length > 0 && (
              <Dryer
                spools={drying}
                onFinish={(spool) => spool.drying && setDialog({ kind: 'finish-drying', sessionId: spool.drying.id, name: spool.display_name })}
              />
            )}
          </BentoGrid>

          <section className="jp-filament__all" aria-labelledby="jp-filament-all">
            <div className="jp-filament__toolbar">
              <h2 className="jp-section-title" id="jp-filament-all">
                All spools
              </h2>
              <div className="jp-filament__chips" role="group" aria-label="Show">
                {chips.map(([id, label]) => (
                  <button key={id} type="button" className={cx('jp-chip', filter === id && 'is-on')} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <input
                className="jp-input jp-filament__search"
                type="search"
                aria-label="Search spools"
                placeholder="Search spools"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {shown.length ? (
              <ul className="jp-filament__grid" aria-label="Spools">
                {shown.map((spool) => (
                  <SpoolCard key={spool.id} spool={spool} onOpen={() => setOpenId(spool.id)} />
                ))}
              </ul>
            ) : (
              <p className="jp-meta">No spools here.</p>
            )}
          </section>
        </>
      )}

      {openId !== null && <SpoolDrawer spoolId={openId} onClose={() => setOpenId(null)} onAction={onAction} />}
      {dialog?.kind === 'spool' && <SpoolFormDialog spool={dialog.spool} preset={dialog.preset} onClose={close} />}
      {dialog?.kind === 'weigh' && <WeighDialog spool={dialog.spool} onClose={close} />}
      {dialog?.kind === 'dry' && <DryDialog spool={dialog.spool} onClose={close} />}
      {dialog?.kind === 'move' && <MoveDialog spool={dialog.spool} onClose={close} />}
      {dialog?.kind === 'finish-drying' && <FinishDryingDialog sessionId={dialog.sessionId} name={dialog.name} onClose={close} />}
      {dialog?.kind === 'catalog' && <CatalogDialog onClose={close} onPicked={(preset) => setDialog({ kind: 'spool', preset })} />}
      {dialog?.kind === 'spoolman' && <SpoolmanDialog onClose={close} />}
      {dialog?.kind === 'places' && <PlacesDialog onClose={close} />}
    </div>
  );
}
