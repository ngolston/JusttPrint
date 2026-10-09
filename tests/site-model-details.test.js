'use strict';

const assert = require('assert');
const { printablesDetails, thingiverseDetails } = require('../src/core/site-model-details');

const print = {
  id: '1839122',
  name: 'Parametric Laptop Stand',
  summary: 'Folding stand.',
  description: '<p>Folding laptop stand.</p><p>Video: <a href="https://youtu.be/abcdefghijk">watch</a></p><script>x()</script>',
  firstPublish: '2026-09-11T09:12:32Z',
  modified: '2026-09-29T07:22:49Z',
  likesCount: 2118,
  downloadCount: 7922,
  makesCount: 10,
  displayCount: 41699,
  tags: [{ name: 'desk' }, { name: 'stand' }],
  category: { path: [{ name: 'Gadgets' }, { name: 'Computers' }] },
  printDuration: 2.5,
  numPieces: 4,
  weight: 120,
  nozzleDiameters: [0.4],
  layerHeights: [0.2],
  materials: [{ name: 'PETG' }],
  usedMaterial: 'PLA',
  images: [{ filePath: 'media/prints/1/a.png' }],
  license: { name: 'Creative Commons — Attribution' },
  user: { publicUsername: 'Shapr3D', handle: 'Shapr3D' },
  ratingAvg: '3.3333333333',
  ratingCount: 6,
  commentCount: 47,
  collectionsCount: 875,
  remixCount: 2,
  pdfFilePath: 'media/prints/1839122/pdfs/stand.pdf',
  printer: { name: 'Prusa MK4S' },
  remixParents: [
    { url: null, parentPrint: { id: '3161', name: '3D Benchy', user: { publicUsername: 'CreativeTools', handle: 'CreativeTools' } } },
    { url: 'https://www.thingiverse.com/thing:2404514', parentPrint: null },
    { url: 'javascript:alert(1)', parentPrint: null }
  ]
};
const gcode = { printer: 'Prusa MK4S', material: 'PLA', seconds: 504, grams: 6, layerHeight: 0.28, nozzle: 0.4 };
const d = printablesDetails(
  print,
  [
    { id: '7', name: 'Main.stl', size: 300, kind: 'stl', model: true },
    { id: '8', name: 'Main_PLA_8m.bgcode', size: 500, kind: 'gcode', model: false, print: gcode }
  ],
  'https://www.printables.com/model/1839122'
);
assert.strictEqual(d.site, 'printables');
assert.strictEqual(d.title, 'Parametric Laptop Stand');
assert.deepStrictEqual(d.designer, { name: 'Shapr3D', handle: 'Shapr3D', url: 'https://www.printables.com/@Shapr3D' });
assert.deepStrictEqual(d.categories, ['Gadgets', 'Computers']);
assert.deepStrictEqual(d.tags, [
  { name: 'desk', english: null },
  { name: 'stand', english: null }
]);
assert.strictEqual(d.description, 'Folding laptop stand.\nVideo: watch (https://youtu.be/abcdefghijk)', 'no HTML or script text');
assert.deepStrictEqual(d.videos, ['abcdefghijk']);
assert.deepStrictEqual(d.printSettings, {
  seconds: 9000,
  pieces: 4,
  grams: 120,
  nozzles: [0.4],
  layerHeights: [0.2],
  materials: ['PETG', 'PLA'],
  printer: 'Prusa MK4S'
});
assert.deepStrictEqual(d.files, [
  { id: '7', name: 'Main.stl', folder: null, size: 300, type: 'stl', model: true },
  { id: '8', name: 'Main_PLA_8m.bgcode', folder: null, size: 500, type: 'gcode', model: false, print: gcode }
]);
assert.deepStrictEqual(d.pictures, ['https://media.printables.com/media/prints/1/a.png']);
assert.deepStrictEqual(d.stats, {
  likes: 2118,
  downloads: 7922,
  prints: 10,
  views: 41699,
  comments: 47,
  collections: 875,
  remixes: 2,
  rating: 3.3,
  ratings: 6
});
assert.deepStrictEqual(
  d.remixedFrom,
  [
    { title: '3D Benchy', designer: 'CreativeTools', url: 'https://www.printables.com/model/3161' },
    { title: null, designer: null, url: 'https://www.thingiverse.com/thing:2404514' }
  ],
  'Printables parents and outside links; no script links'
);
assert.strictEqual(d.pdfUrl, 'https://media.printables.com/media/prints/1839122/pdfs/stand.pdf');
assert.strictEqual(
  printablesDetails(
    { ...print, printDuration: null, numPieces: 0, weight: null, nozzleDiameters: null, layerHeights: null, materials: [], usedMaterial: null, printer: null },
    [],
    'u'
  ).printSettings,
  null,
  'no print settings: none shown'
);
assert.strictEqual(printablesDetails(null, [], 'u'), null);

