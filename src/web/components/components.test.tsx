import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Printer, Star } from 'lucide-react';
import { Badge, PrintStatusBadge, StatusBadge, Tag, printStatusInfo } from './Badge';
import { Button, IconButton } from './Button';
import { menuSide, nextMenuIndex } from './Menu';
import { EmptyState, Panel, ProgressBar, StatCard } from './Panel';
import { SearchBox, shortcutLabel } from './SearchBox';
import { Tabs, nextTabIndex } from './Tabs';
import { BentoGrid, Tile } from './Bento';
import { BrowseCard, CategoryTabs, SortTabs, Toggle, avatarTone, initials, printedLabel } from './Browse';
import { ColorDot, FilamentCheck, FitBadge, IsoThumb, SpoolRing, checkNeed, fitLabel, isoShades, spoolLevel, spoolShare } from './Filament';
import { PictureGallery, ProfilePicker } from './ModelParts';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('buttons', () => {
  it('draws a variant and size, with icons hidden from screen readers', () => {
    const out = html(
      <Button variant="primary" size="lg" icon={Printer}>
        Open in Slicer
      </Button>
    );
    expect(out).toContain('class="jp-btn jp-btn--primary jp-btn--lg"');
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('<span>Open in Slicer</span>');
  });

  it('gives icon buttons a name, a tooltip and a pressed state', () => {
    const out = html(<IconButton icon={Star} label="Add to favorites" pressed />);
    expect(out).toContain('aria-label="Add to favorites"');
    expect(out).toContain('title="Add to favorites"');
    expect(out).toContain('aria-pressed="true"');
    expect(html(<IconButton icon={Star} label="More" />)).not.toContain('aria-pressed');
  });
});

describe('status', () => {
  it('always pairs a status color with an icon and a word', () => {
    const out = html(<StatusBadge tone="danger">Failed</StatusBadge>);
    expect(out).toContain('jp-status--danger');
    expect(out).toContain('<svg');
    expect(out).toContain('Failed');
  });

  it('maps print statuses, reading unknown ones as Unprinted', () => {
    expect(printStatusInfo('printed')).toMatchObject({ tone: 'success', label: 'Printed' });
    expect(printStatusInfo('Queued')).toMatchObject({ tone: 'warning', label: 'In Queue' });
    expect(printStatusInfo('printing')).toMatchObject({ tone: 'accent' });
    expect(printStatusInfo('failed')).toMatchObject({ tone: 'danger' });
    expect(printStatusInfo(null).label).toBe('Unprinted');
    expect(printStatusInfo('nonsense').label).toBe('Unprinted');
    expect(html(<PrintStatusBadge status="queued" />)).toContain('In Queue');
  });

  it('draws badges and removable tags with a named remove button', () => {
    expect(html(<Badge>3MF</Badge>)).toBe('<span class="jp-badge">3MF</span>');
    expect(html(<Tag onRemove={() => {}}>Workshop</Tag>)).toContain('aria-label="Remove Workshop"');
  });
});

describe('cards and progress', () => {
  it('labels a panel by its title and shows its action', () => {
    const out = html(
      <Panel title="Recent Activity" labelledBy="act" action={{ label: 'View All', onClick: () => {} }}>
        x
      </Panel>
    );
    expect(out).toContain('aria-labelledby="act"');
    expect(out).toContain('id="act"');
    expect(out).toContain('View All');
  });

  it('makes a stat a button only when it does something', () => {
    expect(html(<StatCard icon={Printer} value="4" label="Printers" />)).not.toContain('<button');
    expect(html(<StatCard icon={Printer} value="4" label="Printers" onClick={() => {}} />)).toContain('<button');
  });

  it('reports progress to screen readers and clamps it', () => {
    const out = html(<ProgressBar value={150} label="Storage" />);
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="100"');
    expect(out).toContain('width:100%');
    expect(html(<ProgressBar value={26} max={0} label="x" />)).toContain('width:26%');
  });

  it('announces error states', () => {
    expect(html(<EmptyState icon={Printer} tone="danger" title="Printer unavailable" />)).toContain('role="alert"');
    expect(html(<EmptyState icon={Printer} title="No models yet" />)).not.toContain('role="alert"');
  });
});

