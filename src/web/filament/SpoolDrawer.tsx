import { useCallback, type ReactNode } from 'react';
import { formatDay, formatTemperature } from '../units';
import { Archive, ArchiveRestore, Droplets, ExternalLink, MapPin, Pencil, Scale, Trash2 } from 'lucide-react';
import { filament, type Spool, type SpoolDetail } from '../api';
import { Button } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { ColorDot, SpoolRing } from '../components/Filament';
import { Drawer } from '../components/Overlay';
import { Skeleton } from '../components/Panel';
import { showMessage } from '../page';
import { useLibraryData } from '../shell/libraryData';
import { useCurrency } from './currency';
import { PhotoBlock } from './Photo';
import { dryingProgress, formatMoney, formatTimeLeft, formatWeight, runsOutText, spoolWhere } from './format';

export type SpoolAction = 'edit' | 'weigh' | 'dry' | 'finish-drying' | 'move';

const day = (value: string | null | undefined) => (Number.isFinite(Date.parse(String(value || ''))) ? formatDay(value) : '');

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="jp-prop">
      <span className="jp-prop__label">{label}</span>
      <span className="jp-prop__value">{children}</span>
    </div>
  );
}

/** One spool: how much is left, where it is, its details, weighings and drying, and what to do with it. */
export function SpoolDrawer({ spoolId, onClose, onAction }: { spoolId: number; onClose: () => void; onAction: (action: SpoolAction, spool: Spool) => void }) {
  const load = useCallback(() => filament.spool(spoolId), [spoolId]);
  const spool = useLibraryData(load) as SpoolDetail | null;
  const archived = spool?.status === 'archived';
  const currency = useCurrency();

  const archive = async () => {
    if (!spool) return;
    if (!archived) {
      const answer = await showMessage('Archive spool?', `Archive ${spool.display_name}? It leaves every printer and the dryer, and shows under Archived.`, [
        'Archive',
        'Cancel'
      ]);
      if (answer !== 'Archive') return;
    }
    await filament.archive(spool.id, !archived).catch((error) => showMessage('Could not archive', error.message));
  };
  const remove = async () => {
    if (!spool) return;
    const answer = await showMessage(
      'Delete spool?',
      `Delete ${spool.display_name} with its weighings and drying? Prints that used it keep their grams. To keep it for your records, Archive it instead.`,
      ['Delete', 'Cancel']
    );
    if (answer !== 'Delete') return;
    await filament.removeSpool(spool.id).then(onClose, (error) => showMessage('Could not delete', error.message));
  };

  const progress = spool?.drying ? dryingProgress(spool.drying.started_at, spool.drying.target_hours) : null;
  const colors = spool ? [spool.color_hex, spool.color_hex_2, spool.color_hex_3, spool.color_hex_4].filter((c): c is string => !!c) : [];

  return (
    <Drawer open onClose={onClose} title={spool?.display_name || 'Spool'} className="jp-spool-drawer">
      {!spool ? (
        <Skeleton height={160} />
      ) : (
        <div className="jp-spool-detail" id="jp-spool-detail">
          <div className="jp-spool-detail__head">
            <SpoolRing color={spool.color_hex || '#9aa4b4'} remaining={spool.remaining} capacity={spool.initial_weight} size={84} name={spool.display_name} />
            <div>
              <div className="jp-spool-detail__grams">{formatWeight(spool.remaining)}</div>
              <div className="jp-meta">
                of {formatWeight(spool.initial_weight)} · {spoolWhere(spool)}
              </div>
              {spool.forecast && (
                <div className="jp-meta jp-spool-detail__forecast" id="jp-spool-forecast">
                  {runsOutText(spool.forecast)}
                </div>
              )}
              {progress && spool.drying && (
                <div className="jp-meta">
                  Drying at {formatTemperature(spool.drying.drying_temp)} · {formatTimeLeft(progress.leftMs)}
                </div>
              )}
            </div>
          </div>
          <PhotoBlock photo={spool.photo} label={spool.display_name} onSave={(photo) => filament.setSpoolPhoto(spool.id, photo)} idPrefix="jp-spool" />
          <EditOnly>
            <div className="jp-spool-detail__actions">
              {!archived && (
                <>
                  <Button variant="primary" icon={Scale} onClick={() => onAction('weigh', spool)}>
                    Weigh
                  </Button>
                  {spool.drying ? (
                    <Button icon={Droplets} onClick={() => onAction('finish-drying', spool)}>
                      Finish drying
                    </Button>
                  ) : (
                    <Button icon={Droplets} onClick={() => onAction('dry', spool)}>
                      Dry
                    </Button>
                  )}
                  <Button icon={MapPin} onClick={() => onAction('move', spool)}>
                    Move
                  </Button>
                </>
              )}
              <Button icon={Pencil} onClick={() => onAction('edit', spool)}>
                Edit
              </Button>
              <Button icon={archived ? ArchiveRestore : Archive} onClick={() => void archive()}>
                {archived ? 'Bring back' : 'Archive'}
              </Button>
              <Button variant="danger" icon={Trash2} onClick={() => void remove()}>
                Delete
              </Button>
            </div>
          </EditOnly>
          <div className="jp-spool-detail__props">
            {spool.brand_name && <Prop label="Brand">{spool.brand_name}</Prop>}
            <Prop label="Material">{[spool.material, spool.material_type].filter(Boolean).join(' · ')}</Prop>
            {colors.length > 0 && (
              <Prop label="Color">
                <span className="jp-spool-detail__colors">
                  {colors.map((color) => (
                    <ColorDot key={color} color={color} size={16} />
                  ))}
                  {spool.color_name || colors.join(', ')}
                </span>
              </Prop>
            )}
            {spool.profile_name && <Prop label="Filament">{spool.profile_name}</Prop>}
            {spool.spool_weight !== null && <Prop label="Empty spool">{formatWeight(spool.spool_weight)}</Prop>}
            {spool.purchase_price !== null && <Prop label="Price">{formatMoney(spool.purchase_price, currency)}</Prop>}
            {spool.supplier && <Prop label="Shop">{spool.supplier}</Prop>}
            {spool.purchase_date && <Prop label="Bought">{day(spool.purchase_date)}</Prop>}
            {spool.lot_nr && <Prop label="Lot">{spool.lot_nr}</Prop>}
            <Prop label="Added">{day(spool.registered_at)}</Prop>
            {spool.product_url && (
              <Prop label="Product">
                <a className="jp-link" href={spool.product_url} target="_blank" rel="noopener noreferrer">
                  Product page <ExternalLink size={12} aria-hidden="true" />
                </a>
              </Prop>
            )}
          </div>
          {spool.notes && <p className="jp-spool-detail__notes">{spool.notes}</p>}
          {spool.weighings.length > 0 && (
            <section aria-labelledby="jp-spool-weighings">
              <h3 className="jp-label" id="jp-spool-weighings">
                Weighings
              </h3>
              <ul className="jp-spool-detail__log">
                {spool.weighings.slice(0, 8).map((entry) => (
                  <li key={entry.id}>
                    <span>{day(entry.logged_at)}</span>
                    <strong>{formatWeight(entry.net_weight)}</strong>
                    <span className="jp-meta">{entry.notes || ''}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {spool.dryings.length > 0 && (
            <section aria-labelledby="jp-spool-dryings">
              <h3 className="jp-label" id="jp-spool-dryings">
                Drying
              </h3>
              <ul className="jp-spool-detail__log">
                {spool.dryings.slice(0, 8).map((entry) => (
                  <li key={entry.id}>
                    <span>{day(entry.started_at)}</span>
                    <strong>
                      {formatTemperature(entry.drying_temp)} · {entry.target_hours} h
                    </strong>
                    <span className="jp-meta">
                      {entry.finished_at ? '' : 'Running'}
                      {entry.humidity_before !== null || entry.humidity_after !== null
                        ? `${entry.humidity_before ?? '?'}% → ${entry.humidity_after ?? '?'}%`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
