import { useEffect, useState } from 'react';
import { Button } from './Button';

/**
 * Long lists render a page at a time (spec §52): the first `step` items, then Show more.
 * Starts again when `resetKey` changes (a new search or filter).
 */
export function useShown<T>(items: T[], step = 200, resetKey: unknown = undefined): { shown: T[]; more: () => void; remaining: number } {
  const [limit, setLimit] = useState(step);
  useEffect(() => { setLimit(step); }, [resetKey, step]);
  return { shown: items.slice(0, limit), more: () => setLimit((value) => value + step), remaining: Math.max(0, items.length - limit) };
}

export function ShowMoreButton({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  if (remaining <= 0) return null;
  return (
    <div className="jp-show-more">
      <Button onClick={onClick}>Show more ({remaining.toLocaleString()} left)</Button>
    </div>
  );
}