describe('keyboard', () => {
  it('moves between tabs with arrows, wrapping, and Home/End', () => {
    expect(nextTabIndex('ArrowRight', 4, 5)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 5)).toBe(4);
    expect(nextTabIndex('End', 1, 5)).toBe(4);
    expect(nextTabIndex('a', 1, 5)).toBe(-1);
  });

  it('marks only the selected tab as focusable', () => {
    const out = html(
      <Tabs
        label="State"
        value="b"
        onChange={() => {}}
        items={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' }
        ]}
      />
    );
    expect(out).toContain('role="tablist"');
    expect(out.match(/tabindex="0"/g)).toHaveLength(1);
    expect(out).toContain('aria-selected="true"');
  });

  it('opens a menu on the side with room', () => {
    expect(menuSide('end', { left: 40, right: 130 }, 200, 1536)).toBe('start');
    expect(menuSide('end', { left: 1300, right: 1400 }, 200, 1536)).toBe('end');
    expect(menuSide('start', { left: 1450, right: 1500 }, 200, 1536)).toBe('end');
    expect(menuSide('start', { left: 40, right: 130 }, 200, 1536)).toBe('start');
  });

  it('skips disabled menu items', () => {
    const items = [{}, { disabled: true }, {}];
    expect(nextMenuIndex('ArrowDown', 0, items)).toBe(2);
    expect(nextMenuIndex('ArrowDown', 2, items)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, items)).toBe(2);
    expect(nextMenuIndex('Home', -1, [{ disabled: true }, {}])).toBe(1);
    expect(nextMenuIndex('ArrowDown', 0, [{ disabled: true }])).toBe(-1);
  });
});

describe('search', () => {
  it('shows the platform shortcut and names the field', () => {
    expect(shortcutLabel('MacIntel')).toBe('⌘ K');
    expect(shortcutLabel('Win32')).toBe('Ctrl K');
    const out = html(<SearchBox label="Search the library" shortcut="⌘ K" />);
    expect(out).toContain('aria-label="Search the library"');
    expect(out).toContain('⌘ K');
  });
});

describe('Bento tiles', () => {
  it('places a tile by column and row and names it after its heading', () => {
    const out = html(
      <BentoGrid label="Dashboard">
        <Tile variant="ink" title="Printing now" col={1} row={1} cols={2} rows={2} />
        <Tile variant="quiet" cols={2} />
      </BentoGrid>
    );
    expect(out).toContain('class="jp-bento"');
    expect(out).toContain('aria-label="Printing now"');
    expect(out).toContain('jp-tile jp-tile--ink');
    expect(out).toContain('grid-column:1 / span 2;grid-row:1 / span 2');
    expect(out).toContain('grid-column:span 2');
    expect(out).toContain('<h2 class="jp-tile__heading">Printing now</h2>');
  });
});

describe('filament pieces', () => {
  it('reads a spool as empty under 50 g, low under 300 g', () => {
    expect(spoolLevel(18)).toBe('empty');
    expect(spoolLevel(50)).toBe('low');
    expect(spoolLevel(299)).toBe('low');
    expect(spoolLevel(300)).toBe('ok');
    expect(spoolShare(250, 1000)).toBe(0.25);
    expect(spoolShare(1200, 1000)).toBe(1);
    expect(spoolShare(-5, 1000)).toBe(0);
    expect(spoolShare(10, 0)).toBe(0);
  });

  it('draws a spool ring filled to its share, named when it has a name', () => {
    const out = html(<SpoolRing color="#2f6fdf" remaining={720} name="PLA Blue" />);
    expect(out).toContain('jp-spool-ring--ok');
    expect(out).toContain('--jp-ring-share:259deg');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="PLA Blue, 720 g left of 1,000 g"');
    expect(html(<SpoolRing color="#111" remaining={18} />)).toContain('aria-hidden="true"');
  });

  it('rings a short color dot and says so', () => {
    expect(html(<ColorDot color="#111111" short name="Black" />)).toContain('aria-label="Black, short"');
    expect(html(<ColorDot color="#111111" short name="Black" />)).toContain('is-short');
    expect(html(<ColorDot color="#111111" />)).toContain('aria-hidden="true"');
  });

  it('shades the placeholder art from one color', () => {
    const s = isoShades('#2f6fdf');
    expect(s.left).toBe('#2f6fdf');
    expect(s.top).not.toBe(s.left);
    expect(s.right).not.toBe(s.left);
    expect(isoShades('nonsense').left).toBe('#8b8f96');
    expect(html(<IsoThumb color="#2f6fdf" second="#ffffff" />).match(/<path/g)).toHaveLength(6);
  });

  it('says Ready to print, or which colors are needed, with an icon', () => {
    expect(fitLabel([])).toBe('Ready to print');
    expect(fitLabel(['black', 'white'])).toBe('Need black, white');
    const out = html(<FitBadge missing={['black']} />);
    expect(out).toContain('jp-fit--short');
    expect(out).toContain('<svg');
  });

  it('checks each needed color against its spool', () => {
    const spool = { name: 'Black', remaining: 18 };
    expect(checkNeed({ label: 'Black PLA', color: '#111', grams: 30, spool })).toEqual({ ok: false, grams: 12, text: '12 g short' });
    expect(checkNeed({ label: 'Gray PETG', color: '#888', grams: 82, spool: { name: 'Gray', remaining: 640 } })).toEqual({
      ok: true,
      grams: 558,
      text: '✓ 558 g left'
    });
    expect(checkNeed({ label: 'Gold', color: '#d4a640', grams: 12, spool: null }).text).toBe('12 g short');
    expect(checkNeed({ label: 'Blue', color: '#2f6fdf', grams: null, spool: { name: 'Blue', remaining: 300 } })).toEqual({
      ok: true,
      grams: 0,
      text: '✓ on hand'
    });
    expect(checkNeed({ label: 'Blue', color: '#2f6fdf', grams: null, spool: null }).ok).toBe(false);
    const out = html(<FilamentCheck needs={[{ label: 'Black PLA', color: '#111', grams: 30, spool: { ...spool, where: 'AMS A4' } }]} />);
    expect(out).toContain('Black PLA · 30 g');
    expect(out).toContain('Black · AMS A4 · 18 g');
    expect(out).toContain('jp-filament-check__row is-short');
  });
});

