import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  FolderOpen,
  Grid2x2,
  List,
  MoreHorizontal,
  Printer,
  Scan,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2
} from 'lucide-react';
import { AddTagButton, Badge, PrintStatusBadge, StatusBadge, Tag } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { Menu } from '../components/Menu';
import { Drawer, Modal } from '../components/Overlay';
import { EmptyState, Panel, ProgressBar, Skeleton, StatCard } from '../components/Panel';
import { SearchBox, shortcutLabel } from '../components/SearchBox';
import { Tabs } from '../components/Tabs';
import { BentoGrid, Tile, TileFigure } from '../components/Bento';
import { BrowseCard, CategoryTabs, SortTabs, Toggle } from '../components/Browse';
import { ColorDot, FilamentCheck, FitBadge, IsoThumb, SpoolRing, type FilamentNeed } from '../components/Filament';
import { PictureGallery, ProfilePicker } from '../components/ModelParts';

const HASH = '#/design-system';

// Sample data for the gallery only (the app never shows made-up figures).
const SPOOLS = [
  { name: 'PLA Blue', color: '#2f6fdf', grams: 720 },
  { name: 'PETG Gray', color: '#8b8f96', grams: 640 },
  { name: 'PLA White', color: '#f5f5f0', grams: 260 },
  { name: 'PLA Black', color: '#111111', grams: 18 }
];
const CATEGORIES = [
  { id: 'all', name: 'All', color: '#8b8f96' },
  { id: 'toys', name: 'Toys & Games', color: '#2f9e44' },
  { id: 'household', name: 'Household', color: '#8b8f96' },
  { id: 'printer', name: '3D Printer', color: '#e8732c' },
  { id: 'art', name: 'Art', color: '#d4a640' },
  { id: 'tools', name: 'Tools', color: '#2f6fdf' },
  { id: 'fashion', name: 'Fashion', color: '#f472b6' }
];
const NEEDS: FilamentNeed[] = [
  { label: 'Gray PETG', color: '#8b8f96', grams: 82, spool: { name: 'Bambu PETG HF Gray', where: 'AMS A1', remaining: 640 } },
  { label: 'Black PLA', color: '#111111', grams: 30, spool: { name: 'Bambu PLA Basic Black', where: 'AMS A4', remaining: 18 } },
  { label: 'Silk Gold', color: '#d4a640', grams: 12, spool: null }
];

/**
 * Every component in one page, for checking them against the mockups (docs/design-bento.md,
 * docs/design/). Open the app with #/design-system. Not linked from the UI.
 */
