import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from '../components/Button';
import { HELP, itemsFor, settingsFor, type SettingsItem } from '../shell/nav';
import { useCurrentUser } from '../session';
import { EmbeddedDialog } from '../settings/EmbeddedDialog';

/** One row: icon, name, what it does; the whole row opens it. */
export function SettingsRow({ item }: { item: SettingsItem }) {
  const Icon = item.icon;
  return (
    <li>
      <button type="button" className={cx('jp-settings-row', item.danger && 'is-danger')} onClick={item.run}>
        <span className="jp-settings-row__icon">
          <Icon size={18} aria-hidden="true" />
        </span>
        <span className="jp-settings-row__text">
          <span className="jp-settings-row__label">{item.label}</span>
          <span className="jp-settings-row__description">{item.description}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="jp-settings-row__chevron" />
      </button>
    </li>
  );
}

/** A settings form inside the page: its name and what it does, then the form itself. */
function EmbeddedSetting({ item }: { item: SettingsItem }) {
  const Icon = item.icon;
  if (!item.embed) return null;
  return (
    <section className="jp-settings-form" id={`setting-${item.id}`} aria-labelledby={`setting-${item.id}-title`}>
      <header className="jp-settings-form__header">
        <span className="jp-settings-row__icon">
          <Icon size={18} aria-hidden="true" />
        </span>
        <span className="jp-settings-row__text">
          <h3 className="jp-settings-form__title" id={`setting-${item.id}-title`}>
            {item.label}
          </h3>
          <span className="jp-settings-row__description">{item.description}</span>
        </span>
      </header>
      <EmbeddedDialog dialogId={item.embed.dialog} opener={item.embed.open} />
    </section>
  );
}

/**
 * Settings (spec §47): one page with every setting and tool, grouped. The settings forms are on
 * the page (the dialogs, opened in place: settings/EmbeddedDialog.tsx); tools and actions are
 * rows that open their screens. The index on the left jumps to a group; #/settings/<group>
 * opens the page at it.
 */
export function SettingsPage({ section }: { section: string }) {
  const user = useCurrentUser();
  // Viewers and editors see only what their role can use (settings change the whole server).
  const groups = useMemo(() => settingsFor(user?.role), [user?.role]);
  const [active, setActive] = useState(section || groups[0]?.id || '');

  // Opening the forms may focus their fields; keep the page at the top or the requested group.
  useEffect(() => {
    const timer = setTimeout(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused && focused.closest('.jp-settings-page')) focused.blur();
      // A group (#/settings/integrations), or one form in it (#/settings/thingiverse), shown for a moment.
      const form = section && document.getElementById(`setting-${section}`);
      const target = section && (document.getElementById(`settings-${section}`) || form);
      const page = document.querySelector('.jp-page');
      if (target) target.scrollIntoView({ block: 'start' });
      else page?.scrollTo({ top: 0 });
      if (form) {
        form.classList.add('is-highlighted');
        setTimeout(() => form.classList.remove('is-highlighted'), 2500);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [section]);

  // The index follows the group in view.
  useEffect(() => {
    const page = document.querySelector('.jp-page');
    if (!page) return undefined;
    const onScroll = () => {
      const top = page.getBoundingClientRect().top + 80;
      let current = groups[0]?.id || '';
      for (const group of groups) {
        const el = document.getElementById(`settings-${group.id}`);
        if (el && el.getBoundingClientRect().top <= top) current = group.id;
      }
      setActive(current);
    };
    page.addEventListener('scroll', onScroll, { passive: true });
    return () => page.removeEventListener('scroll', onScroll);
  }, [groups]);

  return (
    <div className="jp-page__inner jp-settings-page">
      <header className="jp-page__header">
        <h1 className="jp-page-title">Settings</h1>
        <p className="jp-meta">
          {user?.role === 'admin'
            ? 'Library, scanning, printers, AI, JusttPrint backend and backup settings.'
            : `What your account (${user?.roleLabel ?? ''}) can change. An admin manages the rest.`}
        </p>
      </header>
      <div className="jp-settings-layout">
        <nav className="jp-settings-index" aria-label="Settings groups">
          <ul>
            {groups.map((group) => (
              <li key={group.id}>
                <a
                  href={`#/settings/${group.id}`}
                  className={cx('jp-settings-index__link', active === group.id && 'is-active')}
                  aria-current={active === group.id ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    setActive(group.id);
                    document.getElementById(`settings-${group.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                  }}
                >
                  {group.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="jp-settings-groups">
          {groups.map((group) => {
            const rows = group.items.filter((item) => !item.embed);
            return (
              <section key={group.id} id={`settings-${group.id}`} className="jp-card jp-settings-group" aria-labelledby={`settings-${group.id}-title`}>
                <h2 className="jp-settings-group__title" id={`settings-${group.id}-title`}>
                  {group.label}
                </h2>
                {group.items
                  .filter((item) => item.embed)
                  .map((item) => (
                    <EmbeddedSetting key={item.id} item={item} />
                  ))}
                {rows.length > 0 && (
                  <ul className="jp-settings-list">
                    {rows.map((item) => (
                      <SettingsRow key={item.id} item={item} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Help: the guide, shortcuts, setup docs and where to report problems. */
export function HelpList() {
  const user = useCurrentUser();
  return (
    <ul className="jp-settings-list">
      {itemsFor(HELP, user?.role, 'viewer').map((item) => (
        <SettingsRow key={item.id} item={item} />
      ))}
    </ul>
  );
}