describe('browse pieces', () => {
  it('makes initials and keeps a designer on one avatar color', () => {
    expect(initials('Zack Freedman')).toBe('ZF');
    expect(initials('Hugo')).toBe('H');
    expect(initials('  ')).toBe('?');
    expect(avatarTone('Hugo')).toBe(avatarTone('Hugo'));
    expect(printedLabel(0)).toBe('Not yet');
    expect(printedLabel(3)).toBe('Printed 3×');
  });

  it('draws a browse card as one link with the filament check and stats', () => {
    const out = html(
      <BrowseCard
        href="#/model/1"
        title="Screen Bezel"
        designer="Bambu Lab"
        source="MakerWorld"
        colors={[
          { color: '#8b8f96', name: 'gray' },
          { color: '#111111', name: 'black', short: true }
        ]}
        plates="2 plates"
        printed={3}
        grams={189}
        seconds={21300}
      />
    );
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).not.toContain('<button');
    expect(out).toContain('href="#/model/1"');
    expect(out).toContain('Need black');
    expect(out).toContain('Printed 3×');
    expect(out).toContain('189 g');
    expect(out).toContain('5 h 55 min');
    expect(out).toContain('aria-label="Not a favorite"');
  });

  it('marks the chosen category and shows its subcategories', () => {
    const out = html(
      <CategoryTabs
        categories={[
          { id: 'all', name: 'All', color: '#888888' },
          { id: 'art', name: 'Art', color: '#d4a640' }
        ]}
        value="art"
        onChange={() => {}}
        subcategoryHeading="Art"
        subcategories={['Sculptures', 'Vases']}
      />
    );
    expect(out).toContain('aria-label="Categories"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toContain('Sculptures');
  });

  it('draws sort tabs as pressed buttons, or as a tab list', () => {
    const items = [
      { id: 'new', label: 'Newest' },
      { id: 'top', label: 'Most printed' }
    ];
    const buttons = html(<SortTabs label="Sort" items={items} value="top" onChange={() => {}} />);
    expect(buttons).toContain('role="group"');
    expect(buttons).toContain('aria-pressed="true"');
    const tabs = html(<SortTabs label="Details" mode="tabs" items={items} value="top" onChange={() => {}} />);
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('tabindex="-1"');
  });

  it('draws a switch with its state', () => {
    const out = html(<Toggle checked label="Fits my filament" onChange={() => {}} />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('Fits my filament');
  });
});

describe('model page pieces', () => {
  it('marks the chosen print profile', () => {
    const out = html(
      <ProfilePicker
        value="b"
        onChange={() => {}}
        profiles={[
          { id: 'a', name: 'All plates' },
          { id: 'b', name: 'Plate 1', meta: '3 h · 112 g' }
        ]}
      />
    );
    expect(out).toContain('jp-profile is-on');
    expect(out).toContain('3 h · 112 g');
  });

  it('shows the chosen picture and a thumbnail strip', () => {
    const out = html(
      <PictureGallery
        value="b"
        onChange={() => {}}
        pictures={[
          { id: 'a', label: 'Cover', src: '/a.png' },
          { id: 'b', label: 'Plate 1', color: '#8b8f96' }
        ]}
      />
    );
    expect(out).toContain('jp-pictures__caption">Plate 1');
    expect(out).toContain('aria-label="Cover"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html(<PictureGallery value="x" onChange={() => {}} pictures={[]} />)).toBe('');
  });
});