function Gallery() {
  const [tab, setTab] = useState<'all' | 'printed' | 'unprinted' | 'queue' | 'favorites'>('all');
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [favorite, setFavorite] = useState(true);
  const statuses = ['printed', 'unprinted', 'queued', 'printing', 'failed', 'want'];
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState<'for-you' | 'newest' | 'most-printed' | 'never'>('for-you');
  const [fits, setFits] = useState(false);
  const [profile, setProfile] = useState('plate-1');
  const [picture, setPicture] = useState('cover');

  return (
    <div className="jp jp-gallery">
      <h1 className="jp-display">JusttPrint components</h1>
      <p className="jp-meta">
        Design tokens and components in the Bento look (docs/design-bento.md). The figures are samples. Close this page by removing #/design-system from the
        address.
      </p>

      <section>
        <h2 className="jp-label">Typography</h2>
        <h1 className="jp-page-title">Good afternoon</h1>
        <h2 className="jp-section-title">Your Library</h2>
        <div>
          <div className="jp-model-title">Gridfinity Tool Holder</div>
          <div className="jp-meta">Zack Freedman</div>
        </div>
        <div>
          <button type="button" className="jp-link">
            View All
          </button>
        </div>
      </section>

      <section>
        <h2 className="jp-label">Buttons</h2>
        <div className="jp-gallery__row">
          <Button variant="primary" size="lg" iconEnd={ChevronDown}>
            Open in Slicer
          </Button>
          <Button size="lg">Print</Button>
          <Button variant="secondary" icon={SlidersHorizontal}>
            Filter
          </Button>
          <Button variant="ghost" icon={Scan}>
            Scan Library
          </Button>
          <Button variant="danger" icon={Trash2}>
            Delete
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <IconButton icon={Star} label={favorite ? 'Remove from favorites' : 'Add to favorites'} pressed={favorite} onClick={() => setFavorite(!favorite)} />
          <IconButton icon={MoreHorizontal} label="More actions" />
          <IconButton icon={Grid2x2} label="Grid view" />
          <IconButton icon={List} label="List view" />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Badges, status, tags</h2>
        <div className="jp-gallery__row">
          <Badge>3MF</Badge>
          <Badge>PLA</Badge>
          <Badge>PETG</Badge>
          {statuses.map((s) => (
            <PrintStatusBadge key={s} status={s} />
          ))}
          <StatusBadge tone="success">Successful</StatusBadge>
          <StatusBadge tone="danger">Failed</StatusBadge>
        </div>
        <div className="jp-gallery__row">
          <Tag>Organization</Tag>
          <Tag>Gridfinity</Tag>
          <Tag onRemove={() => {}}>Workshop</Tag>
          <Tag onClick={() => {}}>Tools</Tag>
          <AddTagButton onClick={() => {}} />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Tabs and search</h2>
        <Tabs
          label="Library state"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'all', label: 'All Models', icon: Grid2x2 },
            { id: 'printed', label: 'Printed', icon: CheckCircle2 },
            { id: 'unprinted', label: 'Unprinted' },
            { id: 'queue', label: 'Queue', icon: Clock },
            { id: 'favorites', label: 'Favorites', icon: Star }
          ]}
        />
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
              <Skeleton width="60%" />
              <Skeleton width="40%" height={12} />
              <Skeleton width="100%" height={120} radius="lg" />
            </div>
          </Panel>
          <Panel>
            <EmptyState
              icon={FolderOpen}
              title="No models yet"
              action={
                <Button variant="primary" icon={Scan}>
                  Scan Library
                </Button>
              }
            >
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
        <h2 className="jp-label">Bento grid and tiles</h2>
        <BentoGrid label="Sample dashboard">
          <Tile variant="ink" title="Printing now" col={1} row={1} cols={2} rows={2} action={<span className="jp-meta jp-gallery__on-ink">Bambu P1S</span>}>
            <div className="jp-gallery__row">
              <SpoolRing color="#e8604c" remaining={620} capacity={1000} size={84} onInk name="Progress" />
              <TileFigure value="Flangia_P1-X1" label="Zack Freedman" />
            </div>
            <div className="jp-gallery__row">
              {SPOOLS.map((s) => (
                <SpoolRing key={s.name} color={s.color} remaining={s.grams} size={40} onInk name={s.name} />
              ))}
            </div>
          </Tile>
          <Tile variant="accent" title="Needs you" col={3} row={1}>
            <TileFigure value="2" label="Black PLA is 12 g short for Screen Bezel" size="lg" />
          </Tile>
          <Tile
            title="Spools"
            col={4}
            row={1}
            rows={2}
            action={
              <button type="button" className="jp-link">
                All 24
              </button>
            }
          >
            <TileFigure value="18.6 kg" />
            {SPOOLS.map((s) => (
              <div key={s.name} className="jp-gallery__spool">
                <SpoolRing color={s.color} remaining={s.grams} />
                <span>{s.name}</span>
                <strong>{s.grams} g</strong>
              </div>
            ))}
          </Tile>
          <Tile title="Up next" col={3} row={2}>
            <div className="jp-gallery__row">
              <IsoThumb color="#8b8f96" size={64} ground={false} />
              <div>
                <div className="jp-model-title">Screen Bezel</div>
                <div className="jp-meta">Plate 1 · 3 h 40 min</div>
              </div>
            </div>
            <div className="jp-gallery__row">
              <ColorDot color="#8b8f96" size={18} name="Gray PETG" />
              <ColorDot color="#111111" size={18} short name="Black PLA" />
            </div>
          </Tile>
          <Tile variant="quiet" title="Other printers" cols={2}>
            <p className="jp-meta">Ender 3 S1 · free</p>
          </Tile>
          <Tile title="This month" cols={2}>
            <TileFigure value="1.4 kg" label="filament used" />
          </Tile>
        </BentoGrid>
      </section>

      <section>
        <h2 className="jp-label">Filament</h2>
        <div className="jp-gallery__row">
          {[28, 40, 64, 84].map((size) => (
            <SpoolRing key={size} color="#2f6fdf" remaining={720} size={size} name="PLA Blue" />
          ))}
          <SpoolRing color="#f5f5f0" remaining={260} size={64} name="PLA White" />
          <SpoolRing color="#111111" remaining={18} size={64} name="PLA Black" />
          <ColorDot color="#2f9e44" name="Green" />
          <ColorDot color="#111111" short name="Black" />
          <FitBadge missing={[]} />
          <FitBadge missing={['black']} />
        </div>
        <div className="jp-gallery__grid">
          <FilamentCheck needs={NEEDS} />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Library browse</h2>
        <CategoryTabs
          categories={CATEGORIES}
          value={category}
          onChange={setCategory}
          subcategoryHeading={category === 'all' ? 'Popular in your library' : CATEGORIES.find((c) => c.id === category)?.name}
          subcategories={['Never printed', 'Multicolor', 'Under 1 hour', 'From MakerWorld']}
        />
        <SortTabs
          label="Sort"
          value={sort}
          onChange={setSort}
          items={[
            { id: 'for-you', label: 'For you' },
            { id: 'newest', label: 'Newest' },
            { id: 'most-printed', label: 'Most printed' },
            { id: 'never', label: 'Never printed' }
          ]}
          end={
            <>
              <Toggle checked={fits} onChange={setFits} label="Fits my filament" />
              <span className="jp-meta">3 models</span>
            </>
          }
        />
        <div className="jp-gallery__cards">
          <BrowseCard
            href={HASH}
            title="Dragon Egg Box"
            designer="Zack Freedman"
            source="Printables"
            colors={[
              { color: '#d4a640', name: 'gold' },
              { color: '#111111', name: 'black' }
            ]}
            favorite
            plates="1 plate"
            grams={104}
            seconds={18000}
          />
          <BrowseCard
            href={HASH}
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
          <BrowseCard
            href={HASH}
            title="Wave Vase"
            designer="Designer B"
            source="Upload"
            colors={[{ color: '#2f6fdf', name: 'blue' }]}
            plates="Vase mode"
            grams={96}
            seconds={19800}
          />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Model page</h2>
        <div className="jp-gallery__model">
          <PictureGallery
            value={picture}
            onChange={setPicture}
            badge="Drag to rotate · 3D"
            pictures={[
              { id: 'cover', label: 'Cover', color: '#8b8f96' },
              { id: 'plate-1', label: 'Plate 1 · Frame', color: '#5a5f68' },
              { id: 'plate-2', label: 'Plate 2 · Clips', color: '#d23b3b' }
            ]}
          />
          <ProfilePicker
            value={profile}
            onChange={setProfile}
            profiles={[
              { id: 'all', name: 'All plates', meta: '5 h 55 min · 189 g' },
              { id: 'plate-1', name: 'Plate 1 · Frame', meta: '3 h 40 min · 112 g' },
              { id: 'plate-2', name: 'Plate 2 · Clips', meta: '2 h 15 min · 77 g' }
            ]}
          />
        </div>
      </section>

      <section>
        <h2 className="jp-label">Menu, modal, drawer</h2>
        <div className="jp-gallery__row">
          <Menu
            label="Model actions"
            items={[
              { id: 'copy', label: 'Copy path', icon: Copy, onSelect: () => {} },
              { id: 'ai', label: 'Generate Tags', icon: Sparkles, onSelect: () => {} },
              { id: 'delete', label: 'Delete from Disk', icon: Trash2, danger: true, onSelect: () => {} }
            ]}
            trigger={(props) => (
              <Button {...props} iconEnd={ChevronDown}>
                More
              </Button>
            )}
          />
          <Button onClick={() => setModal(true)}>Open modal</Button>
          <Button onClick={() => setDrawer(true)}>Open drawer</Button>
        </div>
      </section>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Log Print"
        footer={
          <>
            <Button onClick={() => setModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setModal(false)}>
              Save
            </Button>
          </>
        }
      >
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
