import { describe, expect, it } from 'vitest';
import { Settings, Sparkles } from 'lucide-react';
import type { SettingsGroup } from '../shell/nav';
import { settingsView } from './SettingsPage';

const item = (id: string, embed = false) => ({
  id,
  label: id,
  description: '',
  icon: embed ? Settings : Sparkles,
  run: () => {},
  ...(embed ? { embed: { dialog: `${id}-dialog`, open: 'x' } } : {})
});
const groups: SettingsGroup[] = [
  { id: 'general', label: 'General', icon: Settings, items: [item('performance', true)] },
  { id: 'integrations', label: 'Integrations', icon: Settings, items: [item('thingiverse', true), item('makerworld', true), item('mcp', true)] },
  { id: 'advanced', label: 'Advanced', icon: Settings, items: [item('report')] }
];

describe('the Settings tabs', () => {
  it('open the group the address names, and its first form', () => {
    expect(settingsView(groups, 'integrations')).toEqual({ group: 'integrations', form: 'thingiverse' });
    expect(settingsView(groups, '')).toEqual({ group: 'general', form: 'performance' });
    expect(settingsView(groups, 'nope')).toEqual({ group: 'general', form: 'performance' });
  });

  it('open the tab of a form or row the address names', () => {
    expect(settingsView(groups, 'makerworld')).toEqual({ group: 'integrations', form: 'makerworld' });
    expect(settingsView(groups, 'report')).toEqual({ group: 'advanced', form: null });
    expect(settingsView([], 'x')).toEqual({ group: '', form: null });
  });
});
