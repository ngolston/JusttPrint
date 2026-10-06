import { useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from '../components/Button';
import { HELP, SETTINGS, type SettingsItem } from '../shell/nav';

/** One row: icon, name, what it does; the whole row opens it. */
export function SettingsRow({ item }: { item: SettingsItem }) {
  const Icon = item.icon;
  return (
    <li>
      <button type="button" className={cx('jp-settings-row', item.danger && 'is-danger')} onClick={item.run}>
        <span className="jp-settings-row__icon"><Icon size={18} aria-hidden="true" /></span>
        <span className="jp-settings-row__text">
          <span className="jp-settings-row__label">{item.label}</span>
          <span className="jp-settings-row__description">{item.description}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="jp-settings-row__chevron" />
      </button>
    </li>
  );
}

/**
 * Settings (spec §47): every setting and tool, grouped. Rows open today's screens; Phase 11 moves
 * their contents into this page. #/settings/<group> scrolls to a group.
 */
export function SettingsPage({ section }: { section: string }) {
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);

  return (
    <div className="jp-page__inner">
      <header className="jp-page__header">
        <h1 className="jp-page-title">Settings</h1>
        <p className="jp-meta">Library, scanning, printers, AI, server and backup settings.</p>
      </header>
      <div className="jp-settings-grid">
        {SETTINGS.map((group) => (
          <section key={group.id} id={`settings-${group.id}`} className="jp-card jp-settings-group" aria-labelledby={`settings-${group.id}-title`}>
            <h2 className="jp-label" id={`settings-${group.id}-title`}>{group.label}</h2>
            <ul className="jp-settings-list">
              {group.items.map((item) => <SettingsRow key={item.id} item={item} />)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Help: the guide, shortcuts, setup docs and where to report problems. */
export function HelpList() {
  return (
    <ul className="jp-settings-list">
      {HELP.map((item) => <SettingsRow key={item.id} item={item} />)}
    </ul>
  );
}
