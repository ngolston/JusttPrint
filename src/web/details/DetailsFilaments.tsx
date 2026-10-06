import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { filaments as filamentApi, models, type Filament } from '../api';
import { exposeGlobal } from '../page';
import { colorCss, filamentLabel, type FilamentLike } from '../print/printStatus';
import { pickFromList } from '../components/ListPicker';

/** The model the details panel shows (only the fields this section reads). */
interface FilamentsModel {
  filePath: string;
  filaments?: FilamentLike[] | null;
}

declare global {
  interface Window {
    /** The details panel's filaments (library/details.ts and library/actions.ts drive it). */
    detailsFilaments?: {
      show: (model: FilamentsModel) => void;
      /** Reload the shown model's filaments from the server. */
      load: (filePath: string) => Promise<void>;
      clear: () => void;
      /** Reload the picker (the catalog changed). */
      reloadOptions: () => Promise<void>;
      /** Assign a filament to the shown model and save. */
      add: (id: number) => Promise<void>;
    };
  }
}

const label = (filament: FilamentLike) => filamentLabel(filament, undefined, 'Unnamed filament');
const byLabel = (a: FilamentLike, b: FilamentLike) => label(a).localeCompare(label(b));

/**
 * The details panel's filament picker and chips, rendered into #details-filaments-slot.
 * Each change saves at once. Registers window.detailsFilaments.
 */
export function DetailsFilaments() {
  const [slot] = useState(() => document.getElementById('details-filaments-slot'));
  const [filePath, setFilePath] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<FilamentLike[]>([]);
  const [catalog, setCatalog] = useState<Filament[]>([]);

  const reloadOptions = async () => {
    try {
      setCatalog(((await filamentApi.list()) || []).slice().sort(byLabel));
    } catch (error) {
      console.error('Error fetching filaments:', error);
    }
  };
  useEffect(() => { reloadOptions(); }, []);

  function show(model: FilamentsModel) {
    setFilePath(model.filePath);
    setAssigned((model.filaments || []).slice().sort(byLabel));
  }

  async function save(next: FilamentLike[]) {
    if (!filePath) return;
    setAssigned(next);
    await window.detailsHost?.saveField(filePath, 'filaments', next.map((f) => Number(f.id)));
  }

  async function add(id: number) {
    if (!id || assigned.some((f) => Number(f.id) === id)) return;
    const record = catalog.find((f) => f.id === id) || { id, name: String(id) };
    await save([...assigned, record].sort(byLabel));
  }

  useEffect(() => exposeGlobal('detailsFilaments', {
    show,
    load: async (path: string) => {
      try {
        const model = await models.get<FilamentsModel>(path);
        if (model) show({ ...model, filePath: path });
      } catch (error) {
        console.error('Error loading model filaments:', error);
      }
    },
    clear: () => {
      setFilePath(null);
      setAssigned([]);
    },
    reloadOptions,
    add
  }));

  async function pickFilament() {
    const value = await pickFromList('filament');
    if (value) await add(Number(value));
  }

  if (!slot) return null;
  const available = catalog.filter((f) => !assigned.some((a) => Number(a.id) === f.id));
  return createPortal(
    <div className="form-group">
      <label>Filament:</label>
      <div className="tags-container">
        <div className="tags-input-container">
          <select id="filament-select" value="" onChange={(e) => add(Number(e.target.value))}>
            <option value="">Select a filament...</option>
            {available.map((f) => <option key={f.id} value={String(f.id)}>{label(f)}</option>)}
          </select>
          <button type="button" className="list-button icon-button" title="Search existing filaments" onClick={pickFilament}>☰</button>
          <button type="button" id="add-filament-button" className="icon-button" title="Filament Manager"
            onClick={() => window.openFilamentManager?.()}>+</button>
        </div>
        <div id="model-filaments" className="tags-list">
          {assigned.map((f) => (
            <div key={String(f.id)} className="filament-chip" data-filament-id={String(f.id)} title={label(f)}>
              <span className="filament-swatch" style={{ background: colorCss(f.color_hex) }} />
              <span className="filament-chip-text">{label(f)}</span>
              <span className="filament-chip-remove" role="button" aria-label={`Remove ${label(f)}`} onClick={() => save(assigned.filter((a) => a !== f))}>×</span>
              <button type="button" className="filament-chip-open" aria-label="Open the Filament Manager" title="Open the Filament Manager"
                onClick={() => window.openFilamentManager?.()}>›</button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    slot
  );
}