// Thingiverse without a token: what its page says; the files need a token.
const page =
  '<meta property="og:description" content="Cute mini Octopus.It&#39;s printed at once."/><script>"datePublished":"2019-03-16T10:20:19+00:00","dateModified":"2019-03-17T10:20:19+00:00"</script>';
const t = thingiverseDetails({
  id: '3495390',
  url: 'https://www.thingiverse.com/thing:3495390',
  html: page,
  fromPage: {
    name: 'Cute Mini Octopus',
    designer: 'McGybeer',
    license: 'CC BY-NC-SA 4.0',
    image: 'https://cdn.thingiverse.com/a.jpg',
    stats: { likes: 16, comments: 0 }
  }
});
assert.strictEqual(t.title, 'Cute Mini Octopus');
assert.deepStrictEqual(t.designer, { name: 'McGybeer', handle: null, url: 'https://www.thingiverse.com/McGybeer' });
assert.strictEqual(t.description, "Cute mini Octopus. It's printed at once.", 'a space between run-together sentences');
assert.deepStrictEqual([t.created, t.updated], ['2019-03-16T10:20:19+00:00', '2019-03-17T10:20:19+00:00']);
assert.strictEqual(t.filesNeedToken, true);
assert.deepStrictEqual(t.pictures, ['https://cdn.thingiverse.com/a.jpg']);
assert.deepStrictEqual(t.stats, { likes: 16, comments: 0 }, 'the page gives likes and comments');

// With a token: the API's thing, tags and files.
const api = thingiverseDetails({
  id: '7418273',
  url: 'https://www.thingiverse.com/thing:7418273',
  fromPage: null,
  thing: {
    name: 'Prowling Bear',
    creator: { name: 'LennyFace', public_url: 'https://www.thingiverse.com/LennyFace' },
    license: 'Creative Commons - Public Domain Dedication',
    added: '2026-01-01T00:00:00Z',
    modified: '2026-01-02T00:00:00Z',
    details: '<p>A bear.</p>',
    like_count: 5,
    make_count: 2,
    comment_count: 3,
    remix_count: 1,
    categories: [{ name: 'Animals' }]
  },
  ancestors: [
    { id: 6000000, name: 'Bear (two halves)', creator: { name: 'Original' } },
    { id: 7418273, name: 'Prowling Bear' }
  ],
  tags: [{ name: 'bear' }],
  files: [{ id: 11, name: 'bear.stl', size: 1000, kind: 'stl', model: true }]
});
assert.deepStrictEqual(
  [api.title, api.designer.name, api.description, api.categories, api.tags.map((x) => x.name), api.filesNeedToken, api.files.length],
  ['Prowling Bear', 'LennyFace', 'A bear.', ['Animals'], ['bear'], false, 1]
);
assert.deepStrictEqual([api.stats.comments, api.stats.remixes], [3, 1]);
assert.deepStrictEqual(
  api.remixedFrom,
  [{ title: 'Bear (two halves)', designer: 'Original', url: 'https://www.thingiverse.com/thing:6000000' }],
  'not the thing itself'
);
assert.strictEqual(thingiverseDetails({ id: '1', url: 'u' }), null);

console.log('site-model-details tests passed');
