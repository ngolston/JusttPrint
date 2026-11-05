import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    /** Open the Quick Start Guide at its first page. */
    showGuide?: () => void;
  }
}

interface GuidePage {
  title: string;
  content: ReactNode;
  image: string;
}

const PAGES: GuidePage[] = [
  {
    title: 'Your Models',
    content: (
      <>
        <p>
          The sidebar on the left takes you everywhere: <strong>Models</strong>, <strong>Printing</strong> and <strong>Settings</strong> open a menu of their
          pages (☰ shrinks it to icons). <strong>Models</strong> shows your models as cards, with tabs for <strong>All Models</strong>,{' '}
          <strong>Printed</strong>, <strong>Unprinted</strong>, <strong>Queue</strong> and <strong>Favorites</strong>.
        </p>
        <p>
          JusttPrint scans your <strong>STL Home</strong> folders on its own. Add or change them under <strong>Settings → Scanning → STL Home</strong>, and use{' '}
          <strong>Tools → Scan Library</strong> on the Models page to scan right away.
        </p>
      </>
    ),
    image: 'guide/guide-library.png'
  },
  {
    title: 'Model Details',
    content: (
      <>
        <p>
          Click a card to see the model on the right: a large preview (<strong>3D</strong> opens it in 3D), its tags, <strong>Open in Slicer</strong>,{' '}
          <strong>Log Print</strong>, and its details, notes and print history. Every field saves as you change it.
        </p>
        <p>Ctrl/⌘-click or Shift-click several cards to edit them together. Right-click a card, or press the Menu key, for more actions.</p>
      </>
    ),
    image: 'guide/guide-details.png'
  },
  {
    title: 'Finding Models',
    content: (
      <>
        <p>
          Search from the box at the top (<strong>Ctrl/⌘ K</strong>). <strong>Filter</strong> narrows the library by folder, designer, title, license, tags,
          print status and more; the active filters show as chips you can remove.
        </p>
        <p>
          Switch between <strong>Grid</strong>, <strong>Wall</strong> and <strong>List</strong>, and open the folder panel to browse your folders.
        </p>
      </>
    ),
    image: 'guide/guide-filter.png'
  },
  {
    title: 'Printing',
    content: (
      <>
        <p>
          <strong>Home</strong> shows your figures, recent activity and printers. Under <strong>Printing</strong>, <strong>Queue</strong> lists what is
          printing, what is up next and what printed lately, and <strong>Printers</strong> keeps your printers, their web pages and maintenance reminders.
        </p>
        <p>Log a print from a card's status badge or the details panel; JusttPrint keeps a dated history for each model.</p>
      </>
    ),
    image: 'guide/guide-home.png'
  },
  {
    title: 'Settings and Tools',
    content: (
      <>
        <p>
          <strong>Tags</strong> and <strong>Duplicates</strong> (under Models) and <strong>Tools → Organize</strong> help you tidy the library, and{' '}
          <strong>Tools → AI Tagging</strong> suggests tags for you. <strong>Settings</strong> has everything else in one page: theme, scanning, slicers, AI,
          JusttPrint backend access, backups, Library Storage and more.
        </p>
        <p>
          <strong>Settings → Help</strong> lists the keyboard shortcuts and links to the documentation. Thank you for using JusttPrint!
        </p>
      </>
    ),
    image: 'guide/guide-settings.png'
  }
];

/** How long a page fades out before the next one shows (base.css fades it back in). */
const FADE_MS = 400;

/**
 * Settings → Help → Quick Start Guide, also shown after the first-run welcome (startup/FirstRun.tsx): five
 * pages with a picture each, Back and Next (or the arrow keys). Registers window.showGuide.
 */
export function QuickStartGuide() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  const [faded, setFaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = (next: number) => {
    if (next < 0 || next >= PAGES.length) return;
    if (timer.current) clearTimeout(timer.current);
    setFaded(true);
    timer.current = setTimeout(() => {
      setPage(next);
      setFaded(false);
    }, FADE_MS);
  };

  useEffect(
    () =>
      exposeGlobal('showGuide', () => {
        if (timer.current) clearTimeout(timer.current);
        setPage(0);
        setFaded(false);
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
        dialogRef.current?.focus();
      }),
    []
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const last = page === PAGES.length - 1;
  const shown = PAGES[page];
  const close = () => dialogRef.current?.close();
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.preventDefault();
    if (event.key === 'ArrowLeft') go(page - 1);
    else if (event.key === 'ArrowRight') go(page + 1);
  };

  return (
    <dialog
      id="quickstart-guide"
      className="modal"
      style={{ width: '80%', maxWidth: 1000 }}
      tabIndex={-1}
      ref={dialogRef}
      aria-labelledby="guide-title"
      onKeyDown={onKeyDown}
    >
      <div className="guide-content">
        <div className="guide-header">
          <h2 id="guide-title">Quick Start Guide</h2>
          <div className="guide-progress">
            <div className="guide-progress-bar">
              <div className="guide-progress-fill" id="guide-progress-fill" style={{ width: `${((page + 1) / PAGES.length) * 100}%` }} />
            </div>
            <div className="guide-progress-text" id="guide-progress-text">
              Page {page + 1} of {PAGES.length}
            </div>
          </div>
        </div>
        <div className="guide-scroll-container">
          <img id="guide-image" src={shown.image} alt={shown.title} className="guide-image" style={{ opacity: faded ? 0 : 1 }} />
          <div id="guide-text" className="guide-text" style={{ opacity: faded ? 0 : 1 }}>
            <h3>{shown.title}</h3>
            {shown.content}
          </div>
        </div>
        <div className="guide-navigation">
          <button type="button" id="guide-back-button" className="guide-nav-button" disabled={page === 0} onClick={() => go(page - 1)}>
            <span className="guide-nav-icon">←</span>
            <span>Back</span>
          </button>
          <button type="button" id="guide-close-button" className="guide-nav-button guide-nav-button-secondary" onClick={close}>
            Close
          </button>
          <button type="button" id="guide-next-button" className="guide-nav-button" onClick={() => (last ? close() : go(page + 1))}>
            <span>{last ? 'Finish' : 'Next'}</span>
            {!last && <span className="guide-nav-icon">→</span>}
          </button>
        </div>
      </div>
    </dialog>
  );
}
