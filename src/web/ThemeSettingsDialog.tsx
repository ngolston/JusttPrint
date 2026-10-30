import { useEffect, useRef, useState } from 'react';
import { settings } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';
import { useCan } from './session';
import { applyColorScheme, schemePreference } from './startup/theme';

declare global {
  interface Window {
    openThemeSettings?: () => void;
  }
}

const SCHEMES: [string, string][] = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'Match the system (light or dark)']
];

const BACKGROUNDS: [string, string][] = [
  ['#070147', 'Dark Blue'],
  ['#1a1a1a', 'Dark Gray'],
  ['#000000', 'Black'],
  ['#1a0f3c', 'Navy Purple'],
  ['#0a0a23', 'Midnight Blue']
];

const MODEL_COLORS: [string, string][] = [
  ['#cccccc', 'Default (Light Gray)'],
  ['#333333', 'Dark Gray'],
  ['#000000', 'Black'],
  ['#ffffff', 'White'],
  ['#ff0000', 'Red'],
  ['#00ff00', 'Green'],
  ['#0000ff', 'Blue'],
  ['#ffff00', 'Yellow'],
  ['#ff00ff', 'Magenta'],
  ['#00ffff', 'Cyan'],
  ['rainbow', 'Rainbow'],
  ['pastel-rainbow', 'Pastel Rainbow']
];

interface Theme {
  colorScheme: string;
  background: string;
  modelColor: string;
  lighting: boolean;
}

const DEFAULT_THEME: Theme = { colorScheme: 'light', background: '#070147', modelColor: '#cccccc', lighting: true };

/**
 * Settings → Theme: light or dark, thumbnail background, and the model color and lighting
 * for thumbnails. Changing the color or lighting offers to regenerate every thumbnail.
 * Registers window.openThemeSettings.
 */
export function ThemeSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [saving, setSaving] = useState(false);
  // The color scheme is each user's own; the thumbnail colors and lighting are the server's (admins).
  const isAdmin = useCan('admin');

  useEffect(
    () =>
      exposeGlobal('openThemeSettings', () => {
        (async () => {
          const get = (key: string) => settings.get<string | null>(key).catch(() => null);
          const [colorScheme, background, modelColor, lighting] = await Promise.all(
            ['uiColorScheme', 'modelBackgroundColor', 'renderColor', 'renderLighting'].map(get)
          );
          setTheme({
            colorScheme: schemePreference(colorScheme),
            background: background || DEFAULT_THEME.background,
            modelColor: modelColor || DEFAULT_THEME.modelColor,
            lighting: lighting == null ? true : lighting === 'true'
          });
          if (!dialogRef.current?.open) dialogRef.current?.showModal();
        })();
      }),
    []
  );

  const set = <K extends keyof Theme>(key: K, value: Theme[K]) => setTheme((previous) => ({ ...previous, [key]: value }));

  async function save() {
    setSaving(true);
    try {
      const renderChanged =
        isAdmin && ((window.currentRenderColor || DEFAULT_THEME.modelColor) !== theme.modelColor || (window.currentRenderLighting ?? true) !== theme.lighting);
      if (isAdmin) {
        await settings.save('modelBackgroundColor', theme.background);
        await settings.save('renderColor', theme.modelColor);
        await settings.save('renderLighting', String(theme.lighting));
      }
      await settings.save('uiColorScheme', theme.colorScheme);

      if (isAdmin) document.documentElement.style.setProperty('--model-background-color', theme.background);
      applyColorScheme(theme.colorScheme);
      if (isAdmin) {
        window.currentRenderColor = theme.modelColor;
        window.currentRenderLighting = theme.lighting;
      }
      dialogRef.current?.close();

      if (
        renderChanged &&
        (await showMessage(
          'Regenerate Thumbnails?',
          'You have changed model rendering settings. Would you like to regenerate all thumbnails to apply this change?',
          ['Yes', 'No']
        )) === 'Yes'
      ) {
        await window.regenerateAllThumbnails?.();
      }
    } catch (error) {
      await showMessage('Error', `Could not save the theme: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const select = (key: 'colorScheme' | 'background' | 'modelColor', id: string, label: string, options: [string, string][], help: string) => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={theme[key]} disabled={key !== 'colorScheme' && !isAdmin} onChange={(event) => set(key, event.target.value)}>
        {options.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
      <div className="setting-description">{help}</div>
    </div>
  );

  return (
    <ModalDialog
      id="settings-dialog"
      title="Theme Settings"
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" id="save-settings" className="is-primary" disabled={saving} onClick={save}>
            Save
          </button>
          <button type="button" id="cancel-settings" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      {select('colorScheme', 'ui-color-scheme', 'Color scheme', SCHEMES, 'Light or dark, for your account only')}
      <h4 className="theme-thumbnails-heading">Thumbnails</h4>
      <p className="setting-description">For STL and 3MF files without a picture of their own.{!isAdmin && ' The same for everyone; an admin changes them.'}</p>
      {select('background', 'model-background-color', 'Thumbnail background', BACKGROUNDS, 'Background color for 3D model thumbnails')}
      {select('modelColor', 'render-color', 'Model color', MODEL_COLORS, 'Color of the 3D model in thumbnails')}
      <div className="form-group checkbox-container theme-lighting">
        <input type="checkbox" id="render-lighting" checked={theme.lighting} disabled={!isAdmin} onChange={(event) => set('lighting', event.target.checked)} />
        <div>
          <label htmlFor="render-lighting" className="theme-lighting-label">
            Advanced lighting
          </label>
          <div className="setting-description theme-lighting-help">
            Adds ambient and directional lighting for better depth. Disabling may improve performance on lower-end devices.
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
