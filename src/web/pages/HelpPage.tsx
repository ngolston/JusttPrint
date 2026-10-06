import { HelpList } from './SettingsPage';

/** Help: the Quick Start Guide, keyboard shortcuts, setup documentation, GitHub and About. */
export function HelpPage() {
  return (
    <div className="jp-page__inner jp-page__inner--narrow">
      <header className="jp-page__header">
        <h1 className="jp-page-title">Help</h1>
        <p className="jp-meta">Guides, shortcuts, and where to report a problem.</p>
      </header>
      <section className="jp-card jp-settings-group" aria-label="Help">
        <HelpList />
      </section>
    </div>
  );
}
