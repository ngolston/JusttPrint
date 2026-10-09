import { describe, expect, it } from 'vitest';
import { appLink, badgeText, timeAgo } from './notificationText';

describe('notification bell helpers', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('says how long ago', () => {
    expect(timeAgo('2026-10-09T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-10-09T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-09T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-08T10:00:00Z', now)).toBe('yesterday');
    expect(timeAgo('2026-10-05T12:00:00Z', now)).toBe('4 days ago');
    expect(timeAgo('nonsense', now)).toBe('');
  });

  it('shows the unread count on the badge, capped', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(3)).toBe('3');
    expect(badgeText(250)).toBe('99+');
  });

  it('follows only links inside the app', () => {
    expect(appLink('#/printers/3')).toBe('#/printers/3');
    expect(appLink('#/library')).toBe('#/library');
    expect(appLink('https://example.com')).toBeNull();
    expect(appLink('javascript:alert(1)')).toBeNull();
    expect(appLink(null)).toBeNull();
  });
});
