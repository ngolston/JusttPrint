import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Printer, Star } from 'lucide-react';
import { Badge, PrintStatusBadge, StatusBadge, Tag, printStatusInfo } from './Badge';
import { Button, IconButton } from './Button';
import { menuSide, nextMenuIndex } from './Menu';
import { EmptyState, Panel, ProgressBar, StatCard } from './Panel';
import { SearchBox, shortcutLabel } from './SearchBox';
import { Tabs, nextTabIndex } from './Tabs';

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
