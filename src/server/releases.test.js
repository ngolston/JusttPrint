#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { releasesApiUrl, releasesPageUrl, latestVersionFromReleases } = require('./releases');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

test('stable users read the latest release, beta users the release list', () => {
  assert.match(releasesApiUrl(false), /\/repos\/ngolston\/JusttPrint\/releases\/latest$/);
  assert.match(releasesApiUrl(true), /\/repos\/ngolston\/JusttPrint\/releases\?per_page=20$/);
  assert.strictEqual(releasesPageUrl(false), 'https://github.com/ngolston/JusttPrint/releases/latest');
});

test('the tag becomes a plain version number', () => {
  assert.strictEqual(latestVersionFromReleases({ tag_name: 'v2.3.0' }, false), '2.3.0');
  assert.strictEqual(latestVersionFromReleases({ tag_name: '2.4' }, false), '2.4');
  assert.strictEqual(latestVersionFromReleases({ tag_name: 'nightly' }, false), null);
});

test('beta picks the newest release including pre-releases; stable skips them', () => {
  const list = [
    { tag_name: 'v2.5.0', draft: true },
    { tag_name: 'v2.4.0-beta', prerelease: true },
    { tag_name: 'v2.4.0', prerelease: true },
    { tag_name: 'v2.3.0' }
  ];
  assert.strictEqual(latestVersionFromReleases(list, true), '2.4.0', 'drafts and non-numeric tags are skipped');
  assert.strictEqual(latestVersionFromReleases(list, false), '2.3.0');
});

test('no releases means no version', () => {
  assert.strictEqual(latestVersionFromReleases([], true), null);
  assert.strictEqual(latestVersionFromReleases({ message: 'Not Found' }, false), null);
});
