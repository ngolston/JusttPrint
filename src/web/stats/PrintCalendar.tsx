import { Panel } from '../components/Panel';
import { formatDay } from '../units';

/** One day of the print calendar (get-print-statistics `calendar`, src/core/print-stats.js). */
export interface CalendarDay {
  day: string;
  printed: number;
  failed: number;
}

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0

/** The days in columns of weeks, Monday first; days before the first are null. */
export function calendarWeeks(days: CalendarDay[]): (CalendarDay | null)[][] {
  if (!days.length) return [];
  const cells: (CalendarDay | null)[] = [...Array<null>(weekday(days[0].day)).fill(null), ...days];
  const weeks: (CalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** 0 for none, then 1–4 by how busy the day was against the busiest one. */
export function calendarLevel(prints: number, busiest: number): number {
  if (prints <= 0 || busiest <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((prints / busiest) * 4)));
}

/** The longest run of days in a row with a print, and the run up to today (or yesterday). */
export function calendarStreaks(days: CalendarDay[]): { longest: number; current: number } {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.printed + day.failed > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  // Today may not have a print yet: the streak still counts up to yesterday.
  let i = days.length - 1;
  if (i >= 0 && days[i].printed + days[i].failed === 0) i -= 1;
  for (; i >= 0 && days[i].printed + days[i].failed > 0; i -= 1) current += 1;
  return { longest, current };
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;

/** Statistics: a year of days shaded by how many prints finished on each (failed prints too). */
export function PrintCalendar({ days }: { days: CalendarDay[] }) {
  const weeks = calendarWeeks(days);
  const busiest = Math.max(0, ...days.map((d) => d.printed + d.failed));
  const total = days.reduce((sum, d) => sum + d.printed + d.failed, 0);
  const active = days.filter((d) => d.printed + d.failed > 0).length;
  const streaks = calendarStreaks(days);
  // A month's name over the first week that starts in it.
  const monthOf = (week: (CalendarDay | null)[]) => {
    const first = week.find(Boolean);
    if (!first) return '';
    const date = new Date(`${first.day}T00:00:00Z`);
    return date.getUTCDate() <= 7 ? MONTHS[date.getUTCMonth()] : '';
  };
  const title = (d: CalendarDay) => {
    const when = formatDay(`${d.day}T12:00:00Z`);
    if (!d.printed && !d.failed) return `${when}: no prints`;
    return `${when}: ${plural(d.printed, 'print')}${d.failed ? `, ${d.failed} failed` : ''}`;
  };
  return (
    <Panel title="Print calendar" className="jp-stats__wide">
      <p className="jp-meta jp-calendar__summary" id="jp-calendar-summary">
        {total
          ? `${plural(total, 'print')} on ${plural(active, 'day')} in the last year · longest streak ${plural(streaks.longest, 'day')}${
              streaks.current > 1 ? ` · ${streaks.current} days in a row now` : ''
            }`
          : 'No prints in the last year yet.'}
      </p>
      <div className="jp-calendar" id="jp-print-calendar">
        <div className="jp-calendar__weekdays" aria-hidden="true">
          <span />
          {WEEKDAYS.map((name, i) => (
            <span key={i}>{name}</span>
          ))}
        </div>
        <div className="jp-calendar__weeks" role="img" aria-label={`Prints per day over the last year: ${plural(total, 'print')} on ${plural(active, 'day')}`}>
          {weeks.map((week, w) => (
            <div key={w} className="jp-calendar__week">
              <span className="jp-calendar__month" aria-hidden="true">
                {monthOf(week)}
              </span>
              {week.map((d, i) =>
                d ? (
                  <span
                    key={d.day}
                    className={`jp-calendar__day is-level-${calendarLevel(d.printed + d.failed, busiest)}${d.failed ? ' has-failed' : ''}`}
                    data-day={d.day}
                    title={title(d)}
                  />
                ) : (
                  <span key={`empty-${i}`} className="jp-calendar__day is-empty" />
                )
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="jp-calendar__legend" aria-hidden="true">
        <span className="jp-meta">Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`jp-calendar__day is-level-${level}`} />
        ))}
        <span className="jp-meta">More</span>
        <span className="jp-calendar__day is-level-2 has-failed" />
        <span className="jp-meta">a print failed that day</span>
      </div>
      <p className="jp-meta jp-stats__note">Days are in UTC, as the print log keeps them. Each day&apos;s prints and failures show when you point at it.</p>
    </Panel>
  );
}
