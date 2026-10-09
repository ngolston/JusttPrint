/** Pure helpers for the notification bell (Notifications.tsx). */

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}

/** The badge text: the count, "99+" above 99, nothing at 0. */
export function badgeText(unread: number): string {
  if (!(unread > 0)) return '';
  return unread > 99 ? '99+' : String(unread);
}

/** Only links inside the app (#/page...) are followed. */
export function appLink(link: string | null | undefined): string | null {
  return link && /^#\/[\w/-]*$/.test(link) ? link : null;
}
