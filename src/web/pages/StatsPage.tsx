import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ban, BarChart3, CheckCircle2, CircleDot, CircleX, Clock, Coins, Database, FilePlus2, Printer, Table2 } from 'lucide-react';
import { statistics, type PrintStatistics } from '../api';
import { Button } from '../components/Button';
import { EmptyState, Panel, Skeleton, StatCard } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { formatMoney, formatWeight } from '../filament/format';
import { formatDuration } from '../print/printStatus';
import { findMenuAction } from '../shell/menu';
import { useLibraryData } from '../shell/libraryData';
import { labelEvery, monthLabel, monthTitle, niceMax, percent, ticks } from '../stats/scale';

const PERIODS = [
  { id: '6', label: '6 months' },
  { id: '12', label: '12 months' },
  { id: '24', label: '2 years' },
  { id: '0', label: 'All time' }
] as const;
type PeriodId = (typeof PERIODS)[number]['id'];

const PERIOD_KEY = 'justtprint.statsPeriod';

function storedPeriod(): PeriodId {
  try {
    const value = localStorage.getItem(PERIOD_KEY);
    if (PERIODS.some((period) => period.id === value)) return value as PeriodId;
  } catch {
    /* private window */
  }
  return '12';
}

/** Series of the prints chart, in fixed order (validated palette: styles/stats.css). */
const OUTCOMES = [
  { key: 'printed', label: 'Printed', color: 'var(--jp-series-1)' },
  { key: 'failed', label: 'Failed', color: 'var(--jp-series-2)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--jp-series-3)' }
] as const;

/** A month of any chart here: its key ("2026-03") and its numbers. */
type Month = { month: string };

const fmt = (n: number) => n.toLocaleString();

/** "12 h", "1,204 h", or "45 min" under an hour. */
const hoursText = (seconds: number) => (seconds >= 3600 ? `${fmt(Math.round(seconds / 3600))} h` : formatDuration(seconds));

/** Changes each time the library changes; the page loads the statistics again then. */
const changeTick = async () => Date.now();

/** Width of an element, kept up to date (charts draw in pixels so text never scales). */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

/** A bar whose top corners are rounded (the data end); the bottom stays on the baseline. */
function topRoundedBar(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.min(r, w / 2, h);
  return `M${x} ${y + h}V${y + radius}Q${x} ${y} ${x + radius} ${y}H${x + w - radius}Q${x + w} ${y} ${x + w} ${y + radius}V${y + h}Z`;
}

interface Series {
  key: string;
  label: string;
  color: string;
}

/**
 * Columns per month, stacked by series, one axis. Hover or focus a month for its numbers.
 * With one series there is no legend; the panel title names it.
 */
