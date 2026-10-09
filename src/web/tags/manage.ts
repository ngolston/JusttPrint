/**
 * Creating, renaming (renaming onto an existing name merges), and deleting tags, with the same
 * questions wherever it happens: the Tag Manager dialog and the Tags page. Each change also
 * refreshes the tag pickers and filters on the page.
 */
import { tags as tagApi, type Tag } from '../api';
import { refreshTagRelatedUi, showMessage } from '../page';

/** Asks before deleting a tag that models use. Resolves to true when it may go. */
export async function confirmTagDelete(tag: Tag, message?: string): Promise<boolean> {
  if (tag.model_count === 0 && !message) return true;
  const text = message ?? `This tag is used by ${tag.model_count} model(s). Are you sure you want to delete it?`;
  return (await showMessage('Delete Tag', text, ['Yes', 'No'])) === 'Yes';
}

export async function createTag(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    await tagApi.create(trimmed);
    await refreshTagRelatedUi();
    return true;
  } catch (error) {
    console.error('Error saving tag:', error);
    await showMessage('Error', 'Failed to create tag');
    return false;
  }
}

export async function deleteTag(tag: Tag, message?: string): Promise<boolean> {
  if (!(await confirmTagDelete(tag, message))) return false;
  try {
    await tagApi.remove(tag.id);
    await refreshTagRelatedUi();
    return true;
  } catch (error) {
    console.error('Error deleting tag:', error);
    await showMessage('Error', 'Failed to delete tag');
    return false;
  }
}

/** The tag a new name would merge into (same name, any case), if any. */
export function mergeTarget(all: Tag[], tag: Tag, name: string): Tag | undefined {
  const wanted = name.trim().toLowerCase();
  return all.find((item) => item.id !== tag.id && item.name.toLowerCase() === wanted);
}

/** Rename, merge into an existing tag of that name (after asking), or delete when the name is cleared. */
export async function renameTag(all: Tag[], tag: Tag, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) {
    const message = tag.model_count > 0 ? `This tag is used by ${tag.model_count} model(s). Delete "${tag.name}"?` : `Delete the tag "${tag.name}"?`;
    return deleteTag(tag, message);
  }
  const existing = mergeTarget(all, tag, trimmed);
  if (existing) {
    const answer = await showMessage(
      'Merge Tags',
      `A tag named "${existing.name}" already exists. Merge "${tag.name}" into "${existing.name}"? Models that had either tag will keep "${existing.name}".`,
      ['Merge', 'Cancel']
    );
    if (answer !== 'Merge') return false;
  }
  try {
    await tagApi.rename(tag.id, trimmed);
    await refreshTagRelatedUi();
    return true;
  } catch (error) {
    console.error('Error updating tag:', error);
    await showMessage('Error', 'Failed to update tag');
    return false;
  }
}
