import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { filament, type SpoolCsvPreview } from '../api';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';
import { errorText } from './SpoolDialogs';
import { formatWeight } from './format';

/*
 * Spools out and in (docs/plan-10.1.md, Phase 10). Export: CSV (for a spreadsheet, or to import
 * again) or JSON, with or without archived spools. Import: a CSV from FilamentHub, a spreadsheet or
 * another app; each column's field is guessed from its heading and can be changed; the first rows
 * show as spools before anything is added; importing the same file again adds nothing.
 */

/** Save text as a file in the browser's downloads. */
function download(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportSpoolsDialog({ onClose }: { onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [archived, setArchived] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const file = await filament.exportSpools({ format, includeArchived: archived });
      download(file.filename, file.mime, file.content);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Export spools"
      id="jp-export-spools"
      className="jp-filament-form"
      footer={
        <>
          {error && (
            <p className="jp-filament-form__error" role="alert">
              {error}
            </p>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Download} onClick={() => void run()} disabled={busy} id="jp-export-spools-run">
            Download
          </Button>
        </>
      }
    >
      <div className="jp-labels__sizes" role="radiogroup" aria-label="Format">
        <label className="jp-filament-form__check">
          <input type="radio" name="jp-export-format" checked={format === 'csv'} onChange={() => setFormat('csv')} /> CSV, for a spreadsheet or to import again
        </label>
        <label className="jp-filament-form__check">
          <input type="radio" name="jp-export-format" checked={format === 'json'} onChange={() => setFormat('json')} /> JSON, for scripts
        </label>
      </div>
      <label className="jp-filament-form__check">
        <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> With archived (used-up) spools
      </label>
    </Modal>
  );
}

export function ImportCsvDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<SpoolCsvPreview | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [result, setResult] = useState<Awaited<ReturnType<typeof filament.importCsv>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const look = async (source: string, map: (string | null)[] | null) => {
    setBusy(true);
    setError('');
    try {
      const found = await filament.previewCsv({ text: source, mapping: map });
      setPreview(found);
      setMapping(found.mapping);
    } catch (failure) {
      setError(errorText(failure));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setText(content);
    setResult(null);
    await look(content, null);
  };
  const remap = (index: number, field: string) => {
    const next = mapping.map((f, i) => (i === index ? field || null : f === field && field ? null : f));
    setMapping(next);
    void look(text, next);
  };
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await filament.importCsv({ text, mapping }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const toAdd = preview ? preview.rows - preview.already - preview.problemCount : 0;
  return (
    <Modal
      open
      onClose={onClose}
      title="Import spools from a CSV"
      id="jp-import-csv"
      className="jp-filament-form jp-filament-form--wide"
      footer={
        <>
          {error && (
            <p className="jp-filament-form__error" role="alert">
              {error}
            </p>
          )}
          <Button onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
          {!result && (
            <Button
              variant="primary"
              icon={Upload}
              onClick={() => void run()}
              disabled={busy || !preview || toAdd <= 0 || !mapping.includes('material')}
              id="jp-import-csv-run"
            >
              {toAdd > 0 ? `Import ${toAdd} ${toAdd === 1 ? 'spool' : 'spools'}` : 'Nothing to import'}
            </Button>
          )}
        </>
      }
    >
      {result ? (
        <div id="jp-import-csv-result">
          <p>
            Added {result.added} {result.added === 1 ? 'spool' : 'spools'}
            {result.placesAdded ? ` and ${result.placesAdded} ${result.placesAdded === 1 ? 'place' : 'places'}` : ''}
            {result.already ? `; ${result.already} were already here` : ''}.
          </p>
          {result.problemCount > 0 && (
            <ul className="jp-meta">
              {result.problems.map((p) => (
                <li key={p.line}>
                  Line {p.line}: {p.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <p className="jp-meta">
            A CSV from FilamentHub, a spreadsheet or another app (Export spools makes one too). Each column&apos;s heading picks its field; change any that are
            wrong. A row needs a material; weights are grams unless they say kg, lb or oz.
          </p>
          <input type="file" accept=".csv,text/csv" id="jp-import-csv-file" onChange={(event) => void choose(event.target.files?.[0])} />
          {preview && (
            <>
              <div className="jp-csv-map" id="jp-import-csv-map">
                {preview.headers.map((heading, index) => (
                  <label key={`${heading}-${index}`} className="jp-csv-map__row">
                    <span className="jp-csv-map__heading">{heading || `Column ${index + 1}`}</span>
                    <select
                      className="jp-input"
                      value={mapping[index] || ''}
                      onChange={(event) => remap(index, event.target.value)}
                      aria-label={`Field for ${heading}`}
                    >
                      <option value="">Leave out</option>
                      {Object.entries(preview.fields).map(([field, label]) => (
                        <option key={field} value={field}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="jp-meta" aria-live="polite" id="jp-import-csv-summary">
                {preview.rows} {preview.rows === 1 ? 'row' : 'rows'}
                {preview.already ? ` · ${preview.already} already here` : ''}
                {preview.problemCount ? ` · ${preview.problemCount} with a problem` : ''}
                {!mapping.includes('material') ? ' · choose the column with the material' : ''}
              </p>
              {preview.sample.length > 0 && (
                <table className="jp-csv-sample">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Brand</th>
                      <th scope="col">Material</th>
                      <th scope="col">Left</th>
                      <th scope="col">Place</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((s, index) => (
                      <tr key={index}>
                        <td>{s.name || '—'}</td>
                        <td>{s.brand_name || '—'}</td>
                        <td>{[s.material, s.material_type].filter(Boolean).join(' ')}</td>
                        <td>{formatWeight(s.remaining ?? (s.initial_weight ?? 0) - (s.used_weight ?? 0))}</td>
                        <td>{s.location || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.problems.length > 0 && (
                <ul className="jp-meta">
                  {preview.problems.slice(0, 10).map((p) => (
                    <li key={p.line}>
                      Line {p.line}: {p.error}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
