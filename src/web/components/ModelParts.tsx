import { cx } from './Button';
import { IsoThumb } from './Filament';

/*
 * Model page pieces of the Bento look (docs/design-bento.md, J2 · Model page): the print profile
 * buttons and the picture gallery.
 */

export interface PrintProfile {
  id: string;
  /** "All plates", "Plate 1 · Frame" */
  name: string;
  /** "3 h 40 min · 112 g" */
  meta?: string;
}

/** Print profile buttons; the chosen one is ink. */
export function ProfilePicker({
  profiles,
  value,
  onChange,
  label = 'Print profile'
}: {
  profiles: PrintProfile[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <div className="jp-profiles" role="group" aria-label={label}>
      {profiles.map((profile) => {
        const on = profile.id === value;
        return (
          <button key={profile.id} type="button" className={cx('jp-profile', on && 'is-on')} aria-pressed={on} onClick={() => onChange(profile.id)}>
            <span className="jp-profile__name">{profile.name}</span>
            {profile.meta && <span className="jp-profile__meta">{profile.meta}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface GalleryPicture {
  id: string;
  /** "Cover", "Plate 1 · Frame", "Your print · Oct 24": the caption and the thumbnail's name. */
  label: string;
  src?: string | null;
  /** Placeholder art color when there is no src. */
  color?: string;
}

function Picture({ picture, size }: { picture: GalleryPicture; size: number }) {
  return picture.src ? <img src={picture.src} alt="" decoding="async" /> : <IsoThumb color={picture.color ?? '#8b8f96'} size={size} />;
}

/** A big picture with a strip of thumbnails under it; the chosen thumbnail is ringed in coral. */
export function PictureGallery({
  pictures,
  value,
  onChange,
  badge,
  label = 'Pictures'
}: {
  pictures: GalleryPicture[];
  value: string;
  onChange: (id: string) => void;
  /** Bottom right of the big picture ("Drag to rotate · 3D"). */
  badge?: string;
  label?: string;
}) {
  const shown = pictures.find((p) => p.id === value) ?? pictures[0];
  if (!shown) return null;
  return (
    <section className="jp-pictures" aria-label={label}>
      <div className="jp-pictures__main">
        <Picture picture={shown} size={300} />
        <span className="jp-pill jp-pill--glass jp-pictures__caption">{shown.label}</span>
        {badge && <span className="jp-pill jp-pill--dark jp-pictures__badge">{badge}</span>}
      </div>
      {pictures.length > 1 && (
        <div className="jp-pictures__strip">
          {pictures.map((picture) => {
            const on = picture.id === shown.id;
            return (
              <button
                key={picture.id}
                type="button"
                className={cx('jp-pictures__thumb', on && 'is-on')}
                aria-label={picture.label}
                aria-pressed={on}
                onClick={() => onChange(picture.id)}
              >
                <Picture picture={picture} size={38} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
