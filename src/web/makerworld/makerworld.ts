/**
 * MakerWorld in the browser: the details the JusttPrint backend reads from MakerWorld
 * (src/core/makerworld.js), the sign-in status, and formatting for the details panel.
 */
import { callAction } from '../api';

export interface MakerWorldProfile {
  id: string;
  name: string | null;
  nameEnglish: string | null;
  description: string | null;
  printer: string | null;
  nozzle: number | null;
  otherPrinters: string[];
  seconds: number | null;
  grams: number | null;
  plates: { index: number; name: string | null; seconds: number | null; grams: number | null }[];
  needAms: boolean;
  filaments: { type: string | null; color: string | null; grams: number | null; meters: number | null }[];
  downloads: number | null;
  prints: number | null;
  rating: number | null;
  ratingCount: number;
}

export interface MakerWorldFile {
  /** Printables and Thingiverse: the file's number there (for downloads). */
  id?: string;
  name: string;
  folder: string | null;
  size: number | null;
  type: string | null;
  english?: string | null;
  /** Printables and Thingiverse: a model file (ticked to start), not G-code or a project file. */
  model?: boolean;
  /** Printables G-code: what it was sliced for. */
  print?: GcodePrint;
}

/** Printables: what a G-code file was sliced for. */
export interface GcodePrint {
  printer: string | null;
  material: string | null;
  seconds: number | null;
  grams: number | null;
  layerHeight: number | null;
  nozzle: number | null;
}

/** A model this one is a remix of (Printables, Thingiverse with a token). */
export interface RemixSource {
  title: string | null;
  designer: string | null;
  url: string;
}

/** Printables: what the designer says about printing it. */
export interface PrintSettings {
  seconds: number | null;
  pieces: number | null;
  grams: number | null;
  nozzles: number[];
  layerHeights: number[];
  materials: string[];
  /** The printer the designer printed it on. */
  printer?: string | null;
}

/** A model's details from its site (src/core/makerworld.js, src/core/site-model-details.js). */
export interface MakerWorldDetails {
  site: 'makerworld' | 'printables' | 'thingiverse';
  url: string;
  id: string;
  title: string | null;
  titleEnglish: string | null;
  designer: { name: string | null; handle: string | null; url: string | null };
  license: string | null;
  categories: string[];
  tags: { name: string; english: string | null }[];
  created: string | null;
  updated: string | null;
  description: string | null;
  descriptionEnglish: string | null;
  videos: string[];
  profiles: MakerWorldProfile[];
  files: MakerWorldFile[];
  printSettings?: PrintSettings | null;
  /** Thingiverse without an API token: its files cannot be listed. */
  filesNeedToken?: boolean;
  stats?: {
    likes?: number | null;
    downloads?: number | null;
    prints?: number | null;
    views?: number | null;
    collections?: number | null;
    comments?: number | null;
    remixes?: number | null;
    /** Average rating out of 5, and how many rated (Printables). */
    rating?: number | null;
    ratings?: number | null;
  };
  remixedFrom?: RemixSource[];
  /** The site's PDF of the model page (Printables). */
  pdfUrl?: string | null;
  translation?: { mode: string; by: string | null; error: string | null };
  /** The fields changed in JusttPrint's Edit dialog (shown instead of the site's values). */
  edited?: string[];
}

export const SITE_LABELS: Record<string, string> = { makerworld: 'MakerWorld', printables: 'Printables', thingiverse: 'Thingiverse' };

/** A downloaded print profile: the library file that holds it. */
export interface ProfileDownload {
  profileId: string;
  filePath: string;
  fileName: string;
}

export interface SiteDetailsResult {
  details: MakerWorldDetails | null;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  downloads?: ProfileDownload[];
}

export interface AccountStatus {
  signedIn: boolean;
  account: string | null;
  name: string | null;
  expires: string | null;
}

/**
 * The print profiles the details panel offers, numbered as on MakerWorld (index from 0): once some
 * are downloaded only those (Download to Library… still lists them all), else every one.
 */
export function shownProfiles(profiles: MakerWorldProfile[], downloads: ProfileDownload[]): { profile: MakerWorldProfile; index: number }[] {
  const numbered = profiles.map((profile, index) => ({ profile, index }));
  const downloaded = numbered.filter(({ profile }) => downloads.some((d) => d.profileId === profile.id));
  return downloaded.length ? downloaded : numbered;
}

/** Window event: a model's site details were edited in this browser (the Edit dialog). */
export const SITE_DETAILS_CHANGED = 'jp-site-details-changed';

export const getSiteDetails = (url: string, refresh = false) => callAction<SiteDetailsResult | null>('get-site-details', url, refresh);
export const accountStatus = () => callAction<AccountStatus>('makerworld-account-status');

const MODEL_LINKS: [string, RegExp][] = [
  ['makerworld', /^(?:https?:\/\/)?(?:www\.)?makerworld\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?models\/\d+/i],
  ['printables', /^(?:https?:\/\/)?(?:www\.)?printables\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?model\/\d+/i],
  ['thingiverse', /^(?:https?:\/\/)?(?:www\.)?thingiverse\.com\/thing:\d+/i]
];

/**
 * The MakerWorld, Printables or Thingiverse model link of a model: its online-model path, else
 * its source. Null for anything else.
 */
export function siteModelUrl(model: { filePath?: string | null; source?: unknown } | null): { site: string; url: string } | null {
  if (!model) return null;
  const candidates = [model.filePath?.startsWith('url::') ? model.filePath.slice(5) : '', typeof model.source === 'string' ? model.source : ''];
  for (const raw of candidates) {
    const text = raw.trim();
    for (const [site, pattern] of MODEL_LINKS) {
      if (pattern.test(text)) return { site, url: /^https?:/i.test(text) ? text : `https://${text}` };
    }
  }
  return null;
}

/** The MakerWorld model link of a model, or null. */
export function makerWorldUrl(model: { filePath?: string | null; source?: unknown } | null): string | null {
  const found = siteModelUrl(model);
  return found && found.site === 'makerworld' ? found.url : null;
}

/** 326981 seconds → "90 h 50 min"; 2700 → "45 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const formatGrams = (grams: number | null | undefined) => (grams || grams === 0 ? `${Math.round(grams).toLocaleString()} g` : '—');

/** "2026-07-03T12:32:53Z" → "Jul 3, 2026". */
export function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Text split into plain parts and http(s) links, so links can be shown as links without HTML. */
export function linkParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    const href = match[0].replace(/[.,;:!?]+$/, '');
    parts.push({ text: href, href });
    last = index + href.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** "Prusa MK4S · PLA · 0.2 mm layers · 0.4 mm nozzle · about 2 h · 11 g": what a G-code file was sliced for. */
export function gcodeSummary(print: GcodePrint): string {
  return [
    print.printer,
    print.material,
    print.layerHeight ? `${print.layerHeight} mm layers` : null,
    print.nozzle ? `${print.nozzle} mm nozzle` : null,
    print.seconds ? `about ${formatDuration(print.seconds)}` : null,
    print.grams ? formatGrams(print.grams) : null
  ]
    .filter(Boolean)
    .join(' · ');
}
