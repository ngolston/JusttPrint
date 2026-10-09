import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle2, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { notifications as notificationApi, type AppNotification } from '../api';
import { cx } from '../components/Button';
import { onServerEvent } from '../page';
import { appLink, badgeText, timeAgo } from './notificationText';

const LEVEL_ICONS = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: CircleAlert } as const;

/**
 * The bell in the top bar: what finished or went wrong in the background (src/server/notifications.js).
 * The JusttPrint backend pings 'notifications-changed'; the list comes from the API, so each
 * person sees what their role may. Opening the panel marks everything read. Not for guests.
 */
export function NotificationBell() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  // What was unread when the panel opened stays highlighted while it is open.
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await notificationApi.list();
      setItems(list.items || []);
      setUnread(list.unread || 0);
      return list;
    } catch (error) {
      console.warn('Could not load notifications:', error);
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    let timer = 0;
    const off = onServerEvent('notifications-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const list = (await load()) || { items, unread };
    setFresh(new Set(list.items.filter((item) => item.unread).map((item) => item.id)));
    setOpen(true);
    const newest = list.items[0]?.id;
    if (newest && list.unread > 0) {
      setUnread(0);
      notificationApi.markRead(newest).catch((error) => console.warn('Could not mark notifications read:', error));
    }
  }

  function follow(item: AppNotification) {
    const link = appLink(item.link);
    if (!link) return;
    setOpen(false);
    window.location.hash = link;
  }

  const badge = badgeText(unread);
  return (
    <div className="jp-menu-anchor jp-notify">
      <button
        type="button"
        ref={button}
        id="jp-notifications-button"
        className="jp-icon-btn jp-icon-btn--md jp-notify__button"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        title="Notifications"
        aria-expanded={open}
        aria-controls="jp-notifications"
        onClick={() => void toggle()}
      >
        <Bell size={20} aria-hidden="true" />
        {badge && (
          <span className="jp-notify__badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div
          id="jp-notifications"
          ref={panel}
          className="jp-notify__panel"
          role="dialog"
          aria-label="Notifications"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <div className="jp-notify__head">
            <h2>Notifications</h2>
          </div>
          {items.length === 0 ? (
            <p className="jp-notify__empty">Nothing yet. Finished scans and jobs, maintenance coming due and problems show up here.</p>
          ) : (
            <ul className="jp-notify__list">
              {items.map((item) => {
                const Icon = LEVEL_ICONS[item.level] || Info;
                const link = appLink(item.link);
                const content = (
                  <>
                    <Icon size={18} aria-hidden="true" className={`jp-notify__icon is-${item.level}`} />
                    <span className="jp-notify__text">
                      <span className="jp-notify__title">{item.title}</span>
                      {item.body && <span className="jp-notify__body">{item.body}</span>}
                      <span className="jp-notify__time">{timeAgo(item.createdAt)}</span>
                    </span>
                  </>
                );
                return (
                  <li key={item.id} className={cx('jp-notify__item', fresh.has(item.id) && 'is-unread')} data-notification-id={item.id}>
                    {link ? (
                      <button type="button" className="jp-notify__row" onClick={() => follow(item)}>
                        {content}
                      </button>
                    ) : (
                      <div className="jp-notify__row">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
