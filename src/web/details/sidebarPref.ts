/**
 * The details sidebar switch (the library toolbar's Sidebar button), kept per person
 * (`detailsSidebar`). Off: a click on a card opens the model's page instead of the sidebar, and
 * the grid takes the sidebar's room; multi-edit and zip bundles still use the sidebar.
 */
import { useSyncExternalStore } from 'react';
import { settings } from '../api';
import { hideDetailsPanels } from './visibility';

const KEY = 'detailsSidebar';
let on = true;
const listeners = new Set<() => void>();

function apply() {
  document.body.classList.toggle('jp-no-details', !on);
  if (!on && !document.getElementById('model-details')?.classList.contains('hidden')) {
    // Only the single model's details; multi-edit and bundles keep the sidebar.
    document.getElementById('model-details')?.classList.add('hidden');
  }
  listeners.forEach((listener) => listener());
}

export const sidebarOn = () => on;

export function setSidebarOn(value: boolean) {
  if (value === on) return;
  on = value;
  if (!on) hideDetailsPanels();
  apply();
  settings.save(KEY, on ? '1' : '0').catch((error) => console.error('Error saving the sidebar setting:', error));
}

/** Read the saved choice (once, at startup). */
export async function loadSidebarPref() {
  try {
    on = (await settings.get<string | null>(KEY)) !== '0';
  } catch (_) {
    on = true;
  }
  apply();
}

export function useSidebarOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => on
  );
}
