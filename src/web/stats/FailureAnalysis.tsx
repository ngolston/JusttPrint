import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { callAction } from '../api';
import { EmptyState, Panel } from '../components/Panel';
import { percent } from './scale';

/** One group's prints and failures (src/core/failure-analysis.js). */
interface Group {
  label: string;
  prints: number;
  failed: number;
  rate: number;
}
interface Analysis {
  total: number;
  failed: number;
  rate: number;
  groups: Record<'printer' | 'material' | 'brand' | 'humidity' | 'duration' | 'timeOfDay', Group[]>;
  findings: { kind: string; label: string; text: string }[];
  humidityKnown: boolean;
}

const KINDS: [keyof Analysis['groups'], string][] = [
  ['printer', 'Printer'],
  ['material', 'Material'],
  ['brand', 'Brand'],
  ['humidity', 'AMS humidity'],
  ['duration', 'Print length'],
  ['timeOfDay', 'Started']
];

/** A group table: how many printed, how many failed, the failure rate as a bar. */
function GroupTable({ title, groups, overall }: { title: string; groups: Group[]; overall: number }) {
  return (
    <div className="jp-failures__group">
      <h3 className="jp-failures__title">{title}</h3>
      <table className="jp-failures__table">
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col">Prints</th>
            <th scope="col">Failed</th>
            <th scope="col">Failure rate</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.label} className={group.prints >= 5 && group.rate >= overall * 1.5 && group.failed >= 2 ? 'is-high' : undefined}>
              <th scope="row">{group.label}</th>
              <td>{group.prints.toLocaleString()}</td>
              <td>{group.failed.toLocaleString()}</td>
              <td>
                <span className="jp-failures__rate">
                  <span className="jp-failures__bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(group.rate * 100)}%` }} />
                  </span>
                  {percent(group.rate)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Failure analysis on the Statistics page: what failed prints had in common (printer, filament,
 * AMS humidity, length, time of day), for the period chosen; the groups that fail clearly more
 * often first, in words.
 */
export function FailureAnalysis({ months, refresh }: { months: number; refresh: unknown }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  useEffect(() => {
    let live = true;
    callAction<Analysis>('get-failure-analysis', { months }).then(
      (answer) => live && setAnalysis(answer),
      () => live && setAnalysis(null)
    );
    return () => {
      live = false;
    };
  }, [months, refresh]);
  if (!analysis) return null;
  const shown = KINDS.filter(([kind]) => analysis.groups[kind].length >= 2);
  return (
    <Panel title="Failure analysis" className="jp-stats__wide jp-failures">
      {!analysis.failed ? (
        <EmptyState icon={TriangleAlert} title="No failed prints in this period">
          When a print fails (logged as Failed, or by a Bambu printer itself), what it had in common with others shows here.
        </EmptyState>
      ) : (
        <>
          <p className="jp-meta">
            {analysis.failed.toLocaleString()} of {analysis.total.toLocaleString()} prints failed ({percent(analysis.rate)}). Cancelled prints are left out.
          </p>
          {analysis.findings.length ? (
            <ul className="jp-failures__findings" aria-label="What stands out">
              {analysis.findings.map((finding) => (
                <li key={`${finding.kind}:${finding.label}`}>
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>{finding.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="jp-failures__calm">
              Nothing stands out: no printer, filament or time fails clearly more often than the rest (or not enough prints yet).
            </p>
          )}
          <div className="jp-failures__groups">
            {shown.map(([kind, title]) => (
              <GroupTable key={kind} title={title} groups={analysis.groups[kind]} overall={analysis.rate} />
            ))}
          </div>
          {!analysis.humidityKnown && (
            <p className="jp-meta jp-stats__note">AMS humidity is kept for prints a Bambu Lab printer logs by itself, from version 10.17 on.</p>
          )}
        </>
      )}
    </Panel>
  );
}
