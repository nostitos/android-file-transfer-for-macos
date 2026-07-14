import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const iconPath = resolve(root, 'build/icon.icns');
const iconSourcePath = resolve(root, 'build/app-icon.svg');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

assert.equal(
  packageJson.build?.mac?.icon,
  'build/icon.icns',
  'macOS package must use the first-party app icon, not Electron defaults.'
);
assert.ok(existsSync(iconPath), 'build/icon.icns must exist for macOS packaging.');
assert.ok(existsSync(iconSourcePath), 'build/app-icon.svg must keep the editable icon source.');
assert.ok(statSync(iconPath).size > 20_000, 'App icon must be a real multi-size .icns asset.');

const iconSource = readFileSync(iconSourcePath, 'utf8');
assert.match(iconSource, /Android File Transfer for macOS|phone|#245d7a|#52634a/s, 'Icon source should be project-owned artwork.');
assert.doesNotMatch(iconSource, /openmtp|ganeshrvel/i, 'Icon source must not reuse OpenMTP branding.');

console.log('Package icon contract check passed.');
