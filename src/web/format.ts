/** Print times and filament weights, as the cards, pages and dialogs show them. */

/** 326981 seconds → "90 h 50 min"; 2700 → "45 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const formatGrams = (grams: number | null | undefined) => (grams || grams === 0 ? `${Math.round(grams).toLocaleString()} g` : '—');
