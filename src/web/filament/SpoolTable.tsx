import { ArrowDown, ArrowUp } from 'lucide-react';
import { type Spool } from '../api';
import { formatDay } from '../units';
import { cx } from '../components/Button';
import { ColorDot } from '../components/Filament';
import { useCurrency } from './currency';
import { formatMoney, formatWeight, LOW_GRAMS, spoolWhere, type SpoolSort, type SpoolSortKey } from './format';

/*
 * The spool list as a table (docs/plan-10.1.md, Phase 4): one row per spool, columns that sort
 * when their heading is clicked (again: the other way), and the spool's name opens its panel.
 */

const COLUMNS: { key: SpoolSortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Spool' },
  { key: 'material', label: 'Material' },
  { key: 'color', label: 'Color' },
  { key: 'remaining', label: 'Left', numeric: true },
  { key: 'pct', label: '%', numeric: true },
  { key: 'place', label: 'Where' },
  { key: 'price', label: 'Price', numeric: true },
  { key: 'lastUsed', label: 'Last used' }
];

const day = (iso: string | null) => formatDay(iso);

export function SpoolTable({
  spools,
  sort,
  onSort,
  onOpen
}: {
  spools: Spool[];
  sort: SpoolSort;
  onSort: (sort: SpoolSort) => void;
  onOpen: (spool: Spool) => void;
}) {
  const currency = useCurrency();
  const header = (key: SpoolSortKey) => {
    const active = sort.key === key;
    // Numbers sort high to low first (the fullest, the dearest), words A to Z.
    const first = COLUMNS.find((c) => c.key === key)?.numeric || key === 'lastUsed' ? 'desc' : 'asc';
    onSort({ key, dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : first });
  };
  return (
    <div className="jp-spool-table__wrap">
      <table className="jp-spool-table" id="jp-spool-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={cx(column.numeric && 'is-numeric')}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="jp-spool-table__sort" onClick={() => header(column.key)}>
                    {column.label}
                    {active && <Arrow size={12} aria-hidden="true" />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {spools.map((spool) => {
            const pct = spool.initial_weight > 0 ? Math.round((spool.remaining / spool.initial_weight) * 100) : 0;
            const low = spool.status !== 'archived' && spool.remaining < LOW_GRAMS;
            return (
              <tr key={spool.id} className={cx(spool.status === 'archived' && 'is-archived')}>
                <td>
                  <button type="button" className="jp-spool-table__name" onClick={() => onOpen(spool)}>
                    {spool.display_name}
                  </button>
                  {spool.brand_name && <span className="jp-meta"> · {spool.brand_name}</span>}
                </td>
                <td>{[spool.material, spool.material_type].filter(Boolean).join(' ')}</td>
                <td>
                  <span className="jp-spool-table__color">
                    <ColorDot color={spool.color_hex || '#9aa4b4'} size={14} />
                    {spool.color_name || spool.color_hex || ''}
                  </span>
                </td>
                <td className={cx('is-numeric', low && 'is-low')}>{formatWeight(spool.remaining)}</td>
                <td className="is-numeric">{pct}%</td>
                <td>{spoolWhere(spool)}</td>
                <td className="is-numeric">{spool.purchase_price !== null ? formatMoney(spool.purchase_price, currency) : ''}</td>
                <td>{day(spool.last_used_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
