/** The STL Home directories from settings (a JSON list, or the older single `stlHome` value). */
import { settings } from '../api';

/** A JSON list of paths, without blanks or duplicates (trailing slashes and case ignored). */
export function parseDirectoryList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    const p = String(item ?? '').trim();
    const key = p.replace(/[\\/]+$/, '').toLowerCase();
    if (!p || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** The older `stlHome` setting: one path, a JSON list, or paths separated by lines, commas or semicolons. */
export function parseLegacyStlHome(raw: string | null | undefined): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) return parseDirectoryList(text);
  if (/[\r\n,;]/.test(text)) return parseDirectoryList(JSON.stringify(text.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean)));
  return [text];
}

export async function stlHomeDirectories(): Promise<string[]> {
  const list = parseDirectoryList(await settings.get<string | null>('stlHomeDirectories').catch(() => null));
  if (list.length) return list;
  return parseLegacyStlHome(await settings.get<string | null>('stlHome').catch(() => null));
}
