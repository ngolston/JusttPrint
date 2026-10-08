'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  findModelLinks, fallbackName, fromMakerWorld, fromPrintables, fromThingiversePage, imageType, isAllowedImageUrl, licenseName,
  parseModelLink, printablesImageUrl
} = require('../src/core/link-import');
const { checkLinks, fetchImage, importLink } = require('../src/server/link-import');

async function main() {
  // --- Links ---
  const cases = [
    ['https://www.printables.com/model/3161-3d-benchy', 'printables', '3161', 'https://www.printables.com/model/3161', '3d-benchy'],
    ['printables.com/de/model/3161-3d-benchy/files', 'printables', '3161', 'https://www.printables.com/model/3161', '3d-benchy'],
    ['https://www.printables.com/model/3161?lang=en', 'printables', '3161', 'https://www.printables.com/model/3161', ''],
    ['https://www.thingiverse.com/thing:763622/files', 'thingiverse', '763622', 'https://www.thingiverse.com/thing:763622', ''],
    ['http://thingiverse.com/thing:763622', 'thingiverse', '763622', 'https://www.thingiverse.com/thing:763622', ''],
    ['https://makerworld.com/en/models/1000000-lens-cap#profileId-123', 'makerworld', '1000000', 'https://makerworld.com/en/models/1000000', 'lens-cap'],
    ['https://makerworld.com/models/19535', 'makerworld', '19535', 'https://makerworld.com/en/models/19535', ''],
    ['(https://www.printables.com/model/42-x).', 'printables', '42', 'https://www.printables.com/model/42', 'x']
  ];
  for (const [raw, site, id, url, slug] of cases) {
    const link = parseModelLink(raw.replace(/^\(/, ''));
    assert.deepStrictEqual(link, { site, id, url, slug }, raw);
  }
  for (const bad of [
    'https://www.printables.com/@Prusa3D', 'https://www.printables.com/model/0', 'https://evilprintables.com/model/1',
    'https://printables.com.evil.example/model/1', 'https://makerworld.com.cn/zh/models/1', 'ftp://www.thingiverse.com/thing:1',
    'https://www.thingiverse.com/Prusa/designs', 'not a link', ''
  ]) {
    assert.strictEqual(parseModelLink(bad), null, `${bad} is not a model link`);
  }

  const pasted = [
    'Benchy https://www.printables.com/model/3161-3d-benchy and the same again www.printables.com/model/3161',
    '  https://www.thingiverse.com/thing:763622  ',
    '- makerworld.com/en/models/19535-blv-ams-riser',
    'https://example.com/model/1',
    '',
    'just words'
  ].join('\n');
  const found = findModelLinks(pasted);
  assert.deepStrictEqual(found.links.map((l) => `${l.site}:${l.id}`), ['printables:3161', 'thingiverse:763622', 'makerworld:19535']);
  assert.deepStrictEqual(found.unsupported, ['https://example.com/model/1']);
  assert.strictEqual(found.skipped, 0);
  const many = findModelLinks(Array.from({ length: 205 }, (_, i) => `https://www.printables.com/model/${i + 1}`).join('\n'));
  assert.strictEqual(many.links.length, 200);
  assert.strictEqual(many.skipped, 5);

  assert.strictEqual(fallbackName(parseModelLink('https://www.printables.com/model/3161-3d-benchy')), '3d Benchy');
  assert.strictEqual(fallbackName(parseModelLink('https://www.thingiverse.com/thing:763622')), 'Thingiverse model 763622');

  // --- Site answers ---
  const printables = { data: { print: { id: '3161', name: '3D BENCHY', user: { publicUsername: 'Prusa Research', handle: 'Prusa3D' },
    image: { filePath: 'media/prints/3161/images/20206_70fde6a0/benchy.jpg' }, license: { name: 'Creative Commons — Public Domain' } } } };
  assert.deepStrictEqual(fromPrintables(printables), {
    name: '3D BENCHY', designer: 'Prusa Research', license: 'Creative Commons — Public Domain',
    image: 'https://media.printables.com/media/prints/3161/images/20206_70fde6a0/thumbs/inside/640x480/jpg/benchy.jpg'
  });
  assert.strictEqual(fromPrintables({ data: { print: null } }), null);
  assert.strictEqual(printablesImageUrl('/media/x.png'), 'https://media.printables.com/media/x.png');

  const makerworld = { id: 19535, title: 'BLV - AMS Riser', coverUrl: 'https://makerworld.bblmw.com/makerworld/model/US46/design/ae66.png',
    license: 'Standard Digital File License', designCreator: { name: 'benlevi', handle: 'benlevi' } };
  assert.deepStrictEqual(fromMakerWorld(makerworld), {
    name: 'BLV - AMS Riser', designer: 'benlevi', license: 'Standard Digital File License',
    image: 'https://makerworld.bblmw.com/makerworld/model/US46/design/ae66.png?x-oss-process=image/resize,w_640'
  });
  assert.strictEqual(fromMakerWorld({ id: 0, title: '' }), null, 'MakerWorld answers id 0 for a missing model');

  const ld = { '@context': 'https://schema.org/', '@type': 'Product', name: '#3DBenchy - The jolly torture-test by CreativeTools.se',
    author: { '@type': 'Person', name: 'CreativeTools' }, license: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  const thingPage = `<html><head><meta property="og:title" content="#3DBenchy - The jolly torture-test by CreativeTools.se by CreativeTools"/>
    <meta property="og:image" content="https://resize.thingiverse.com/?url=https://cdn.thingiverse.com/a.JPG&amp;w=628"/>
    <meta name="author" content="Thingiverse.com"/><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`;
  assert.deepStrictEqual(fromThingiversePage(thingPage), {
    name: '#3DBenchy - The jolly torture-test by CreativeTools.se', designer: 'CreativeTools', license: 'CC0 1.0',
    image: 'https://resize.thingiverse.com/?url=https://cdn.thingiverse.com/a.JPG&w=628'
  });
  // No structured data: "Name by Designer" from the preview title.
  assert.deepStrictEqual(fromThingiversePage('<meta property="og:title" content="Tiny &amp; Mighty Clip by maker">'),
    { name: 'Tiny & Mighty Clip', designer: 'maker', license: null, image: null });
  assert.strictEqual(fromThingiversePage('<title>Just a moment...</title><meta property="og:title" content="x">'), null);
  assert.strictEqual(licenseName('https://creativecommons.org/licenses/by-nc-sa/4.0/'), 'CC BY-NC-SA 4.0');
  assert.strictEqual(licenseName('https://example.com/license'), null);
  assert.strictEqual(fromThingiversePage('<meta property="og:url" content="https://www.thingiverse.com/"><meta property="og:title" content="Thingiverse - Open Hardware">', '1'), null, 'a missing thing shows the home page');
  assert.strictEqual(fromThingiversePage('<meta property="og:url" content="https://www.thingiverse.com/thing:12"><meta property="og:title" content="A">', '1'), null);
  assert.strictEqual(fromThingiversePage('<meta property="og:url" content="https://www.thingiverse.com/thing:1"><meta property="og:title" content="A">', '1').name, 'A');
  assert.strictEqual(fromThingiversePage('<meta property="og:title" content="A"><script>self.__next_f.push([1,"{\\"license\\":\\"https://creativecommons.org/licenses/by/4.0/\\"}"])</script>').license, 'CC BY 4.0');
  assert.strictEqual(licenseName('BY-NC'), 'CC BY-NC');
  assert.strictEqual(licenseName('Standard Digital File License'), 'Standard Digital File License');

  // --- Pictures ---
  assert.ok(isAllowedImageUrl('https://media.printables.com/media/a.jpg'));
  for (const bad of ['http://media.printables.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://evil.example/a.jpg', 'https://media.printables.com.evil.example/a.jpg', 'file:///etc/passwd']) {
    assert.ok(!isAllowedImageUrl(bad), bad);
    await assert.rejects(fetchImage(bad, () => { throw new Error('must not be fetched'); }), /image server/);
  }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  assert.strictEqual(imageType(jpeg), 'jpeg');
  assert.strictEqual(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.strictEqual(imageType(Buffer.from('<html>not an image</html>')), null);

  // --- Import, with a fake network ---
  const calls = [];
  const answer = (body, init = {}) => new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), init);
  const fakeFetch = async (url, options) => {
    calls.push(String(url));
    if (url === 'https://api.printables.com/graphql/') {
      const { variables } = JSON.parse(options.body);
      return answer(variables.id === '3161' ? printables : { data: { print: null } });
    }
    if (String(url).startsWith('https://makerworld.com/api/v1/design-service/design/')) return answer(makerworld);
    if (String(url).startsWith('https://www.thingiverse.com/')) return answer('<title>Just a moment...</title>', { status: 403 });
    if (String(url).startsWith('https://media.printables.com/')) return answer(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    if (String(url).startsWith('https://makerworld.bblmw.com/')) return answer('<html>oops</html>', { headers: { 'content-type': 'text/html' } });
    throw new Error(`unexpected fetch ${url}`);
  };

  const db = new Database(':memory:');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, designer TEXT, source TEXT, license TEXT, thumbnail TEXT)');
  db.prepare('INSERT INTO models (filePath, fileName, source) VALUES (?, ?, ?)').run('/library/benchy.stl', 'benchy.stl', 'https://www.printables.com/model/3161-3d-benchy');
  const saved = [];
  const deps = {
    db,
    fetchImpl: fakeFetch,
    saveModel: async (model) => {
      saved.push(model);
      db.prepare('INSERT INTO models (filePath, fileName, designer, source, license) VALUES (?, ?, ?, ?, ?)')
        .run(model.filePath, model.fileName, model.designer || null, model.source, model.license || null);
    },
    saveThumbnail: async (filePath, image) => db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(image, filePath)
  };

  const checked = checkLinks(db, `https://www.printables.com/model/3161\nhttps://makerworld.com/en/models/19535`);
  assert.deepStrictEqual(checked.links.map((l) => l.existing && l.existing.fileName), ['benchy.stl', null], 'a file whose source is the link counts');

  const exists = await importLink('https://www.printables.com/model/3161', deps);
  assert.strictEqual(exists.status, 'exists');
  assert.strictEqual(saved.length, 0);

  db.prepare('DELETE FROM models').run();
  const added = await importLink('https://www.printables.com/model/3161-3d-benchy', deps);
  assert.deepStrictEqual({ ...added }, { status: 'added', filePath: 'url::https://www.printables.com/model/3161', name: '3D BENCHY', designer: 'Prusa Research', picture: true, warning: null });
  assert.deepStrictEqual(saved[0], { filePath: 'url::https://www.printables.com/model/3161', fileName: '3D BENCHY', designer: 'Prusa Research',
    license: 'Creative Commons — Public Domain', source: 'https://www.printables.com/model/3161', markAsNew: true });
  assert.ok(db.prepare('SELECT thumbnail FROM models WHERE filePath = ?').get(added.filePath).thumbnail.startsWith('data:image/jpeg;base64,'));
  assert.strictEqual((await importLink('printables.com/model/3161', deps)).status, 'exists', 'the second time it is already there');

  const noPicture = await importLink('https://makerworld.com/en/models/19535-blv', deps);
  assert.strictEqual(noPicture.status, 'added');
  assert.strictEqual(noPicture.picture, false);
  assert.match(noPicture.warning, /not a JPEG, PNG or WebP/);

  const blocked = await importLink('https://www.thingiverse.com/thing:763622', deps);
  assert.strictEqual(blocked.status, 'added');
  assert.strictEqual(blocked.name, 'Thingiverse model 763622', 'named from the link when the site does not answer');
  assert.match(blocked.warning, /browser check/);
  assert.strictEqual(saved[saved.length - 1].source, 'https://www.thingiverse.com/thing:763622');

  const before = saved.length;
  const missing = await importLink('https://www.printables.com/model/99-gone', deps);
  assert.strictEqual(missing.status, 'missing');
  assert.match(missing.warning, /no model with this number/);
  assert.strictEqual(saved.length, before, 'a model the site does not have is not added');

  await assert.rejects(importLink('https://example.com/x', deps), /Not a Printables/);
  assert.ok(calls.every((url) => /^https:\/\/(api\.printables\.com|makerworld\.com|www\.thingiverse\.com|media\.printables\.com|makerworld\.bblmw\.com)\//.test(url)), calls.join('\n'));

  console.log('link-import tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
