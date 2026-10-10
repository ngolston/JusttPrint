'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
const database = require('../src/core/database');
const { folderName, htmlToText, makerWorldDetails, needsTranslation, splitName, youtubeIds } = require('../src/core/makerworld');
const translate = require('../src/server/translate');
const account = require('../src/server/makerworld-account');
const siteDetails = require('../src/server/site-details');
const { SECRET_SETTING_KEYS } = require('../src/server/server-auth');

const URL_ = 'https://makerworld.com/en/models/3006565';

/** A design answer shaped like MakerWorld's (trimmed). */
const design = {
  id: 3006565,
  title: '究极拼装PG自由高达',
  titleTranslated: 'Ultimate Assembly PG Freedom Gundam',
  summary: '<p>Watch: <a href="https://youtu.be/D3EyCXCnalk?is=x">video</a></p><script>alert(1)</script><p>Line&nbsp;two &amp; more</p>',
  summaryTranslated: '',
  license: 'BY-NC-SA',
  createTime: '2026-07-03T12:32:53Z',
  updateTime: '2026-10-07T23:57:15Z',
  tags: ['pg', '高达'],
  tagsTranslated: ['pg', 'Gundam'],
  categories: [
    { id: 806, name: 'Construction Sets' },
    { id: 800, name: 'Toys & Games' }
  ],
  designCreator: { name: '黑方狼灭', handle: 'hei_fang' },
  coverUrl: 'https://makerworld.bblmw.com/makerworld/model/US4d/design/c38e.jpg',
  defaultInstanceId: 2,
  likeCount: 564,
  instances: [
    { id: 1, title: 'Other profile', ratingCount: 0, extention: { modelInfo: { plates: [] } } },
    {
      id: 2,
      title: '默认参数免支撑',
      titleTranslated: 'Default parameters no supports',
      prediction: 326981,
      weight: 1918,
      needAms: false,
      ratingScoreTotal: 39,
      ratingCount: 8,
      instanceFilaments: [
        { type: 'PETG', color: '#e0e1e2', usedM: '180.48', usedG: '546' },
        { type: 'TPU', color: 'bad', usedG: '70' }
      ],
      extention: {
        modelInfo: {
          compatibility: { devProductName: 'P1S', nozzleDiameter: 0.4 },
          otherCompatibility: [{ devProductName: 'A1' }],
          plates: [
            { index: 1, name: 'ok', prediction: 12542, weight: 86 },
            { index: 26, name: 'tpu', prediction: 23820, weight: 70 }
          ]
        }
      }
    }
  ],
  designExtension: {
    design_pictures: [{ name: 'a.png', url: 'https://makerworld.bblmw.com/a.png' }, { url: 'javascript:alert(1)' }],
    model_files: [
      { modelName: '腿部.stl', modelSize: 16100634, modelType: 'stl', isDir: false },
      { isDir: true, dirName: 'extras', children: [{ modelName: '武器.stl', modelSize: 1426000, modelType: 'stl' }] }
    ]
  }
};

