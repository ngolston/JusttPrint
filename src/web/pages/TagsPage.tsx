import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Library, Pencil, Plus, Sparkles, Tags, Trash2 } from 'lucide-react';
import { tags as tagApi, type Tag } from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { SearchBox } from '../components/SearchBox';
import { ShowMoreButton, useShown } from '../components/ShowMore';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';
import { createTag, deleteTag, renameTag } from '../tags/manage';

const loadTags = () => tagApi.list();

export type TagSort = 'count' | 'name';

/** Search, the Unused filter and the order (most used first, or A–Z). */
export function arrangeTags(list: Tag[], search: string, sort: TagSort, unusedOnly: boolean): Tag[] {
  const term = search.trim().toLowerCase();
  return list
    .filter((tag) => (!term || tag.name.toLowerCase().includes(term)) && (!unusedOnly || !tag.model_count))
    .sort((a, b) => (sort === 'count' ? b.model_count - a.model_count : 0) || a.name.localeCompare(b.name));
}

function showModels(tag: Tag) {
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    filterActions.setTags([tag.name]);
  });
}

function TagRow({ tag, all, max }: { tag: Tag; all: Tag[]; max: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);
  const committing = useRef(false);

  async function commit() {
    if (committing.current) return;
    const name = draft.trim();
    if (name === tag.name) {
      setEditing(false);
      return;
    }
    committing.current = true;
    const done = await renameTag(all, tag, name);
    committing.current = false;
    if (!done) setDraft(tag.name);
    setEditing(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      committing.current = true;
      setDraft(tag.name);
      setEditing(false);
      queueMicrotask(() => {
        committing.current = false;
      });
    }
  }

  const share = max > 0 && tag.model_count > 0 ? Math.max(2, Math.round((tag.model_count / max) * 100)) : 0;
  return (
    <li className="jp-tag-row" data-tag-name={tag.name}>
      <div className="jp-tag-row__main">
        {editing ? (
          <input
            className="jp-tag-row__input"
            aria-label={`Rename tag ${tag.name}`}
            autoFocus
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={(event) => event.target.select()}
            onBlur={() => void commit()}
          />
        ) : (
          <button
            type="button"
            className="jp-tag-row__name"
            title={`Show models tagged ${tag.name}`}
            disabled={!tag.model_count}
            onClick={() => showModels(tag)}
          >
            <span className="jp-tag">{tag.name}</span>
          </button>
        )}
        <span className="jp-tag-row__count">
          {tag.model_count ? `${tag.model_count.toLocaleString()} ${tag.model_count === 1 ? 'model' : 'models'}` : 'Unused'}
        </span>
      </div>
      <span className="jp-tag-row__bar" aria-hidden="true">
        <span style={{ width: `${share}%` }} />
      </span>
      <span className="jp-tag-row__actions">
        <IconButton size="sm" icon={Library} label={`Show models tagged ${tag.name}`} disabled={!tag.model_count} onClick={() => showModels(tag)} />
        <IconButton
          size="sm"
          icon={Pencil}
          label={`Rename ${tag.name}`}
          onClick={() => {
            setDraft(tag.name);
            setEditing(true);
          }}
        />
        <IconButton size="sm" icon={Trash2} label={`Delete ${tag.name}`} onClick={() => void deleteTag(tag)} />
      </span>
    </li>
  );
}

/**
 * Tags (spec §40, Manage): every tag with how many models use it. Create, rename (renaming onto
 * an existing name merges, after asking), delete, and show a tag's models in the library.
 */
export function TagsPage() {
  const list = useLibraryData(loadTags);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TagSort>('count');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [newName, setNewName] = useState('');
  const shown = useMemo(() => arrangeTags(list || [], search, sort, unusedOnly), [list, search, sort, unusedOnly]);
  const page = useShown(shown, 200, `${search}|${sort}|${unusedOnly}`);
  const unused = (list || []).filter((tag) => !tag.model_count).length;
  const max = Math.max(0, ...(list || []).map((tag) => tag.model_count));

  async function add() {
    if (await createTag(newName)) setNewName('');
  }

  return (
    <div className="jp-page__inner jp-tags">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">Tags</h1>
          <p className="jp-meta">
            {list ? `${list.length} ${list.length === 1 ? 'tag' : 'tags'}${unused ? ` • ${unused} unused` : ''}` : 'Organize your models with tags.'}
          </p>
        </div>
        <Button icon={Sparkles} onClick={() => window.openAiConfig?.()}>
          AI Tagging
        </Button>
      </header>

      <div className="jp-tags__toolbar">
        <form
          className="jp-tags__create"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            id="jp-new-tag"
            className="jp-input"
            placeholder="New tag name"
            aria-label="New tag name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button type="submit" variant="primary" icon={Plus} disabled={!newName.trim()}>
            Create
          </Button>
        </form>
        <SearchBox
          className="jp-tags__search"
          label="Search tags"
          placeholder="Search tags"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="jp-chip-row" role="group" aria-label="Order">
          <button type="button" className={cx('jp-chip', sort === 'count' && 'is-selected')} aria-pressed={sort === 'count'} onClick={() => setSort('count')}>
            Most used
          </button>
          <button type="button" className={cx('jp-chip', sort === 'name' && 'is-selected')} aria-pressed={sort === 'name'} onClick={() => setSort('name')}>
            A–Z
          </button>
          <button type="button" className={cx('jp-chip', unusedOnly && 'is-selected')} aria-pressed={unusedOnly} onClick={() => setUnusedOnly(!unusedOnly)}>
            Unused <span className="jp-chip__count">{unused}</span>
          </button>
        </div>
      </div>

      {!list ? (
        <div className="jp-home__skeleton">
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : !list.length ? (
        <Panel>
          <EmptyState icon={Tags} title="No tags yet">
            Create a tag above, add tags in a model's details, or let AI Tagging suggest them.
          </EmptyState>
        </Panel>
      ) : !shown.length ? (
        <Panel>
          <EmptyState
            icon={Tags}
            title="No tags match"
            action={
              <Button
                onClick={() => {
                  setSearch('');
                  setUnusedOnly(false);
                }}
              >
                Clear search
              </Button>
            }
          >
            Try another search.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <ul className="jp-card jp-tags__list" aria-label="Tags">
            {page.shown.map((tag) => (
              <TagRow key={tag.id} tag={tag} all={list} max={max} />
            ))}
          </ul>
          <ShowMoreButton remaining={page.remaining} onClick={page.more} />
        </>
      )}
    </div>
  );
}
