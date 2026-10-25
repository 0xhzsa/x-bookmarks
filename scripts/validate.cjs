#!/usr/bin/env node
// Validates the shipped package before it becomes a release. Not a test suite:
// it only checks the things a broken store upload would fail on.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'twtr');
const fail = (msg) => {
  console.error('FAIL ' + msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log('ok   ' + msg);

const manifestPath = path.join(ext, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  fail('twtr/manifest.json is missing');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
else ok('manifest_version 3');

if (!/^\d+\.\d+(\.\d+)?$/.test(manifest.version)) fail('version is not semver: ' + manifest.version);
else ok('version ' + manifest.version);

const tag = (process.env.GITHUB_REF_NAME || '').replace(/^v/, '');
if (tag && tag !== manifest.version) {
  fail(`tag ${tag} does not match manifest version ${manifest.version}`);
} else if (tag) {
  ok('tag matches manifest version');
}

const required = new Set(['background.js', 'content.js', 'capture.js', 'popup.html', 'popup.js', 'styles.css', 'lib/match.js']);
for (const cs of manifest.content_scripts || []) {
  for (const f of cs.js || []) required.add(f);
  for (const f of cs.css || []) required.add(f);
}
for (const size of Object.values((manifest.icons || {}))) required.add(size);
for (const size of Object.values((manifest.action && manifest.action.default_icon) || {})) required.add(size);
if (manifest.background && manifest.background.service_worker) required.add(manifest.background.service_worker);
if (manifest.action && manifest.action.default_popup) required.add(manifest.action.default_popup);

for (const file of required) {
  const p = path.join(ext, file);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) fail('missing or empty: twtr/' + file);
}
if (!process.exitCode) ok(required.size + ' referenced files present');

const popup = fs.readFileSync(path.join(ext, 'popup.html'), 'utf8');
if (/<script[^>]+src=["']https?:/i.test(popup)) fail('popup loads a remote script');
else ok('no remote scripts in popup');

// The donation address is the one string where a typo costs money. Check the
// package and the README carry the same, valid EVM address.
const address = '0xe75fe7492D16dB9f133dA20De2F2a1AA68406977';
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail('donation address is not a valid EVM address');
else if (!popup.includes(address)) fail('popup does not show the donation address');
else if (!readme.includes(address)) fail('README does not show the donation address');
else ok('donation address valid and present in popup and README');

for (const doc of ['README.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md']) {
  if (!fs.existsSync(path.join(root, doc))) fail('missing ' + doc);
}

if (manifest.description && manifest.description.length > 132) {
  fail('description is longer than the store limit (132): ' + manifest.description.length);
} else {
  ok('store description length ' + (manifest.description || '').length + '/132');
}

if (process.exitCode) {
  console.error('\npackage check failed');
  process.exit(1);
}
console.log('\npackage check passed for ' + manifest.name + ' ' + manifest.version);
