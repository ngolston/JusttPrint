'use strict';

/**
 * A designer's models or a collection's, as model links (Add Links turns a designer or collection
 * link into the links of its models, which it then adds like any others). What each site allows:
 *
 * - MakerWorld: a designer's models (by their id, which JusttPrint reads from one of their
 *   models it already has: MakerWorld does not let a server look a designer up by name), and a
 *   collection's models.
 * - Printables: a designer's models (their id is in the link). Printables does not let other
 *   programs list a collection's models.
 * - Thingiverse: a designer's models and a collection's, with a Thingiverse API token.
 */

const database = require('../core/database');
const { MAX_LINKS, SITES, parseListLink } = require('../core/link-import');
const { httpsFetch, readLimited, USER_AGENT } = require('./link-import');

const TIMEOUT_MS = 20000;
const PAGE = 50;
const MAX_ANSWER = 8 * 1024 * 1024;

const linkOf = (site, id) => SITES[site].canonical(String(id));

async function bambuJson(apiPath, fetchImpl) {
  const response = await fetchImpl(`https://api.bambulab.com/v1${apiPath}`, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = (await readLimited(response, MAX_ANSWER)).toString('utf8');
  if (!response.ok) throw new Error(`MakerWorld answered ${response.status}`);
  return JSON.parse(text);
}

/**
 * A MakerWorld designer's id from their handle: from a model of theirs JusttPrint has looked at
 * (its kept details name the handle), asking MakerWorld for that model's designer id.
 */
async function makerWorldDesigner(handle, fetchImpl) {
  const wanted = String(handle).toLowerCase();
  /** @type {{ key: string, data: string }[]} */
  let rows;
  try {
    rows = database.db.prepare("SELECT key, data FROM site_details WHERE key LIKE 'makerworld:%'").all();
  } catch (_) {
    // No MakerWorld details kept yet.
    rows = [];
  }
  for (const row of rows) {
    let details;
    try {
      details = JSON.parse(row.data);
    } catch (_) {
      continue;
    }
    if (String((details.designer && details.designer.handle) || '').toLowerCase() !== wanted) continue;
    const design = await bambuJson(`/design-service/design/${row.key.split(':')[1]}`, fetchImpl);
    const creator = design.designCreator || {};
    if (creator.uid) return { uid: String(creator.uid), name: creator.name || handle };
  }
  throw new Error(
    `JusttPrint does not know MakerWorld's id for @${handle} yet (MakerWorld does not let a server look designers up by name). Add one of their models first, or use "The designer's other models" in that model's MakerWorld section.`
  );
}

/** Pages of ids until `MAX_LINKS` (or the end): { ids, total }. */
async function collect(fetchPage) {
  const ids = [];
  let total = null;
  for (let page = 0; page < Math.ceil(MAX_LINKS / PAGE) + 1 && ids.length < MAX_LINKS; page++) {
    const { items, total: count, more } = await fetchPage(page);
    if (count != null) total = count;
    ids.push(...items);
    if (!items.length || !more) break;
  }
  const unique = [...new Set(ids.map(String))];
  return { ids: unique.slice(0, MAX_LINKS), total: total ?? unique.length };
}

async function makerWorldList(list, fetchImpl, uid) {
  if (list.kind === 'designer') {
    const designer = uid ? { uid: String(uid), name: list.handle } : await makerWorldDesigner(list.handle, fetchImpl);
    const { ids, total } = await collect(async (page) => {
      const body = await bambuJson(`/design-service/published/${designer.uid}/design?limit=${PAGE}&offset=${page * PAGE}`, fetchImpl);
      const hits = Array.isArray(body.hits) ? body.hits : [];
      return { items: hits.map((hit) => hit.id).filter(Boolean), total: body.total, more: hits.length === PAGE };
    });
    return { title: `Models by ${designer.name}`, ids, total };
  }
  // A collection ("favorites" to MakerWorld): its name, then its models page by page (checked against
  // a public collection; `favorites/designs/<id>` answers an empty list for every collection).
  let about;
  try {
    about = await bambuJson(`/design-service/favorites/${list.id}`, fetchImpl);
  } catch (error) {
    if (/answered 404/.test(error.message)) throw new Error(`MakerWorld has no collection ${list.id} (or it is private)`, { cause: error });
    throw error;
  }
  const { ids, total } = await collect(async (page) => {
    const body = await bambuJson(`/design-service/favorites/${list.id}/designs?limit=${PAGE}&offset=${page * PAGE}`, fetchImpl);
    const hits = Array.isArray(body.hits) ? body.hits : [];
    return { items: hits.map((hit) => hit.id).filter(Boolean), total: body.total, more: hits.length === PAGE };
  });
  if (!total) throw new Error('MakerWorld lists no models in this collection (it may be private)');
  const name = about && about.title ? String(about.title) : '';
  const by = about && about.creator && about.creator.name ? ` by ${about.creator.name}` : '';
  return { title: name ? `Collection "${name}"${by}` : 'MakerWorld collection', ids, total };
}

async function printablesList(list, fetchImpl) {
  if (list.kind === 'collection') {
    throw new Error("Printables does not let other programs list a collection's models: open the collection on Printables and copy its model links");
  }
  const { printablesGraphql } = require('./site-files');
  const user = await printablesGraphql('query JusttPrintUser($id: ID!) { user(id: $id) { publicUsername handle } }', { id: list.userId }, fetchImpl);
  if (!user || !user.user) throw new Error('Printables has no one with this link');
  let cursor = null;
  const { ids } = await collect(async () => {
    const data = await printablesGraphql(
      'query JusttPrintUserModels($id: ID!, $cursor: String) { userModels(userId: $id, limit: 30, cursor: $cursor) { cursor items { id } } }',
      { id: list.userId, cursor },
      fetchImpl
    );
    const page = (data && data.userModels) || { items: [], cursor: '' };
    cursor = page.cursor || null;
    return { items: (page.items || []).map((item) => item.id), total: null, more: !!cursor };
  });
  return { title: `Models by ${user.user.publicUsername || list.handle}`, ids, total: ids.length };
}

const slug = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function thingiverseList(list, fetchImpl) {
  const { thingiverseJson } = require('./site-files');
  const user = encodeURIComponent(list.user);
  let path;
  let title;
  if (list.kind === 'designer') {
    path = `/users/${user}/things`;
    title = `Models by ${list.user}`;
  } else {
    let id = /^\d+$/.test(list.id) ? list.id : null;
    let name = null;
    if (!id) {
      // A collection by name: find it among the person's collections.
      const wanted = slug(list.id);
      for (let page = 1; page <= 10 && !id; page++) {
        const found = await thingiverseJson(`/users/${user}/collections?per_page=${PAGE}&page=${page}`, fetchImpl);
        if (!Array.isArray(found) || !found.length) break;
        const match = found.find((c) => slug(c.name) === wanted || String(c.id) === list.id);
        if (match) ({ id, name } = { id: String(match.id), name: match.name });
      }
      if (!id) throw new Error(`Thingiverse has no collection "${list.id}" by ${list.user}`);
    }
    path = `/collections/${id}/things`;
    title = name ? `Collection ${name}` : 'Thingiverse collection';
  }
  const { ids } = await collect(async (page) => {
    const found = await thingiverseJson(`${path}?per_page=${PAGE}&page=${page + 1}`, fetchImpl);
    const items = Array.isArray(found) ? found.map((thing) => thing.id).filter(Boolean) : [];
    return { items, total: null, more: items.length === PAGE };
  });
  return { title, ids, total: ids.length };
}

/**
 * The model links of a designer or collection link: { url, title, links, total } (`links` at most
 * MAX_LINKS; `total` how many there are, when the site says). `options.uid` is a MakerWorld
 * designer's id when it is known (the MakerWorld section).
 */
async function listModelLinks(raw, { fetchImpl = httpsFetch, uid = null } = {}) {
  const list = parseListLink(raw);
  if (!list) throw new Error("Not a designer's or collection's link from MakerWorld, Printables or Thingiverse");
  const found =
    list.site === 'makerworld'
      ? await makerWorldList(list, fetchImpl, uid)
      : list.site === 'printables'
        ? await printablesList(list, fetchImpl)
        : await thingiverseList(list, fetchImpl);
  return { url: list.url, title: found.title, links: found.ids.map((id) => linkOf(list.site, id)), total: Math.max(found.total || 0, found.ids.length) };
}

module.exports = { listModelLinks, makerWorldDesigner };
