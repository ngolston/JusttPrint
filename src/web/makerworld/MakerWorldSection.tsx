import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Download, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { Button, IconButton } from '../components/Button';
import { Menu } from '../components/Menu';
import { formatBytes } from '../shell/AppShell';
import { useCan } from '../session';
import { loadSlicers, offerSlicerSettings, sendToSlicer, type Slicer } from '../slicer';
import {
  formatDay, formatDuration, formatGrams, getSiteDetails, linkParts, makerWorldUrl,
  type MakerWorldDetails, type MakerWorldProfile, type ProfileDownload, type SiteDetailsResult
} from './makerworld';

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="jp-prop">
      <span className="jp-prop__label">{label}</span>
      <span className="jp-prop__value">{children}</span>
    </div>
  );
}

/** Text with its http(s) addresses as links (no HTML from MakerWorld is ever shown). */
function LinkedText({ text }: { text: string }) {
  return <>{linkParts(text).map((part, i) => (part.href
    ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
    : <span key={i}>{part.text}</span>))}</>;
}

/** A YouTube video that loads only when played (until then nothing is sent to YouTube). */
function Video({ id }: { id: string }) {
  const [playing, setPlaying] = useState(false);
  const watch = `https://www.youtube.com/watch?v=${id}`;
  return (
    <div className="jp-mw__video">
      {playing ? (
        <iframe src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`} title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      ) : (
        <button type="button" className="jp-mw__video-start" onClick={() => setPlaying(true)} aria-label="Play the YouTube video">
          <Play size={28} aria-hidden="true" />
          <span>Play video</span>
        </button>
      )}
      <a className="jp-meta" href={watch} target="_blank" rel="noopener noreferrer">Open on YouTube <ExternalLink size={12} aria-hidden="true" /></a>
    </div>
  );
}

function ModelPart({ details }: { details: MakerWorldDetails }) {
  return (
    <>
      <h4 className="jp-mw__heading">The model</h4>
      <div className="jp-props">
        <Prop label="Title">{details.title || '—'}</Prop>
        {details.titleEnglish && details.titleEnglish !== details.title && <Prop label="English title">{details.titleEnglish}</Prop>}
        <Prop label="Model number">{details.id}</Prop>
        <Prop label="Designer">
          {details.designer.url
            ? <a href={details.designer.url} target="_blank" rel="noopener noreferrer">{details.designer.name || details.designer.handle}</a>
            : details.designer.name || '—'}
          {details.designer.handle && <span className="jp-meta"> @{details.designer.handle}</span>}
        </Prop>
        <Prop label="License">{details.license || '—'}</Prop>
        <Prop label="Categories">{details.categories.length ? details.categories.join(' › ') : '—'}</Prop>
        <Prop label="Created">{formatDay(details.created)}</Prop>
        <Prop label="Updated">{formatDay(details.updated)}</Prop>
      </div>
      {details.tags.length > 0 && (
        <ul className="jp-mw__tags" aria-label="MakerWorld tags">
          {details.tags.map((tag) => (
            <li key={tag.name} className="jp-mw__tag" title={tag.english ? `${tag.name} (${tag.english})` : tag.name}>
              {tag.english || tag.name}{tag.english && <span className="jp-mw__tag-original">{tag.name}</span>}
            </li>
          ))}
        </ul>
      )}
      <h5 className="jp-mw__label">Description</h5>
      {details.description || details.descriptionEnglish ? (
        <>
          {details.descriptionEnglish && details.descriptionEnglish !== details.description && <p className="jp-mw__text"><LinkedText text={details.descriptionEnglish} /></p>}
          {details.description && <p className="jp-mw__text"><LinkedText text={details.description} /></p>}
        </>
      ) : <p className="jp-meta">No description.</p>}
    </>
  );
}

/** Open one file in a slicer: the first slicer, or one picked from the arrow's list. */
function SlicerButton({ filePath, label, slicers }: { filePath: string; label: string; slicers: Slicer[] }) {
  const send = (slicer?: Slicer) => (slicer ? sendToSlicer([filePath], slicer) : offerSlicerSettings());
  return (
    <span className="jp-mw__slicer">
      <Button size="sm" variant="primary" className="jp-mw__slicer-main" title={slicers[0] ? `Open ${label} in ${slicers[0].name}` : 'Set up a slicer first'}
        onClick={() => { void send(slicers[0]); }}>Open in Slicer</Button>
      {slicers.length > 1 && (
        <Menu label="Slicers" align="end"
          items={slicers.map((slicer, index) => ({ id: `${slicer.id ?? index}`, label: slicer.name, onSelect: () => { void send(slicer); } }))}
          trigger={(props) => (
            <button type="button" className="jp-btn jp-btn--primary jp-btn--sm jp-mw__slicer-more" aria-label={`Choose a slicer for ${label}`} {...props}>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )} />
      )}
    </span>
  );
}

const profileName = (profile: MakerWorldProfile) => profile.nameEnglish || profile.name || `Profile ${profile.id}`;

/**
 * The downloaded print profiles, each with Open in Slicer: a model with several profiles (parts
 * of a kit, or versions for other printers) chooses which one goes to the slicer here.
 */
function ProfileFiles({ details, downloads, currentPath }: { details: MakerWorldDetails; downloads: ProfileDownload[]; currentPath: string }) {
  const [slicers, setSlicers] = useState<Slicer[]>([]);
  useEffect(() => { loadSlicers().then(setSlicers, () => {}); }, []);
  const rows = details.profiles
    .map((profile, index) => ({ profile, index, file: downloads.find((d) => d.profileId === profile.id) }))
    .filter((row) => row.file);
  if (!rows.length) return null;
  return (
    <>
      <h5 className="jp-mw__label">Downloaded profiles ({rows.length} of {details.profiles.length})</h5>
      <ul className="jp-mw__files" id="jp-mw-profile-files">
        {rows.map(({ profile, index, file }) => (
          <li key={profile.id} className={file!.filePath === currentPath ? 'is-current' : undefined}>
            <span className="jp-mw__files-text">
              <button type="button" className="jp-mw__files-name" title={`Show ${file!.fileName}`} onClick={() => window.bundleHost?.openModel(file!.filePath)}>
                {index + 1}. {profileName(profile)}
              </button>
              <span className="jp-meta">{`${profile.plates.length} ${profile.plates.length === 1 ? 'plate' : 'plates'} · ${formatGrams(profile.grams)} · ${formatDuration(profile.seconds)}${profile.needAms ? ' · AMS' : ''}`}</span>
            </span>
            <SlicerButton filePath={file!.filePath} label={profileName(profile)} slicers={slicers} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ProfilePart({ details, profileId, onChange, downloads, currentPath }: {
  details: MakerWorldDetails; profileId: string; onChange: (id: string) => void; downloads: ProfileDownload[]; currentPath: string;
}) {
  const profile = details.profiles.find((p) => p.id === profileId) || details.profiles[0];
  if (!profile) return null;
  return (
    <>
      <h4 className="jp-mw__heading">Print profile</h4>
      {details.profiles.length > 1 && (
        <select className="jp-input jp-mw__select" value={profile.id} aria-label="Print profile" onChange={(event) => onChange(event.target.value)}>
          {details.profiles.map((p, i) => <option key={p.id} value={p.id}>{`${i + 1}. ${profileName(p)}${downloads.some((d) => d.profileId === p.id) ? ' (downloaded)' : ''}`}</option>)}
        </select>
      )}
      <div className="jp-props">
        <Prop label="Name">
          {profile.name || '—'}
          {profile.nameEnglish && profile.nameEnglish !== profile.name && <span className="jp-mw__english">{profile.nameEnglish}</span>}
        </Prop>
        {profile.printer && <Prop label="Printer">{profile.printer}{profile.nozzle ? `, ${profile.nozzle} mm nozzle` : ''}</Prop>}
        <Prop label="Size of the job">{`${profile.plates.length} ${profile.plates.length === 1 ? 'plate' : 'plates'} · ${formatGrams(profile.grams)} · about ${formatDuration(profile.seconds)}`}</Prop>
        <Prop label="AMS">{profile.needAms ? 'Needed' : 'Not needed'}</Prop>
        {profile.rating !== null && <Prop label="Rating">{`${profile.rating} of 5 (${profile.ratingCount} ${profile.ratingCount === 1 ? 'rating' : 'ratings'})`}</Prop>}
      </div>

      {profile.plates.length > 0 && (
        <details className="jp-mw__more">
          <summary>Plates ({profile.plates.length})</summary>
          <table className="jp-mw__table">
            <thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col" className="is-number">Time</th><th scope="col" className="is-number">Grams</th></tr></thead>
            <tbody>
              {profile.plates.map((plate) => (
                <tr key={plate.index}>
                  <td>{plate.index}</td><td>{plate.name || '—'}</td>
                  <td className="is-number">{formatDuration(plate.seconds)}</td><td className="is-number">{formatGrams(plate.grams)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {profile.filaments.length > 0 && (
        <>
          <h5 className="jp-mw__label">Filament</h5>
          <table className="jp-mw__table">
            <thead><tr><th scope="col">Material</th><th scope="col">Color</th><th scope="col" className="is-number">Grams</th></tr></thead>
            <tbody>
              {profile.filaments.map((filament, i) => (
                <tr key={i}>
                  <td>{filament.type || '—'}</td>
                  <td>
                    {filament.color && <span className="jp-mw__swatch" style={{ background: filament.color }} aria-hidden="true" />}
                    <span className="jp-mw__hex">{filament.color || '—'}</span>
                  </td>
                  <td className="is-number">{formatGrams(filament.grams)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <ProfileFiles details={details} downloads={downloads} currentPath={currentPath} />
    </>
  );
}

function FilesPart({ details, profileId, downloads }: { details: MakerWorldDetails; profileId: string; downloads: ProfileDownload[] }) {
  const canDownload = useCan('editor');
  const english = details.files.some((file) => file.english);
  const translation = details.translation;
  return (
    <>
      <h4 className="jp-mw__heading">Files</h4>
      {details.files.length ? (
        <table className="jp-mw__table" id="jp-mw-files">
          <thead>
            <tr><th scope="col">File</th>{english && <th scope="col">English</th>}<th scope="col" className="is-number">Size</th></tr>
          </thead>
          <tbody>
            {details.files.map((file) => (
              <tr key={`${file.folder || ''}${file.name}`}>
                <td className="jp-mw__file" title={`${file.folder || ''}${file.name}`}>{file.folder && <span className="jp-meta">{file.folder}</span>}{file.name}</td>
                {english && <td className="jp-mw__file">{file.english || '—'}</td>}
                <td className="is-number">{file.size ? formatBytes(file.size) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="jp-meta">MakerWorld lists no model files.</p>}
      {translation?.error && <p className="jp-meta jp-mw__note">English names could not be made: {translation.error}</p>}

      <h5 className="jp-mw__label">File downloads</h5>
      {canDownload ? (
        <>
          <Button icon={Download} id="jp-mw-download" onClick={() => window.openMakerWorldDownload?.(details, { profileId, downloads })}>Download to Library…</Button>
          <p className="jp-meta jp-mw__note">
            Saves the print profiles as 3MF files (their parts, ready for the slicer); needs a MakerWorld sign-in, asked for before the first download.
            {details.files.length > 0 && <> MakerWorld only lets a browser download the separate files: <a href={details.url} target="_blank" rel="noopener noreferrer">open it on MakerWorld</a>, then add them under Download to Library….</>}
          </p>
        </>
      ) : <p className="jp-meta">An editor or admin downloads the files.</p>}
    </>
  );
}

/**
 * The MakerWorld section of the details panel, for models whose link or source is a MakerWorld
 * model: the model, its print profiles, files and downloads, and its video.
 */
export function MakerWorldSection({ model }: { model: { filePath?: string | null; source?: unknown } | null }) {
  const url = makerWorldUrl(model);
  const [result, setResult] = useState<SiteDetailsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [profileId, setProfileId] = useState('');

  async function load(refresh = false) {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const next = await getSiteDetails(url, refresh);
      setResult(next);
      const shownFile = next?.downloads?.find((d) => d.filePath === model?.filePath)?.profileId;
      const fromLink = shownFile || /#profileId-(\d+)/.exec(url)?.[1];
      setProfileId((current) => (refresh && current) || (fromLink && next?.details?.profiles.some((p) => p.id === fromLink) ? fromLink : next?.details?.profiles[0]?.id || ''));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setResult(null);
    setProfileId('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (!url) return null;
  const details = result?.details || null;
  return (
    <section className="jp-details__section jp-mw" id="jp-mw-section" aria-busy={loading}>
      <div className="jp-mw__top">
        <h3 className="jp-details__heading">MakerWorld</h3>
        <a className="jp-mw__open" href={details?.url || url} target="_blank" rel="noopener noreferrer">Open <ExternalLink size={12} aria-hidden="true" /></a>
        <IconButton icon={RefreshCw} size="sm" label="Get the details from MakerWorld again" disabled={loading} onClick={() => load(true)} className={loading ? 'jp-mw__spinning' : undefined} />
      </div>
      {loading && !details && <p className="jp-meta">Getting the details from MakerWorld…</p>}
      {error && <p className="jp-meta jp-mw__note" role="alert">Could not get the details: {error}</p>}
      {result && !details && result.error && <p className="jp-meta jp-mw__note">{result.error}</p>}
      {result?.stale && <p className="jp-meta jp-mw__note">MakerWorld could not be reached ({result.error}); these details are from {formatDay(result.fetchedAt)}.</p>}
      {details && (
        <>
          <ModelPart details={details} />
          <ProfilePart details={details} profileId={profileId} onChange={setProfileId} downloads={result?.downloads || []} currentPath={model?.filePath || ''} />
          <FilesPart details={details} profileId={profileId} downloads={result?.downloads || []} />
          <h4 className="jp-mw__heading">Video</h4>
          {details.videos.length ? details.videos.map((id) => <Video key={id} id={id} />) : <p className="jp-meta">No video.</p>}
        </>
      )}
    </section>
  );
}
