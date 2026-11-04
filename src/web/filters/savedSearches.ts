/**
 * Saved searches: the library's current filters saved as a smart collection (Collections page),
 * and a saved one shown in the library again.
 */
import { collections } from '../api';
import { askText, showMessage } from '../page';
import { navigate } from '../shell/routes';
import { savedSearch, serverFilters } from './query';
import { applyFilterChange } from './search';
import { filterActions, getFilterState } from './store';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The current search, for saving: what the library shows it with, and what the server runs. */
export function currentSearch() {
  const state = getFilterState();
  return { query: savedSearch(state), filters: serverFilters(state) };
}

/** Save Search: name the current search; it becomes a smart collection. */
export async function saveCurrentSearch() {
  const name = (await askText('Save Search', 'Name of the smart collection (it always shows the models this search finds):'))?.trim();
  if (!name) return;
  const { query, filters } = currentSearch();
  try {
    const made = await collections.createSmart(name, query, filters);
    const answer = await showMessage(
      'Search Saved',
      `${made.name} is under Collections and shows ${made.modelCount} ${made.modelCount === 1 ? 'model' : 'models'} now.`,
      ['OK', 'Open It']
    );
    if (answer === 'Open It') navigate('collections', String(made.id));
  } catch (error) {
    await showMessage('Save Search', errorText(error));
  }
}

/** Show a smart collection's search in the library. */
export function showSavedSearch(query: unknown) {
  navigate('models');
  applyFilterChange(() => filterActions.restore(query));
}
