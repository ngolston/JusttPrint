import { useEffect, useRef, useState } from 'react';
import { settings } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';
import { useCan } from './session';

declare global {
  interface Window {
    openThemeSettings?: () => void;
  }
}

const THEMES: [string, string][] = [
  ['modern-cyan', 'Modern Cyan (Default)'],
  ['modern-purple', 'Modern Purple'],
  ['modern-green', 'Modern Green'],
  ['modern-orange', 'Modern Orange'],
  ['modern-pink', 'Modern Pink'],
  ['dark-minimal', 'Dark Minimal']
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
  uiTheme: string;
  background: string;
  modelColor: string;
  lighting: boolean;
}

const DEFAULT_THEME: Theme = { uiTheme: 'modern-cyan', background: '#070147', modelColor: '#cccccc', lighting: true };

/**
 * Settings → Theme: UI accent theme, thumbnail background, and the model color and lighting
 * for thumbnails. Changing the color or lighting offers to regenerate every thumbnail.
 * Registers window.openThemeSettings.
 */
export function ThemeSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [saving, setSaving] = useState(false);
  // The UI theme is each user's own; the thumbnail colors and lighting are the server's (admins).
  const isAdmin = useCan('admin');

  useEffect(
    () =>
      exposeGlobal('openThemeSettings', () => {
        (async () => {
          const get = (key: string) => settings.get<string | null>(key).catch(() => null);
          const [uiTheme, background, modelColor, lighting] = await Promise.all(['uiTheme', 'modelBackgroundColor', 'renderColor', 'renderLighting'].map(get));
          setTheme({
            uiTheme: uiTheme || DEFAULT_THEME.uiTheme,
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
      await settings.save('uiTheme', theme.uiTheme);

      if (isAdmin) document.documentElement.style.setProperty('--model-background-color', theme.background);
      document.body.setAttribute('data-theme', theme.uiTheme);
      window.applyThemeColors?.(theme.uiTheme);
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

  const select = (key: 'uiTheme' | 'background' | 'modelColor', id: string, label: string, options: [string, string][], help: string) => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={theme[key]} disabled={key !== 'uiTheme' && !isAdmin} onChange={(event) => set(key, event.target.value)}>
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
      {select('uiTheme', 'ui-theme', 'UI Theme:', THEMES, 'The color scheme of the app, for your account only')}
      {!isAdmin && <p className="setting-description">The thumbnail colors below are the same for everyone; an admin changes them.</p>}
      {select('background', 'model-background-color', 'Model Background Color:', BACKGROUNDS, 'Background color for 3D model thumbnails')}
      <p className="setting-description theme-render-note">Note: These settings are for STLs and 3MFs without embedded data.</p>
      {select('modelColor', 'render-color', 'Model Color:', MODEL_COLORS, 'Color of the 3D model in thumbnails')}
      <div className="form-group checkbox-container theme-lighting">
        <input type="checkbox" id="render-lighting" checked={theme.lighting} disabled={!isAdmin} onChange={(event) => set('lighting', event.target.checked)} />
        <div>
          <label htmlFor="render-lighting" className="theme-lighting-label">
            Enable Advanced Lighting
          </label>
          <div className="setting-description theme-lighting-help">
            Adds ambient and directional lighting for better depth. Disabling may improve performance on lower-end devices.
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
