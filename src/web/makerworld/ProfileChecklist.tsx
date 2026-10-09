import { formatDuration, formatGrams, type MakerWorldProfile } from './makerworld';

const nameOf = (profile: MakerWorldProfile) => profile.nameEnglish || profile.name || `Profile ${profile.id}`;

/**
 * The print profiles of a MakerWorld model to tick for download (Add Links, Download from
 * MakerWorld): name, plates, weight, print time and AMS need. Downloaded ones show ticked and
 * cannot be changed.
 */
export function ProfileChecklist({
  profiles,
  chosen,
  onChange,
  downloaded = [],
  disabled = false,
  mainId = null,
  id
}: {
  profiles: MakerWorldProfile[];
  chosen: string[];
  onChange: (ids: string[]) => void;
  downloaded?: string[];
  disabled?: boolean;
  /** The profile the link named. */
  mainId?: string | null;
  id?: string;
}) {
  const open = profiles.filter((p) => !downloaded.includes(p.id));
  const count = open.filter((p) => chosen.includes(p.id)).length;
  const toggle = (profileId: string, on: boolean) => onChange(on ? [...new Set([...chosen, profileId])] : chosen.filter((c) => c !== profileId));
  return (
    <div className="jp-mw-profiles" id={id}>
      <div className="jp-mw-profiles__top">
        <span className="jp-mw-profiles__count">
          Print profiles: {count} of {open.length} chosen{downloaded.length ? ` (${downloaded.length} downloaded)` : ''}
        </span>
        <button type="button" className="jp-mw-profiles__all" disabled={disabled} onClick={() => onChange(open.map((p) => p.id))}>
          All
        </button>
        <button type="button" className="jp-mw-profiles__all" disabled={disabled} onClick={() => onChange([])}>
          None
        </button>
      </div>
      <ul className="jp-mw-profiles__list">
        {profiles.map((profile, index) => {
          const done = downloaded.includes(profile.id);
          return (
            <li key={profile.id}>
              <label className={`jp-mw-download__row${done ? ' is-done' : ''}`}>
                <input
                  type="checkbox"
                  checked={done || chosen.includes(profile.id)}
                  disabled={disabled || done}
                  onChange={(event) => toggle(profile.id, event.target.checked)}
                />
                <span className="jp-mw-profiles__name">
                  {index + 1}. {nameOf(profile)}
                  {profile.id === mainId && <span className="jp-mw-profiles__tag">in the link</span>}
                  {done && <span className="jp-mw-profiles__tag">downloaded</span>}
                </span>
                <span className="jp-meta jp-mw-profiles__meta">
                  {`${profile.plates.length} ${profile.plates.length === 1 ? 'plate' : 'plates'} · ${formatGrams(profile.grams)} · ${formatDuration(profile.seconds)}${profile.needAms ? ' · AMS' : ''}`}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
