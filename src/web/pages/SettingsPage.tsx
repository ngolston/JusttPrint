import { useEffect, useMemo, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from '../components/Button';
import { HELP, itemsFor, settingsFor, type SettingsGroup, type SettingsItem } from '../shell/nav';
import { navigate } from '../shell/routes';
import { Tabs } from '../components/Tabs';
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

/** A settings form inside the page (its name and what it does are the group's heading, or its tab's). */
function EmbeddedSetting({ item }: { item: SettingsItem }) {
  if (!item.embed) return null;
  return (
    <section className="jp-settings-form" id={`setting-${item.id}`} aria-label={item.label}>
      <EmbeddedDialog dialogId={item.embed.dialog} opener={item.embed.open} />
    </section>
  );
}

/**
 * Which tab an address opens (#/settings/<group>, or #/settings/<form or item> inside one) and,
 * in a tab with several forms, which form: { group, form }.
 */
export function settingsView(groups: SettingsGroup[], section: string): { group: string; form: string | null } {
  const byGroup = groups.find((group) => group.id === section);
  const holder = byGroup || groups.find((group) => group.items.some((item) => item.id === section)) || groups[0];
  if (!holder) return { group: '', form: null };
  const forms = holder.items.filter((item) => item.embed);
  const named = forms.find((item) => item.id === section);
  return { group: holder.id, form: named ? named.id : forms[0]?.id || null };
}

/**
 * Settings (spec §47) in tabs: one group at a time (General, Appearance, Library, …), chosen on
 * the left (across the top on narrow screens). A group with several settings forms (Integrations:
 * Thingiverse, MakerWorld, MCP Server) shows one form at a time, with tabs for the others; its
 * tools and actions are rows under it. The forms are the dialogs, opened in place
 * (settings/EmbeddedDialog.tsx). #/settings/<group> opens a tab, #/settings/<form> that form.
 */
export function SettingsPage({ section }: { section: string }) {
  const user = useCurrentUser();
  // Viewers and editors see only what their role can use (settings change the whole server).
  const groups = useMemo(() => settingsFor(user?.role), [user?.role]);
  const view = settingsView(groups, section);
  const group = groups.find((g) => g.id === view.group);
  const forms = group ? group.items.filter((item) => item.embed) : [];
  const rows = group ? group.items.filter((item) => !item.embed) : [];
  const form = forms.find((item) => item.id === view.form) || null;

  // On narrow screens the tabs scroll sideways: keep the chosen one in view.
  useEffect(() => {
    const tab = document.getElementById(`settings-tab-${view.group}`);
    const strip = tab?.closest('.jp-settings-index');
    if (tab && strip && strip.scrollWidth > strip.clientWidth) {
      strip.scrollTo({ left: tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2, behavior: 'smooth' });
    }
  }, [view.group]);

  // A new tab or form starts at the top. A form named in the address is shown for a moment when
  // the page opens on it (a link such as Open MakerWorld Settings), not on every tab click.
  const arriving = useRef(true);
  useEffect(() => {
    const highlight = arriving.current;
    arriving.current = false;
    const timer = setTimeout(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused && focused.closest('.jp-settings-panel')) focused.blur();
      document.querySelector('.jp-page')?.scrollTo({ top: 0 });
      const named = highlight && section && document.getElementById(`setting-${section}`);
      if (named && view.form === section && forms.length > 1) {
        named.classList.add('is-highlighted');
        setTimeout(() => named.classList.remove('is-highlighted'), 2500);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [section]);

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
        <nav className="jp-settings-index" aria-label="Settings">
          <ul role="tablist" aria-label="Settings groups" aria-orientation="vertical" id="jp-settings-tabs">
            {groups.map((g) => (
              <li key={g.id} role="presentation">
                <button
                  type="button"
                  role="tab"
                  id={`settings-tab-${g.id}`}
                  aria-selected={g.id === view.group}
                  aria-controls={`settings-${g.id}`}
                  className={cx('jp-settings-index__link', g.id === view.group && 'is-active')}
                  onClick={() => navigate('settings', g.id, { replace: true })}
                >
                  <g.icon size={16} aria-hidden="true" />
                  <span>{g.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {group && (
          <section
            key={group.id}
            id={`settings-${group.id}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${group.id}`}
            className="jp-card jp-settings-group jp-settings-panel"
          >
            <header className="jp-settings-group__head">
              <h2 className="jp-settings-group__title">{group.label}</h2>
              {forms.length === 1 && form && <p className="jp-settings-group__description">{form.description}</p>}
            </header>
            {forms.length > 1 && (
              <div className="jp-settings-subtabs">
                <Tabs<string>
                  label={`${group.label} settings`}
                  items={forms.map((item) => ({ id: item.id, label: item.label, icon: item.icon }))}
                  value={form?.id || ''}
                  onChange={(id) => navigate('settings', id, { replace: true })}
                />
                {form && <p className="jp-settings-group__description">{form.description}</p>}
              </div>
            )}
            {form && <EmbeddedSetting key={form.id} item={form} />}
            {rows.length > 0 && (
              <ul className="jp-settings-list">
                {rows.map((item) => (
                  <SettingsRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </section>
        )}
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