async function main() {
  // --- Reading MakerWorld's answer ---
  const d = makerWorldDetails(design, URL_);
  assert.strictEqual(d.title, '究极拼装PG自由高达');
  assert.strictEqual(d.titleEnglish, 'Ultimate Assembly PG Freedom Gundam');
  assert.strictEqual(d.id, '3006565');
  assert.deepStrictEqual(d.designer, { name: '黑方狼灭', handle: 'hei_fang', url: 'https://makerworld.com/en/@hei_fang' });
  assert.strictEqual(d.license, 'CC BY-NC-SA');
  assert.deepStrictEqual(d.categories, ['Construction Sets', 'Toys & Games']);
  assert.deepStrictEqual(d.tags, [
    { name: 'pg', english: null },
    { name: '高达', english: 'Gundam' }
  ]);
  assert.strictEqual(d.created, '2026-07-03T12:32:53Z');
  assert.strictEqual(d.description, 'Watch: video (https://youtu.be/D3EyCXCnalk?is=x)\nLine two & more', 'no HTML or script text is kept');
  assert.deepStrictEqual(d.videos, ['D3EyCXCnalk']);
  assert.deepStrictEqual(d.pictures, ['https://makerworld.bblmw.com/a.png'], 'only https pictures');
  assert.deepStrictEqual(
    d.profiles.map((p) => p.id),
    ['2', '1'],
    'the default profile comes first'
  );
  const p = d.profiles[0];
  assert.strictEqual(p.nameEnglish, 'Default parameters no supports');
  assert.strictEqual(p.printer, 'P1S');
  assert.strictEqual(p.seconds, 326981);
  assert.strictEqual(p.grams, 1918);
  assert.strictEqual(p.needAms, false);
  assert.strictEqual(p.rating, 4.9);
  assert.deepStrictEqual(p.plates, [
    { index: 1, name: 'ok', seconds: 12542, grams: 86 },
    { index: 26, name: 'tpu', seconds: 23820, grams: 70 }
  ]);
  assert.deepStrictEqual(p.filaments, [
    { type: 'PETG', color: '#E0E1E2', grams: 546, meters: 180.48 },
    { type: 'TPU', color: null, grams: 70, meters: null }
  ]);
  assert.deepStrictEqual(d.files, [
    { name: '腿部.stl', folder: null, size: 16100634, type: 'stl' },
    { name: '武器.stl', folder: 'extras/', size: 1426000, type: 'stl' }
  ]);
  assert.strictEqual(makerWorldDetails({ id: 0, title: '' }, URL_), null);

  assert.deepStrictEqual(
    youtubeIds(
      '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe> https://www.youtube.com/watch?v=abcdefghijk&t=1 youtube.com/shorts/ZYXWVUTSRQP'
    ),
    ['abcdefghijk', 'ZYXWVUTSRQP']
  );
  assert.strictEqual(htmlToText('<ul><li>One</li><li>Two</li></ul>'), '• One\n• Two');
  assert.ok(needsTranslation('腿部') && needsTranslation('Крыло') && !needsTranslation('benchy_v2 (1)') && !needsTranslation('Flügel'));
  assert.deepStrictEqual(splitName('腿部.stl'), { stem: '腿部', extension: '.stl' });
  assert.strictEqual(folderName('../a/b:c*'), 'a b c');
  assert.strictEqual(folderName('...'), 'MakerWorld model');
  assert.strictEqual(
    folderName('Ultimate Assembly PG Freedom Gundam with full internal structure, 580+ parts, entirely support-free'),
    'Ultimate Assembly PG Freedom Gundam with full internal structure, 580+ parts',
    'long titles are cut at a word'
  );

  // --- Translation ---
  assert.deepStrictEqual(translate.batches(['aaa', 'bbb', 'ccc'], 8), [['aaa', 'bbb'], ['ccc']]);
  const memory = async (url) => {
    const q = new URL(url).searchParams.get('q');
    const words = { 腿部: 'Legs', 武器: 'Weapons' };
    return new Response(
      JSON.stringify({
        responseStatus: 200,
        responseData: {
          translatedText: q
            .split('\n')
            .map((w) => words[w] || w)
            .join('\n')
        }
      })
    );
  };
  assert.deepStrictEqual(await translate.translateNames(['腿部', 'benchy', '武器'], 'free', { fetchImpl: memory }), {
    english: ['Legs', null, 'Weapons'],
    by: 'free',
    error: null
  });
  assert.deepStrictEqual((await translate.translateNames(['腿部'], 'off', { fetchImpl: memory })).english, [null]);
  const quota = async () =>
    new Response(JSON.stringify({ responseStatus: 429, responseDetails: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }));
  const failed = await translate.translateNames(['腿部'], 'free', { fetchImpl: quota });
  assert.deepStrictEqual(failed.english, [null]);
  assert.match(failed.error, /FREE TRANSLATIONS/, 'a failed translation never throws');
  assert.deepStrictEqual(translate.parseAiAnswer('Sure! ["Legs", "Weapons"]', 2), ['Legs', 'Weapons']);
  assert.throws(() => translate.parseAiAnswer('["Legs"]', 2), /did not answer/);
  const puter = await translate.translateNames(['腿部'], 'ai', {
    aiSettings: { aiService: 'puter' },
    puterHandler: async () => ({ message: { content: '["Legs"]' } })
  });
  assert.deepStrictEqual(puter.english, ['Legs']);
  assert.strictEqual(translate.modeOf('nonsense'), 'free');

  // --- Sign-in ---
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-makerworld-')));
  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, designer TEXT, license TEXT, source TEXT, notes TEXT, rating INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, print_status TEXT DEFAULT 'unprinted', printed INTEGER, print_count INTEGER DEFAULT 0, last_printed_at TEXT, thumbnail TEXT); CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER, PRIMARY KEY (model_id, tag_id)); CREATE TABLE collection_models (collection_id INTEGER, model_id INTEGER, added_at TEXT, PRIMARY KEY (collection_id, model_id)); CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER); CREATE TABLE share_links (token TEXT PRIMARY KEY, kind TEXT, target_id INTEGER)"
  );
  assert.ok(SECRET_SETTING_KEYS.has('makerWorldAccount'), 'the token is never readable through the settings API');
  assert.deepStrictEqual(account.status(), { signedIn: false, account: null, name: null, expires: null });

  const bambuCalls = [];
  const bambu = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    bambuCalls.push(`${options.method} ${new URL(url).pathname} ${body ? Object.keys(body).sort().join(',') : ''}`);
    const json = (status, value) => new Response(JSON.stringify(value), { status });
    if (url.endsWith('/user/login')) {
      if (body.password === 'wrong') return json(400, { code: 1, error: 'Incorrect account or password.' });
      if (body.password) return json(200, { loginType: 'verifyCode' });
      if (body.code === '123456') return json(200, { accessToken: 'ACCESS', refreshToken: 'REFRESH', expiresIn: 7776000 });
      return json(400, { error: 'The verification code is wrong.' });
    }
    if (url.endsWith('/sendemail/code')) return json(200, {});
    if (url.endsWith('/my/preference')) return options.headers.authorization === 'Bearer ACCESS' ? json(200, { name: 'Maker Me' }) : json(401, {});
    if (url.endsWith('/refreshtoken')) return json(200, { accessToken: 'ACCESS2', refreshToken: 'REFRESH2', expiresIn: 100 });
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(account.signIn({ account: 'me@example.com', password: 'wrong' }, bambu), /Incorrect account or password/);
  assert.deepStrictEqual(await account.signIn({ account: 'me@example.com', password: 'right' }, bambu), { done: false, next: 'code' });
  await assert.rejects(account.signIn({ account: 'me@example.com', code: '000000' }, bambu), /verification code is wrong/);
  const signedIn = await account.signIn({ account: 'me@example.com', code: '123456' }, bambu);
  assert.strictEqual(signedIn.done, true);
  assert.strictEqual(signedIn.name, 'Maker Me');
  assert.ok(!JSON.stringify(account.status()).includes('ACCESS'), 'the status never carries the token');
  assert.ok(bambuCalls.includes('POST /v1/user-service/user/sendemail/code email,type'), bambuCalls.join('\n'));
  assert.deepStrictEqual(account.authHeaders(), { authorization: 'Bearer ACCESS', cookie: 'token=ACCESS' });
  assert.strictEqual(await account.refresh(bambu), true);
  assert.deepStrictEqual(account.authHeaders(), { authorization: 'Bearer ACCESS2', cookie: 'token=ACCESS2' });

  // --- Details: fetched once, then kept ---
  database.db.prepare("INSERT INTO settings (key, value) VALUES ('makerWorldTranslation', 'free')").run();
  let designFetches = 0;
  const threeMf = Buffer.from(zipSync({ '3D/3dmodel.model': strToU8('<model/>') }));
  let modelLinkHost = 'makerworld.bblmw.com';
  let profileName = 'Default.3mf';
  const world = async (url, options = {}) => {
    const u = new URL(url);
    const signed = options.headers && options.headers.authorization === 'Bearer ACCESS2';
    if (u.hostname === 'api.mymemory.translated.net') return memory(url);
    if (u.pathname === '/api/v1/design-service/design/3006565') {
      designFetches++;
      return new Response(JSON.stringify(design));
    }
    // The separate model files sit behind a CAPTCHA: JusttPrint never asks for them.
    if (u.pathname.startsWith('/api/v1/design-service/design/3006565/model')) throw new Error('the CAPTCHA-protected model files must not be requested');
    if (u.hostname === 'api.bambulab.com' && /^\/v1\/design-service\/instance\/[12]\/f3mf$/.test(u.pathname)) {
      return signed
        ? new Response(JSON.stringify({ name: profileName, url: `https://${modelLinkHost}/files/p.3mf` }))
        : new Response(JSON.stringify({ code: 1, error: 'Please log in to download models.' }), { status: 403 });
    }
    if (u.hostname === 'makerworld.bblmw.com' && u.pathname === '/files/p.3mf')
      return new Response(threeMf, { headers: { 'content-length': String(threeMf.length) } });
    throw new Error(`unexpected fetch ${url}`);
  };
  const first = await siteDetails.getDetails(`${URL_}-ultimate#profileId-2`, { fetchImpl: world });
  assert.strictEqual(first.details.files[0].english, 'Legs.stl');
  assert.strictEqual(first.details.files[1].english, 'Weapons.stl');
  assert.deepStrictEqual(first.details.translation, { mode: 'free', by: 'free', error: null });
  await siteDetails.getDetails('https://makerworld.com/models/3006565', { fetchImpl: world });
  assert.strictEqual(designFetches, 1, 'kept details are reused for any form of the link');
  await siteDetails.getDetails(URL_, { refresh: true, fetchImpl: world });
  assert.strictEqual(designFetches, 2, 'Refresh fetches again');
  const offline = await siteDetails.getDetails(URL_, {
    refresh: true,
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  assert.ok(
    offline.stale && offline.details.title === design.title && /offline/.test(offline.error),
    'older details are shown when MakerWorld cannot be reached'
  );
  assert.strictEqual(
    await siteDetails.getDetails('https://example.com/model/1', { fetchImpl: world }),
    null,
    'only model links of the three sites have details'
  );

  // --- Downloads ---
  const library = path.join(tmp, 'library');
  fs.mkdirSync(library);
  database.db.prepare("INSERT INTO settings (key, value) VALUES ('stlHomeDirectories', ?)").run(JSON.stringify([library]));
  // The scan is stubbed: it adds the files it finds the way a scan would.
  const stlHome = require('../src/server/stl-home');
  stlHome.scanUploadedFolder = async (folder) => {
    for (const name of fs.readdirSync(folder)) {
      database.db.prepare("INSERT OR IGNORE INTO models (filePath, fileName, designer) VALUES (?, ?, 'Unknown')").run(path.join(folder, name), name);
    }
    return 0;
  };

  await assert.rejects(siteDetails.download({ url: URL_, folder: '/etc' }, { fetchImpl: world }), /outside|cannot|library/i, 'only library folders');

  siteDetails.setProfileGap(0);
  const T = 'Ultimate Assembly PG Freedom Gundam';
  const defaultFile = `Default parameters no supports - ${T}.3mf`;
  const otherFile = `Other profile - ${T}.3mf`;
  const forget = () => database.db.prepare('DELETE FROM site_files').run();

  // One profile: a new folder named after the model; with several profiles, files name theirs.
  const progressSeen = [];
  const result = await siteDetails.download(
    { url: URL_, folder: library, profileId: '2' },
    { fetchImpl: world, onProgress: (p) => progressSeen.push(p.label) }
  );
  const folder = path.join(library, T);
  assert.strictEqual(result.folder, folder, 'a new folder named after the English title');
  assert.deepStrictEqual(result.saved, [defaultFile]);
  assert.deepStrictEqual(fs.readdirSync(folder), [defaultFile], 'no temp files are left');
  assert.ok(progressSeen.includes('Print profile'));
  assert.strictEqual(result.mainFile, path.join(folder, defaultFile));
  assert.deepStrictEqual(result.missing, []);
  const added = database.db.prepare('SELECT designer, license, source FROM models WHERE filePath = ?').get(path.join(folder, defaultFile));
  assert.deepStrictEqual({ ...added }, { designer: '黑方狼灭', license: 'CC BY-NC-SA', source: 'https://makerworld.com/en/models/3006565' });
  assert.deepStrictEqual(
    (await siteDetails.getDetails(URL_, { fetchImpl: world })).downloads.map((d) => d.profileId),
    ['2'],
    'the details say which profiles are downloaded'
  );

  // All profiles: the rest go into the same folder; what is there is not downloaded again.
  const all = await siteDetails.download({ url: URL_, folder: library, profileId: 'all' }, { fetchImpl: world, onProgress: (p) => progressSeen.push(p.label) });
  assert.strictEqual(all.folder, folder, "the model's folder from before");
  assert.deepStrictEqual(all.saved, [otherFile], 'only the missing profile');
  assert.strictEqual(all.inLibrary, 2);
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), [defaultFile, otherFile].sort());
  assert.strictEqual(all.mainFile, path.join(folder, defaultFile), 'the default profile is the main file');
  const nothingNew = await siteDetails.download({ url: URL_, folder: library, profileId: 'all' }, { fetchImpl: world });
  assert.deepStrictEqual([nothingNew.saved, nothingNew.folder], [[], folder], 'everything there: nothing downloaded');
  assert.deepStrictEqual(
    siteDetails
      .downloadsFor('makerworld:3006565')
      .map((d) => d.profileId)
      .sort(),
    ['1', '2']
  );

  // Files named the old way ("<title> - <profile>") get the profile first; the model row moves with them.
  const oldName = path.join(folder, `${T} - Other profile.3mf`);
  fs.renameSync(path.join(folder, otherFile), oldName);
  database.db
    .prepare('UPDATE models SET filePath = ?, fileName = ?, notes = ? WHERE filePath = ?')
    .run(oldName, path.basename(oldName), 'keep me', path.join(folder, otherFile));
  database.db.prepare('UPDATE site_files SET file_path = ? WHERE file_path = ?').run(oldName, path.join(folder, otherFile));
  assert.strictEqual(siteDetails.renameProfileFiles(), 1);
  assert.ok(fs.existsSync(path.join(folder, otherFile)) && !fs.existsSync(oldName));
  assert.deepStrictEqual(
    { ...database.db.prepare('SELECT fileName, notes FROM models WHERE filePath = ?').get(path.join(folder, otherFile)) },
    { fileName: otherFile, notes: 'keep me' }
  );
  assert.strictEqual(siteDetails.renameProfileFiles(), 0, 'nothing left to rename');

  // A profile that is gone: the default one.
  forget();
  const gone = await siteDetails.download({ url: URL_, folder: library, profileId: '999' }, { fetchImpl: world });
  assert.strictEqual(path.basename(gone.folder), `${T} (2)`, 'nothing remembered: a new folder');
  assert.deepStrictEqual(gone.saved, [defaultFile]);

  forget();
  modelLinkHost = 'evil.example';
  await assert.rejects(siteDetails.download({ url: URL_, folder: library }, { fetchImpl: world }), /does not download from \(evil\.example\)/);
  assert.ok(!fs.existsSync(path.join(library, `${T} (3)`)), 'a failed download leaves no empty folder');
  modelLinkHost = 'makerworld.bblmw.com';

  // A robot check pauses downloads: MakerWorld is not asked again for a while.
  let captcha = true;
  let captchaAfter = 0;
  let asked = 0;
  const robotWorld = async (url, options) => {
    if (/\/f3mf$/.test(new URL(url).pathname)) {
      asked++;
      if (captcha && asked > captchaAfter)
        return new Response(JSON.stringify({ error: 'We need to confirm that you are not a robot.', captchaId: 'x' }), { status: 418 });
    }
    return world(url, options);
  };
  await assert.rejects(
    siteDetails.download({ url: URL_, folder: library }, { fetchImpl: robotWorld }),
    (error) => error.code === 'CAPTCHA' && /only a browser can do/.test(error.message)
  );
  await assert.rejects(
    siteDetails.download({ url: URL_, folder: library }, { fetchImpl: robotWorld }),
    (error) => error.code === 'CAPTCHA' && /try again in 30 min/.test(error.message)
  );
  assert.strictEqual(asked, 1, 'asked once, then paused');
  assert.ok(!fs.existsSync(path.join(library, `${T} (3)`)), 'no empty folder');
  siteDetails.resetCaptchaPause();

  // Stopped partway: what was saved stays, and downloading again adds the rest to the same folder.
  asked = 0;
  captchaAfter = 1;
  const partial = await siteDetails.download({ url: URL_, folder: library, profileId: 'all' }, { fetchImpl: robotWorld });
  assert.deepStrictEqual(partial.saved, [defaultFile]);
  assert.deepStrictEqual(partial.missing, ['Other profile']);
  assert.match(partial.warning, /not a robot.*Not downloaded yet: Other profile; download again to add them/);
  siteDetails.resetCaptchaPause();
  captcha = false;
  const rest = await siteDetails.download({ url: URL_, folder: library, profileId: 'all' }, { fetchImpl: robotWorld });
  assert.deepStrictEqual([rest.folder, rest.saved], [partial.folder, [otherFile]], 'the rest, into the same folder');

  // Chosen profiles only; none chosen is refused.
  forget();
  const onlyOther = await siteDetails.download({ url: URL_, folder: library, profileIds: ['1'] }, { fetchImpl: world });
  assert.deepStrictEqual(onlyOther.saved, [otherFile], 'only the ticked profile');
  await assert.rejects(siteDetails.download({ url: URL_, folder: library, profileIds: [] }, { fetchImpl: world }), /Choose the print profiles/);
  const plusDefault = await siteDetails.download({ url: URL_, folder: library, profileIds: ['1', '2'] }, { fetchImpl: world });
  assert.deepStrictEqual([plusDefault.folder, plusDefault.saved], [onlyOther.folder, [defaultFile]], 'the one already there is skipped');

  // The online model is folded into the downloaded files: one model, not two.
  forget();
  const onlinePath = 'url::https://makerworld.com/en/models/3006565';
  const onlineId = database.db
    .prepare(
      "INSERT INTO models (filePath, fileName, source, notes, rating, favorite, print_status, printed, print_count) VALUES (?, 'Gundam', ?, 'my notes', 4, 1, 'printed', 1, 2)"
    )
    .run(onlinePath, 'https://makerworld.com/en/models/3006565').lastInsertRowid;
  database.db.prepare('INSERT INTO model_tags VALUES (?, 7)').run(onlineId);
  database.db.prepare("INSERT INTO collection_models VALUES (3, ?, '2026-10-01')").run(onlineId);
  database.db.prepare('INSERT INTO print_events (model_id) VALUES (?)').run(onlineId);
  database.db.prepare("INSERT INTO share_links VALUES ('tok', 'model', ?)").run(onlineId);
  profileName = '默认参数 3mf';
  const merged = await siteDetails.download({ url: URL_, folder: library, profileId: 'all' }, { fetchImpl: world });
  assert.deepStrictEqual(merged.saved.sort(), [defaultFile, otherFile].sort(), 'MakerWorld\'s own name ("默认参数 3mf") is not used');
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM models WHERE filePath = ?').get(onlinePath).n, 0, 'the online model is gone');
  const mainRow = database.db.prepare('SELECT * FROM models WHERE filePath = ?').get(merged.mainFile);
  const otherRow = database.db.prepare('SELECT * FROM models WHERE filePath = ?').get(path.join(merged.folder, otherFile));
  for (const row of [mainRow, otherRow]) {
    assert.strictEqual(row.notes, 'my notes');
    assert.strictEqual(row.rating, 4);
    assert.ok(database.db.prepare('SELECT 1 FROM model_tags WHERE model_id = ? AND tag_id = 7').get(row.id), 'tags go to every profile');
    assert.ok(database.db.prepare('SELECT 1 FROM collection_models WHERE model_id = ? AND collection_id = 3').get(row.id), 'collections go to every profile');
  }
  assert.strictEqual(mainRow.print_status, 'printed');
  assert.strictEqual(otherRow.print_status, 'unprinted', 'print status stays with the main file');
  assert.strictEqual(database.db.prepare('SELECT model_id FROM print_events').get().model_id, mainRow.id, 'print history moves to the main file');
  assert.strictEqual(database.db.prepare("SELECT target_id FROM share_links WHERE token = 'tok'").get().target_id, mainRow.id, 'share links follow');
  assert.ok(
    !database.db.prepare('SELECT 1 FROM model_tags WHERE model_id = ?').get(onlineId) &&
      !database.db.prepare('SELECT 1 FROM collection_models WHERE model_id = ?').get(onlineId)
  );
  profileName = 'Default.3mf';

  // Files downloaded in a browser: JusttPrint makes the folder, the browser uploads, then they are added.
  const manualOnline = database.db
    .prepare("INSERT INTO models (filePath, fileName, source, notes) VALUES (?, 'Gundam', ?, 'from the browser')")
    .run(onlinePath, 'https://makerworld.com/en/models/3006565').lastInsertRowid;
  const prepared = await siteDetails.prepareManualFolder({ url: URL_, folder: library });
  assert.ok(prepared.folder.startsWith(path.join(library, 'Ultimate Assembly PG Freedom Gundam')));
  fs.writeFileSync(path.join(prepared.folder, 'p1s可打版本1.3mf'), threeMf);
  fs.writeFileSync(path.join(prepared.folder, 'legs.stl'), 'solid x\nendsolid');
  const manual = await siteDetails.finishManualFolder({ url: URL_, folder: prepared.folder, files: ['p1s可打版本1.3mf', 'legs.stl'] });
  assert.strictEqual(prepared.folder, merged.folder, "into the model's folder from the earlier download");
  assert.ok(
    fs.existsSync(path.join(prepared.folder, defaultFile)) && fs.existsSync(path.join(prepared.folder, otherFile)),
    'downloaded profiles keep their names'
  );
  assert.strictEqual(
    manual.mainFile,
    path.join(prepared.folder, 'Ultimate Assembly PG Freedom Gundam.3mf'),
    'the 3MF is the main file, named after the English title'
  );
  assert.ok(fs.existsSync(path.join(prepared.folder, 'legs.stl')), 'parts keep their names');
  assert.ok(!database.db.prepare('SELECT 1 FROM models WHERE id = ?').get(manualOnline), 'the online model became the files');
  assert.strictEqual(database.db.prepare('SELECT notes FROM models WHERE filePath = ?').get(path.join(prepared.folder, 'legs.stl')).notes, 'from the browser');
  await assert.rejects(siteDetails.prepareManualFolder({ url: URL_, folder: '/etc' }), /outside|cannot|library/i);

  // One file: renamed after the model, with its extension; a model the watcher added moves with it.
  const single = fs.mkdtempSync(path.join(library, 'single-'));
  fs.writeFileSync(path.join(single, 'legs.STL'), 'solid x\nendsolid');
  database.db.prepare("INSERT INTO models (filePath, fileName, notes) VALUES (?, 'legs.STL', 'kept')").run(path.join(single, 'legs.STL'));
  assert.strictEqual(siteDetails.nameMainFile(single, { title: '究极拼装PG自由高达' }), '究极拼装PG自由高达.stl', 'no English title: the title');
  assert.deepStrictEqual(fs.readdirSync(single), ['究极拼装PG自由高达.stl']);
  assert.strictEqual(database.db.prepare('SELECT notes FROM models WHERE filePath = ?').get(path.join(single, '究极拼装PG自由高达.stl')).notes, 'kept');
  fs.writeFileSync(path.join(single, 'other.stl'), 'x');
  assert.strictEqual(siteDetails.nameMainFile(single, { title: 'x' }), null, 'several parts and no 3MF: names are kept');

  // Several files: every one gets the online model's tags and notes; the main one its history.
  const { mergeOnlineModel } = require('../src/core/merge-online-model');
  const twoId = database.db
    .prepare("INSERT INTO models (filePath, fileName, notes, print_status) VALUES ('url::https://makerworld.com/en/models/5', 'x', 'n', 'printed')")
    .run().lastInsertRowid;
  database.db.prepare('INSERT INTO model_tags VALUES (?, 8)').run(twoId);
  database.db.prepare('INSERT INTO print_events (model_id) VALUES (?)').run(twoId);
  database.db.prepare("INSERT INTO models (filePath, fileName) VALUES ('/l/a.3mf', 'a'), ('/l/b.stl', 'b')").run();
  assert.strictEqual(mergeOnlineModel(database.db, 'url::https://makerworld.com/en/models/5', ['/l/a.3mf', '/l/b.stl'], '/l/a.3mf'), true);
  const [a, b] = ['/l/a.3mf', '/l/b.stl'].map((p) => database.db.prepare('SELECT * FROM models WHERE filePath = ?').get(p));
  assert.ok(database.db.prepare('SELECT 1 FROM model_tags WHERE model_id = ? AND tag_id = 8').get(b.id) && b.notes === 'n' && b.print_status === 'unprinted');
  assert.strictEqual(a.print_status, 'printed');
  assert.strictEqual(database.db.prepare('SELECT model_id FROM print_events WHERE model_id IN (?, ?)').get(a.id, twoId).model_id, a.id);
  assert.strictEqual(mergeOnlineModel(database.db, '/l/a.3mf', ['/l/b.stl'], '/l/b.stl'), false, 'only online models are folded in');

  // Add Links downloads every profile; the one in the link is the main file. On failure the online model is added.
  database.db.prepare('DELETE FROM models').run();
  forget();
  const { importLink } = require('../src/server/link-import');
  const linkDeps = {
    db: database.db,
    fetchImpl: world,
    download: (request, options) => siteDetails.download(request, { ...options, fetchImpl: world }),
    saveModel: async (model) =>
      database.db
        .prepare('INSERT INTO models (filePath, fileName, designer, source) VALUES (?, ?, ?, ?)')
        .run(model.filePath, model.fileName, model.designer || null, model.source),
    saveThumbnail: async () => {}
  };
  const viaLinks = await importLink('https://makerworld.com/en/models/3006565-x?from=recommend#profileId-1', linkDeps, { downloadFolder: library });
  assert.strictEqual(viaLinks.status, 'downloaded');
  assert.deepStrictEqual(viaLinks.saved.sort(), [defaultFile, otherFile].sort(), JSON.stringify(viaLinks));
  assert.strictEqual(path.basename(viaLinks.filePath), otherFile, 'the profile in the link is the main file');
  assert.strictEqual(database.db.prepare("SELECT COUNT(*) AS n FROM models WHERE filePath LIKE 'url::%'").get().n, 0, 'no online model next to the files');
  assert.strictEqual(
    (await importLink('https://makerworld.com/en/models/3006565', linkDeps, { downloadFolder: library })).status,
    'exists',
    'downloaded files count as already in the library'
  );
  database.db.prepare('DELETE FROM models').run();
  forget();
  database.db.prepare('DELETE FROM models').run();
  forget();
  const ticked = await importLink('https://makerworld.com/en/models/3006565', linkDeps, { downloadFolder: library, profileIds: ['2'] });
  assert.deepStrictEqual(ticked.saved, [defaultFile], 'Add Links downloads the ticked profiles');
  database.db.prepare('DELETE FROM models').run();
  forget();
  const noneTicked = await importLink('https://makerworld.com/en/models/3006565', linkDeps, { downloadFolder: library, profileIds: [] });
  assert.strictEqual(noneTicked.status, 'added', 'no profile ticked: the online model only');
  database.db.prepare('DELETE FROM models').run();
  forget();
  const notWritable = await importLink('https://makerworld.com/en/models/3006565', linkDeps, { downloadFolder: '/etc' });
  assert.strictEqual(notWritable.status, 'added');
  assert.match(notWritable.warning, /Not downloaded: .*Added as an online model/);
  database.db.prepare('DELETE FROM models').run();

  // Older downloads (not tracked): the single main file is named after the English title, once.
  database.db.prepare('DELETE FROM models').run();
  database.db.prepare('DELETE FROM site_files').run();
  const oldDir = path.join(library, 'old download');
  const mixedDir = path.join(library, 'mixed');
  fs.mkdirSync(oldDir);
  fs.mkdirSync(mixedDir);
  for (const [dir, name, source] of [
    [oldDir, 'Default parameters no supports.3mf', 'https://makerworld.com/en/models/3006565'],
    [oldDir, 'legs.stl', 'https://makerworld.com/en/models/3006565'],
    [mixedDir, 'p1s.3mf', 'https://makerworld.com/en/models/3006565'],
    [mixedDir, 'benchy.stl', 'https://www.printables.com/model/3161']
  ]) {
    fs.writeFileSync(path.join(dir, name), 'x');
    database.db.prepare("INSERT INTO models (filePath, fileName, source, notes) VALUES (?, ?, ?, 'kept')").run(path.join(dir, name), name, source);
  }
  assert.strictEqual(await siteDetails.renameOlderDownloads({ fetchImpl: world }), 1);
  assert.deepStrictEqual(fs.readdirSync(oldDir).sort(), [`${T}.3mf`, 'legs.stl'].sort(), 'the 3MF takes the title; parts keep their names');
  assert.strictEqual(
    database.db.prepare('SELECT notes FROM models WHERE filePath = ?').get(path.join(oldDir, `${T}.3mf`)).notes,
    'kept',
    'the model moves with its file'
  );
  assert.deepStrictEqual(fs.readdirSync(mixedDir).sort(), ['benchy.stl', 'p1s.3mf'], 'a folder with other models is left alone');
  fs.renameSync(path.join(oldDir, `${T}.3mf`), path.join(oldDir, 'again.3mf'));
  database.db.prepare('UPDATE models SET filePath = ? WHERE filePath = ?').run(path.join(oldDir, 'again.3mf'), path.join(oldDir, `${T}.3mf`));
  assert.strictEqual(await siteDetails.renameOlderDownloads({ fetchImpl: world }), 0, 'only once');
  assert.strictEqual(await siteDetails.renameOlderDownloads({ fetchImpl: world, force: true }), 1);
  database.db.prepare('DELETE FROM models').run();

  // A folder JusttPrint may not write to is caught before anything is downloaded.
  const locked = path.join(library, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o555);
  if (process.getuid && process.getuid() !== 0) {
    assert.match(siteDetails.checkFolder(locked).error || '', /may not write to/);
    await assert.rejects(
      siteDetails.download(
        { url: URL_, folder: locked },
        {
          fetchImpl: () => {
            throw new Error('must not be fetched');
          }
        }
      ),
      /may not write to/
    );
  }
  fs.chmodSync(locked, 0o755);
  assert.deepStrictEqual(siteDetails.checkFolder(library), { ok: true, error: null });

  account.signOut();
  await assert.rejects(siteDetails.download({ url: URL_, folder: library }, { fetchImpl: world }), (error) => error.code === 'SIGN_IN');
  assert.ok(!siteDetails.isAllowedDownloadUrl('http://makerworld.bblmw.com/x') && !siteDetails.isAllowedDownloadUrl('https://bblmw.com.evil.example/x'));

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('makerworld tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
