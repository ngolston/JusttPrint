import { useEffect, useRef, useState } from 'react';
import { library, type LibraryStats } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    openStats?: () => void;
  }
}

const SLICE_COLORS = ['rgba(74, 158, 255, 0.8)', 'rgba(0, 212, 255, 0.8)', 'rgba(128, 128, 128, 0.8)'];
const BAR_COLORS = ['rgba(74, 158, 255, 0.8)', 'rgba(0, 212, 255, 0.8)', 'rgba(91, 159, 255, 0.8)', 'rgba(107, 170, 255, 0.8)'];

export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

interface Slice {
  label: string;
  count: number;
  bytes: number;
}

/** Pie of model counts per file type, with a legend; hover a slice for its share and disk usage. */
function FileTypePie({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  let angle = -Math.PI / 2;
  const point = (a: number) => `${50 + 48 * Math.cos(a)} ${50 + 48 * Math.sin(a)}`;
  return (
    <div className="chart-container-small stats-pie">
      <svg viewBox="0 0 100 100" role="img" aria-label="Models by file type">
        {total === 0 ? <circle cx="50" cy="50" r="48" fill="rgba(255, 255, 255, 0.08)" /> : slices.map((slice, index) => {
          const share = slice.count / total;
          const title = `${slice.label}: ${slice.count.toLocaleString()} (${(share * 100).toFixed(1)}%) · ${formatFileSize(slice.bytes)}`;
          if (share >= 1) {
            return <circle key={slice.label} cx="50" cy="50" r="48" fill={SLICE_COLORS[index]}><title>{title}</title></circle>;
          }
          const start = angle;
          angle += share * 2 * Math.PI;
          if (share === 0) return null;
          const largeArc = share > 0.5 ? 1 : 0;
          return (
            <path key={slice.label} d={`M50 50 L${point(start)} A48 48 0 ${largeArc} 1 ${point(angle)} Z`}
              fill={SLICE_COLORS[index]} stroke="rgba(0, 0, 0, 0.25)" strokeWidth="0.5">
              <title>{title}</title>
            </path>
          );
        })}
      </svg>
      <ul className="stats-legend">
        {slices.map((slice, index) => (
          <li key={slice.label}><span className="stats-legend-swatch" style={{ background: SLICE_COLORS[index] }} />{slice.label}</li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars, 0–100%. */
function CompletionBars({ rows }: { rows: { label: string; percent: number }[] }) {
  return (
    <div className="chart-container-small stats-bars" role="img" aria-label="Metadata completion">
      {rows.map((row, index) => (
        <div key={row.label} className="stats-bar-row" title={`${row.percent.toFixed(1)}%`}>
          <span className="stats-bar-label">{row.label}</span>
          <span className="stats-bar-track">
            <span className="stats-bar-fill" style={{ width: `${Math.min(100, Math.max(0, row.percent))}%`, background: BAR_COLORS[index] }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Help → Library Stats: model counts, disk usage by file type, metadata completion and tags.
 * Registers window.openStats, which the menu and the 'open-stats' event call.
 */
export function StatsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let openCount = 0;
    return exposeGlobal('openStats', () => {
      const open = ++openCount;
      setError('');
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
      library.stats()
        .then((result) => { if (open === openCount) setStats(result); })
        .catch((reason) => { if (open === openCount) setError(`Could not load the statistics: ${reason instanceof Error ? reason.message : String(reason)}`); });
    });
  }, []);

  const types = stats?.fileTypes;
  const slices: Slice[] = types ? [
    { label: '3MF', count: types.threeMf, bytes: types.threeMfBytes || 0 },
    { label: 'STL', count: types.stl, bytes: types.stlBytes || 0 },
    ...(types.other > 0 ? [{ label: 'Other', count: types.other, bytes: types.otherBytes || 0 }] : [])
  ] : [];
  const percent = (value: string | number | undefined) => Number(value) || 0;
  const completion = [
    { label: 'Designer', percent: percent(stats?.percentages.withDesigner) },
    { label: 'Parent', percent: percent(stats?.percentages.withParentModel) },
    { label: 'License', percent: percent(stats?.percentages.withLicense) },
    { label: 'Tags', percent: percent(stats?.percentages.withTags) }
  ];
  const count = (value: number | undefined) => (value ?? 0).toLocaleString();
  const typeRow = (label: string, id: string, value: number | undefined, bytes: number | undefined) => (
    <div className="stats-row-compact">
      <span className="stats-label-small">{label}:</span>
      <span className="stats-value-small"><span id={`stats-type-${id}`}>{count(value)}</span>{' '}
        <span className="stats-bytes" id={`stats-type-${id}-bytes`}>({formatFileSize(bytes || 0)})</span></span>
    </div>
  );

  return (
    <ModalDialog id="stats-dialog" title="Library Statistics" dialogRef={dialogRef}>
      {error && <p className="setting-description" role="status">{error}</p>}
      <div className="stats-content">
        <div className="stats-grid">
          <div className="stats-section stats-summary">
            <h3>Total Models</h3>
            <div className="stats-value-large" id="stats-total-models">{count(stats?.totalModels)}</div>
            <div className="stats-subsection">
              <div className="stats-row-compact">
                <span className="stats-label-small">Archived:</span>
                <span className="stats-value-small" id="stats-archived">{count(stats?.archivedModels)}</span>
              </div>
              <div className="stats-row-compact">
                <span className="stats-label-small">Disk Usage:</span>
                <span className="stats-value-small" id="stats-total-bytes">{formatFileSize(stats?.totalBytes || 0)}</span>
              </div>
            </div>
          </div>

          <div className="stats-section stats-chart-section">
            <h3>Model Types</h3>
            {typeRow('3MF', '3mf', types?.threeMf, types?.threeMfBytes)}
            {typeRow('STL', 'stl', types?.stl, types?.stlBytes)}
            {typeRow('Other', 'other', types?.other, types?.otherBytes)}
            {stats && <FileTypePie slices={slices} />}
          </div>

          <div className="stats-section stats-chart-section">
            <h3>Metadata Completion</h3>
            {stats && <CompletionBars rows={completion} />}
            <div className="stats-grid-compact">
              {completion.map((row) => (
                <div key={row.label} className="stats-row-compact">
                  <span className="stats-label-tiny">{row.label}:</span>
                  <span className="stats-value-tiny" id={`stats-percent-${row.label.toLowerCase()}`}>{stats ? `${percent(row.percent)}%` : '0%'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="stats-section stats-tags">
            <h3>Tags</h3>
            <div className="stats-row-compact">
              <span className="stats-label-small">Total:</span>
              <span className="stats-value-small" id="stats-total-tags">{count(stats?.tags.total)}</span>
            </div>
            <div className="stats-row-compact">
              <span className="stats-label-small">Most Used:</span>
              <span className="stats-value-small" id="stats-most-used-tag">
                {!stats ? '-' : stats.tags.mostUsed ? `${stats.tags.mostUsed.name} (${stats.tags.mostUsed.count})` : 'None'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
