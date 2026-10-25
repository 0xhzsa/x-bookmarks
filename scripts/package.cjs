#!/usr/bin/env node
// Builds dist/x-bookmarks-<version>.zip with manifest.json at the archive root,
// which is what both Chrome Web Store and Edge Add-ons expect.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'twtr');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const dist = path.join(root, 'dist');
const zip = path.join(dist, `x-bookmarks-${manifest.version}.zip`);

fs.mkdirSync(dist, { recursive: true });
if (fs.existsSync(zip)) fs.unlinkSync(zip);

let run;
if (process.platform === 'win32') {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${ext}', '${zip}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
  ].join('; ');
  run = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
} else {
  run = spawnSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: ext, stdio: 'inherit' });
}

if (run.status !== 0) {
  console.error('zip failed');
  process.exit(1);
}

// A store upload with manifest.json one level down is rejected, so prove the
// root entry exists rather than assuming the archiver behaved.
if (process.platform === 'win32') {
  const list = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${zip}').Entries.FullName -join [Environment]::NewLine`],
    { encoding: 'utf8' }
  );
  const names = (list.stdout || '').split(/\r?\n/).filter(Boolean);
  if (!names.includes('manifest.json')) {
    console.error('manifest.json is not at the zip root: ' + names.slice(0, 5).join(', '));
    process.exit(1);
  }
  console.log(`${names.length} files in ${path.basename(zip)}`);
}

const size = fs.statSync(zip).size;
console.log(`${path.relative(root, zip)}  ${(size / 1024).toFixed(0)} KB`);
