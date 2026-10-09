import { formatBytes } from '../shell/AppShell';

/** list-site-files (src/server/site-files.js): a Printables or Thingiverse file. */
export interface SiteFile {
  id: string;
  name: string;
  size: number | null;
  kind: string;
  /** A model file (ticked to start); G-code and project files are not. */
  model: boolean;
}

/** The files of a Printables or Thingiverse model to tick for download (Add Links). */
export function FileChecklist({
  files,
  chosen,
  onChange,
  disabled = false
}: {
  files: SiteFile[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...chosen, id])] : chosen.filter((c) => c !== id));
  return (
    <div className="jp-mw-profiles">
      <div className="jp-mw-profiles__top">
        <span className="jp-mw-profiles__count">
          Files: {chosen.length} of {files.length} chosen
        </span>
        <button type="button" className="jp-mw-profiles__all" disabled={disabled} onClick={() => onChange(files.filter((f) => f.model).map((f) => f.id))}>
          Models
        </button>
        <button type="button" className="jp-mw-profiles__all" disabled={disabled} onClick={() => onChange(files.map((f) => f.id))}>
          All
        </button>
        <button type="button" className="jp-mw-profiles__all" disabled={disabled} onClick={() => onChange([])}>
          None
        </button>
      </div>
      <ul className="jp-mw-profiles__list">
        {files.map((file) => (
          <li key={file.id}>
            <label className="jp-mw-download__row">
              <input type="checkbox" checked={chosen.includes(file.id)} disabled={disabled} onChange={(event) => toggle(file.id, event.target.checked)} />
              <span className="jp-mw-profiles__name" title={file.name}>
                {file.name}
                {file.kind === 'gcode' && <span className="jp-mw-profiles__tag">G-code</span>}
                {file.kind === 'sla' && <span className="jp-mw-profiles__tag">SLA</span>}
              </span>
              <span className="jp-upload__size">{file.size ? formatBytes(file.size) : ''}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
