import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Box, CheckCircle2, ChevronDown, Clock, Copy, FolderOpen, Grid2x2, List, MoreHorizontal, Printer, Scan, SlidersHorizontal,
  Sparkles, Star, Trash2
} from 'lucide-react';
import { AddTagButton, Badge, PrintStatusBadge, StatusBadge, Tag } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { Menu } from '../components/Menu';
import { Drawer, Modal } from '../components/Overlay';
import { EmptyState, Panel, ProgressBar, Skeleton, StatCard } from '../components/Panel';
import { SearchBox, shortcutLabel } from '../components/SearchBox';
import { Tabs } from '../components/Tabs';

const HASH = '#/design-system';

/**
 * Every JusttPrint 5 component in one page, for checking them against the reference render
 * (docs/redesign-5.md, Phase 1). Open the app with #/design-system. Not linked from the UI.
 */
function Gallery() {
  const [tab, setTab] = useState<'all' | 'printed' | 'unprinted' | 'queue' | 'favorites'>('all');
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [favorite, setFavorite] = useState(true);
  const statuses = ['printed', 'unprinted', 'queued', 'printing', 'failed', 'want'];

  return (
    <div className="jp jp-gallery">
      <h1 className="jp-page-title">JusttPrint 5 components</h1>
      <p className="jp-meta">Design tokens and base components (Phase 1). Close this page by removing #/design-system from the address.</p>

      <section>
        <h2 className="jp-label">Typography</h2>
        <h1 className="jp-page-title">Good afternoon</h1>
        <h2 className="jp-section-title">Your Library</h2>
        <div><div className="jp-model-title">Gridfinity Tool Holder</div><div className="jp-meta">Zack Freedman</div></div>
        <div><button type="button" className="jp-link">View All</button></div>
      </section>

      <section>
        <h2 className="jp-label">Buttons</h2>
        <div className="jp-gallery__row">
          <Button variant="primary" size="lg" iconEnd={ChevronDown}>Open in Slicer</Button>
          <Button size="lg">Print</Button>
          <Button variant="secondary" icon={SlidersHorizontal}>Filter</Button>
          <Button variant="ghost" icon={Scan}>Scan Library</Button>
          <Button variant="danger" icon={Trash2}>Delete</Button>
          <Button variant="primary" disabled>Disabled</Button>
          <IconButton icon={Star} label={favorite ? 'Remove from favorites' : 'Add to favorites'} pressed={favorite} onClick={() => setFavorite(!favorite)} />
          <IconButton icon={MoreHorizontal} label="More actions" />
          <IconButton icon={Grid2x2} label="Grid view" />
          <IconButton icon={List} label="List view" />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Badges, status, tags</h2>
        <div className="jp-gallery__row">
          <Badge>3MF</Badge><Badge>PLA</Badge><Badge>PETG</Badge>
          {statuses.map((s) => <PrintStatusBadge key={s} status={s} />)}
          <StatusBadge tone="success">Successful</StatusBadge>
          <StatusBadge tone="danger">Failed</StatusBadge>
        </div>
        <div className="jp-gallery__row">
          <Tag>Organization</Tag><Tag>Gridfinity</Tag><Tag onRemove={() => {}}>Workshop</Tag><Tag onClick={() => {}}>Tools</Tag>
          <AddTagButton onClick={() => {}} />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Tabs and search</h2>
        <Tabs label="Library state" value={tab} onChange={setTab} items={[
          { id: 'all', label: 'All Models', icon: Grid2x2 }, { id: 'printed', label: 'Printed', icon: CheckCircle2 },
          { id: 'unprinted', label: 'Unprinted' }, { id: 'queue', label: 'Queue', icon: Clock }, { id: 'favorites', label: 'Favorites', icon: Star }
        ]} />
        <div className="jp-gallery__search">
          <SearchBox label="Search the library" placeholder="Search models, designers, tags, or anything..." shortcut={shortcutLabel(navigator.platform)} />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Cards</h2>
        <div className="jp-gallery__row">
          <StatCard icon={Box} value="2,486" label="Models" />
          <StatCard icon={CheckCircle2} value="183" label="Printed" tone="success" />
          <StatCard icon={Clock} value="12" label="In Queue" tone="warning" />
          <StatCard icon={Printer} value="4" label="Printers" tone="violet" onClick={() => {}} />
        </div>
        <div className="jp-gallery__grid">
          <Panel title="Recent Activity" action={{ label: 'View All', onClick: () => {} }} labelledBy="gallery-activity">
            <p className="jp-meta">Panel content.</p>
            <ProgressBar value={78} label="Print progress" />
          </Panel>
          <Panel title="Loading" labelledBy="gallery-loading">
            <div className="jp-gallery__stack">
              <Skeleton width="60%" /><Skeleton width="40%" height={12} /><Skeleton width="100%" height={120} radius="lg" />
            </div>
          </Panel>
          <Panel>
            <EmptyState icon={FolderOpen} title="No models yet" action={<Button variant="primary" icon={Scan}>Scan Library</Button>}>
              Add a folder under STL Home, then scan it.
            </EmptyState>
          </Panel>
          <Panel>
            <EmptyState icon={Printer} tone="danger" title="Printer unavailable" action={<Button>Retry</Button>}>
              The printer did not answer.
            </EmptyState>
          </Panel>
        </div>
      </section>

      <section>
        <h2 className="jp-label">Menu, modal, drawer</h2>
        <div className="jp-gallery__row">
          <Menu label="Model actions" items={[
            { id: 'copy', label: 'Copy path', icon: Copy, onSelect: () => {} },
            { id: 'ai', label: 'Generate Tags', icon: Sparkles, onSelect: () => {} },
            { id: 'delete', label: 'Delete from Disk', icon: Trash2, danger: true, onSelect: () => {} }
          ]} trigger={(props) => <Button {...props} iconEnd={ChevronDown}>More</Button>} />
          <Button onClick={() => setModal(true)}>Open modal</Button>
          <Button onClick={() => setDrawer(true)}>Open drawer</Button>
        </div>
      </section>

      <Modal open={modal} onClose={() => setModal(false)} title="Log Print"
        footer={<><Button onClick={() => setModal(false)}>Cancel</Button><Button variant="primary" onClick={() => setModal(false)}>Save</Button></>}>
        <p className="jp-meta">Modal content.</p>
      </Modal>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="Model details">
        <p className="jp-meta">Drawer content.</p>
      </Drawer>
    </div>
  );
}

/** Shows the gallery over the page while the address ends in #/design-system. */
export function DesignGallery() {
  const [shown, setShown] = useState(() => window.location.hash === HASH);
  useEffect(() => {
    const onHash = () => setShown(window.location.hash === HASH);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return shown ? createPortal(<Gallery />, document.body) : null;
}