function MonthChart({ months, series, label, height = 220 }: { months: Month[]; series: readonly Series[]; label: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const valueOf = (month: Month, key: string) => Number((month as unknown as Record<string, number>)[key]) || 0;
  const totals = months.map((month) => series.reduce((sum, s) => sum + valueOf(month, s.key), 0));
  const top = niceMax(Math.max(0, ...totals));
  const left = 36;
  const bottom = 26;
  const plotW = Math.max(0, width - left - 4);
  const plotH = height - bottom - 8;
  const band = months.length ? plotW / months.length : 0;
  const barW = Math.max(2, Math.min(36, band * 0.62));
  const y = (value: number) => 8 + plotH - (value / top) * plotH;
  const every = labelEvery(months.length, plotW);
  const activeMonth = active == null ? null : months[active];

  return (
    <div className="jp-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ticks(top).map((tick) => (
            <g key={tick} className="jp-chart__grid">
              <line x1={left} x2={width - 4} y1={y(tick)} y2={y(tick)} />
              <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {fmt(tick)}
              </text>
            </g>
          ))}
          {months.map((month, index) => {
            const cx = left + band * index + band / 2;
            let base = 0;
            const parts = series.map((s) => ({ s, value: valueOf(month, s.key) })).filter((part) => part.value > 0);
            return (
              <g key={month.month} className={active === index ? 'is-active' : undefined}>
                {parts.map((part, partIndex) => {
                  const y0 = y(base);
                  base += part.value;
                  const y1 = y(base);
                  // 2px surface gap between stacked segments.
                  const h = Math.max(1, y0 - y1 - (partIndex > 0 ? 2 : 0));
                  const isTop = partIndex === parts.length - 1;
                  return isTop ? (
                    <path key={part.s.key} d={topRoundedBar(cx - barW / 2, y1, barW, h)} fill={part.s.color} />
                  ) : (
                    <rect key={part.s.key} x={cx - barW / 2} y={y1} width={barW} height={h} fill={part.s.color} />
                  );
                })}
                {index % every === 0 && (
                  <text className="jp-chart__x" x={cx} y={height - 8} textAnchor="middle">
                    {monthLabel(month.month, index === 0)}
                  </text>
                )}
                {/* Hit area: the whole column, wider than the bar. */}
                <rect
                  className="jp-chart__hit"
                  role="img"
                  x={left + band * index}
                  y={8}
                  width={band}
                  height={plotH}
                  tabIndex={0}
                  aria-label={`${monthTitle(month.month)}: ${series.map((s) => `${s.label} ${valueOf(month, s.key)}`).join(', ')}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                />
              </g>
            );
          })}
          <line className="jp-chart__baseline" x1={left} x2={width - 4} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      {activeMonth && active != null && (
        <div className="jp-chart__tooltip" role="presentation" style={{ left: Math.min(Math.max(8, left + band * active + band / 2), width - 8), top: 4 }}>
          <div className="jp-chart__tooltip-title">{monthTitle(activeMonth.month)}</div>
          {series.map((s) => (
            <div key={s.key} className="jp-chart__tooltip-row">
              {series.length > 1 && <span className="jp-chart__swatch" style={{ background: s.color }} />}
              <span>{s.label}</span>
              <span className="jp-chart__tooltip-value">{fmt(valueOf(activeMonth, s.key))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ series }: { series: readonly Series[] }) {
  return (
    <ul className="jp-chart__legend" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="jp-chart__swatch" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** The months as a table (for screen readers, and anyone who wants the numbers). */
function MonthTable({ months, series }: { months: Month[]; series: readonly Series[] }) {
  return (
    <div className="jp-stats__table-wrap">
      <table className="jp-stats__table">
        <thead>
          <tr>
            <th scope="col">Month</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <tr key={month.month}>
              <th scope="row">{monthTitle(month.month)}</th>
              {series.map((s) => (
                <td key={s.key}>{fmt(Number((month as unknown as Record<string, number>)[s.key]) || 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Ranked {
  key: string | number;
  label: ReactNode;
  title: string;
  value: number;
  detail?: string;
}

/** A ranked list with bars on one scale and the value written beside each. */
function RankedBars({ rows, unit, empty }: { rows: Ranked[]; unit: string; empty: string }) {
  if (!rows.length) return <p className="jp-meta jp-stats__empty">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ol className="jp-ranked">
      {rows.map((row) => (
        <li key={row.key} className="jp-ranked__row" title={`${row.title}: ${fmt(row.value)} ${unit}${row.detail ? ` · ${row.detail}` : ''}`}>
          <span className="jp-ranked__label">{row.label}</span>
          <span className="jp-ranked__track">
            <span className="jp-ranked__bar" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </span>
          <span className="jp-ranked__value">
            {fmt(row.value)}
            {row.detail && <span className="jp-ranked__detail"> · {row.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Filament used by logged prints and what it cost (docs/merge-10.md, Phase 10): only prints
 * logged with the spools they used count; cost is at each spool's price.
 */
function FilamentSection({ stats }: { stats: PrintStatistics }) {
  const use = stats.filament;
  const money = (n: number) => formatMoney(n, stats.currency);
  const priced = use.cost > 0;
  const costOf = (row: { cost: number }) => (priced && row.cost > 0 ? money(row.cost) : undefined);
  if (!use.grams) {
    return (
      <div id="jp-stats-filament">
        <Panel title="Filament used" className="jp-stats__wide">
          <EmptyState icon={CircleDot} title="No filament logged in this period">
            When you log a print with the spools it used, the grams and their cost show up here.
          </EmptyState>
        </Panel>
      </div>
    );
  }
  return (
    <section className="jp-stats__filament" id="jp-stats-filament" aria-label="Filament used">
      <div className="jp-stats__tiles">
        <StatCard icon={CircleDot} value={formatWeight(use.grams)} label="Filament used" />
        <StatCard
          icon={Coins}
          tone="violet"
          value={priced ? money(use.cost) : '—'}
          label={priced ? (use.pricedGrams < use.grams ? `Cost (${formatWeight(use.pricedGrams)} with a price)` : 'Filament cost') : 'Cost (no spool prices)'}
        />
      </div>
      <Panel title="Filament used per month (grams)" className="jp-stats__wide">
        <MonthChart
          months={use.byMonth}
          series={[{ key: 'grams', label: 'Grams', color: 'var(--jp-series-1)' }]}
          label="Grams of filament used per month"
          height={180}
        />
        <p className="jp-meta jp-stats__note">
          From prints logged with the spools they used. Cost is each print&apos;s grams at its spool&apos;s price
          {priced ? '' : '; give your spools a price to see it'}.
        </p>
      </Panel>
      <div className="jp-stats__grid">
        <Panel title="Models by filament">
          <RankedBars
            unit="g"
            empty="No model has filament logged."
            rows={use.models.map((m) => ({ key: m.id, label: m.name, title: m.filePath, value: Math.round(m.grams), detail: costOf(m) }))}
          />
        </Panel>
        <Panel title="Printers by filament">
          <RankedBars
            unit="g"
            empty="No prints are logged with a printer."
            rows={use.printers.map((p) => ({
              key: p.id ?? 'none',
              label: p.id == null ? 'Printer not chosen' : p.name || 'Unnamed printer',
              title: p.id == null ? 'Prints logged without choosing a printer' : p.name || 'Unnamed printer',
              value: Math.round(p.grams),
              detail: costOf(p)
            }))}
          />
        </Panel>
        <Panel title="Materials">
          <RankedBars
            unit="g"
            empty="No materials logged."
            rows={use.materials.map((m) => ({ key: m.material, label: m.material, title: m.material, value: Math.round(m.grams) }))}
          />
        </Panel>
      </div>
    </section>
  );
}

function StatsSkeleton() {
  return (
    <div className="jp-stats__tiles">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} height={88} radius="lg" />
      ))}
    </div>
  );
}

/**
 * Statistics (#/stats): prints per month, success rate, the designers, models and
 * printers printed most, and how the library grew. Only what the print log and library hold.
 */
export function StatsPage() {
  const [period, setPeriod] = useState<PeriodId>(storedPeriod);
  const [showTable, setShowTable] = useState(false);
  const [stats, setStats] = useState<PrintStatistics | null>(null);
  const [error, setError] = useState('');
  // Refetch when the library changes (a print logged in another tab or browser).
  const counts = useLibraryData(changeTick);
  const ticket = useRef(0);

  useEffect(() => {
    const mine = ++ticket.current;
    setError('');
    statistics
      .get(Number(period))
      .then((result) => {
        if (mine === ticket.current) setStats(result);
      })
      .catch((err) => {
        if (mine === ticket.current) setError(err instanceof Error ? err.message : String(err));
      });
    try {
      localStorage.setItem(PERIOD_KEY, period);
    } catch {
      /* private window */
    }
  }, [period, counts]);

  const totals = stats?.totals;
  const finished = totals ? totals.printed + totals.failed : 0;
  const added = stats ? stats.byMonth.reduce((sum, month) => sum + month.added, 0) : 0;
  const anyPrints = !!totals && totals.printed + totals.failed + totals.cancelled > 0;
  const periodText = period === '0' ? 'all time' : `the last ${PERIODS.find((p) => p.id === period)?.label}`;

  return (
    <div className="jp-page__inner jp-stats">
      <header className="jp-page__header jp-stats__header">
        <div>
          <h1 className="jp-page-title">Statistics</h1>
          <p className="jp-meta">
            From your print log and library, {periodText}
            {stats ? ` (${monthTitle(stats.from)} – ${monthTitle(stats.to)})` : ''}.
          </p>
        </div>
        <Tabs<PeriodId> label="Period" items={PERIODS.map((p) => ({ id: p.id, label: p.label }))} value={period} onChange={setPeriod} />
      </header>

      {error && (
        <EmptyState icon={BarChart3} title="Could not load the statistics" tone="danger">
          {error}
        </EmptyState>
      )}
      {!stats && !error && <StatsSkeleton />}

      {stats && totals && (
        <>
          <div className="jp-stats__tiles" id="jp-stats-tiles">
            <StatCard icon={Printer} value={fmt(totals.printed)} label="Prints" />
            <StatCard
              icon={CheckCircle2}
              tone="success"
              value={percent(totals.successRate)}
              label={finished ? `Success rate (${fmt(totals.printed)} of ${fmt(finished)})` : 'Success rate'}
            />
            <StatCard icon={CircleX} tone="danger" value={fmt(totals.failed)} label="Failed" />
            <StatCard icon={Ban} tone="neutral" value={fmt(totals.cancelled)} label="Cancelled" />
            <StatCard icon={FilePlus2} tone="violet" value={fmt(added)} label="Models added" />
            {totals.seconds > 0 && (
              <StatCard
                icon={Clock}
                tone="neutral"
                value={hoursText(totals.seconds)}
                label={`Print time (${fmt(totals.timedPrints)} ${totals.timedPrints === 1 ? 'print' : 'prints'} with a time)`}
              />
            )}
          </div>

          <Panel title="Prints per month" className="jp-stats__wide">
            {anyPrints ? (
              <>
                <div className="jp-stats__chart-bar">
                  <Legend series={OUTCOMES} />
                  <Button size="sm" variant="ghost" icon={Table2} aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
                    {showTable ? 'Show chart' : 'Show table'}
                  </Button>
                </div>
                {showTable ? (
                  <MonthTable months={stats.byMonth} series={OUTCOMES} />
                ) : (
                  <MonthChart months={stats.byMonth} series={OUTCOMES} label="Prints per month by outcome" />
                )}
                <p className="jp-meta jp-stats__note">
                  Success rate counts printed out of printed and failed; cancelled prints are left out. Months are in UTC.
                </p>
              </>
            ) : (
              <EmptyState icon={Printer} title="No prints logged in this period">
                Log a print from a model&apos;s menu, its details, or the Queue, and it shows up here.
              </EmptyState>
            )}
          </Panel>

          <div className="jp-stats__grid">
            <Panel title="Top designers">
              <RankedBars
                unit="prints"
                empty="No printed models with a designer yet."
                rows={stats.designers.map((d) => ({
                  key: d.name,
                  label: d.name,
                  title: d.name,
                  value: d.printed,
                  detail: `${d.models} ${d.models === 1 ? 'model' : 'models'}`
                }))}
              />
            </Panel>
            <Panel title="Most printed models">
              <RankedBars
                unit="prints"
                empty="Nothing printed yet."
                rows={stats.models.map((m) => ({ key: m.id, label: m.fileName, title: m.filePath, value: m.printed }))}
              />
            </Panel>
            <Panel title="Printers">
              <RankedBars
                unit="prints"
                empty="No prints are logged with a printer."
                rows={stats.printers.map((p) => ({
                  key: p.id ?? 'none',
                  label: p.id == null ? 'Printer not chosen' : p.name || 'Unnamed printer',
                  title: p.id == null ? 'Prints logged without choosing a printer' : p.name || 'Unnamed printer',
                  value: p.printed,
                  detail: [`${percent(p.successRate)} success`, p.seconds ? hoursText(p.seconds) : ''].filter(Boolean).join(' · ')
                }))}
              />
            </Panel>
          </div>

          {totals.seconds > 0 && (
            <Panel title="Print hours per month" className="jp-stats__wide">
              <MonthChart
                months={stats.byMonth}
                series={[{ key: 'hours', label: 'Hours', color: 'var(--jp-series-1)' }]}
                label="Hours of printing per month"
                height={180}
              />
              <p className="jp-meta jp-stats__note">From prints logged with how long they took; failed prints count too (the printer was busy).</p>
            </Panel>
          )}

          <FilamentSection stats={stats} />

          <Panel title="Models added per month" className="jp-stats__wide">
            {added > 0 ? (
              <MonthChart
                months={stats.byMonth}
                series={[{ key: 'added', label: 'Models added', color: 'var(--jp-series-1)' }]}
                label="Models added to the library per month"
                height={180}
              />
            ) : (
              <p className="jp-meta jp-stats__empty">No models were added in this period.</p>
            )}
            <div className="jp-stats__chart-bar">
              <span className="jp-meta">File types, sizes and metadata completeness are in Library Stats.</span>
              <Button
                size="sm"
                variant="ghost"
                icon={Database}
                onClick={() => {
                  void findMenuAction('Library Stats')?.();
                }}
              >
                Library Stats
              </Button>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
