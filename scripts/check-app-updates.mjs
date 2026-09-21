import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readProjectFile = (path) => readFile(resolve(root, path), 'utf8');

const updateSource = await readProjectFile('src/shared/appUpdate.ts');
const outDir = resolve(root, '.tmp');
const outPath = resolve(outDir, 'app-update-check.mjs');
await mkdir(outDir, { recursive: true });
await writeFile(outPath, ts.transpileModule(updateSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText, 'utf8');

const { compareSemanticVersions, normalizeSemanticVersion, selectLatestRelease } = await import(
  `${pathToFileURL(outPath).href}?t=${Date.now()}`
);

assert.equal(compareSemanticVersions('1.10.0', '1.9.9'), 1);
assert.equal(compareSemanticVersions('1.0.0', '1.0.0-rc.2'), 1);
assert.equal(compareSemanticVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
assert.equal(compareSemanticVersions('1.0.0-2', '1.0.0-alpha'), -1);
assert.equal(compareSemanticVersions('1.0.0+build.9', '1.0.0+build.1'), 0);
assert.equal(compareSemanticVersions('not-a-version', '1.0.0'), null);
assert.equal(normalizeSemanticVersion('v2.3.4-beta.1+build.8'), '2.3.4-beta.1');
assert.equal(normalizeSemanticVersion('v01.2.3'), null);

const githubRelease = ({ id, tag, draft = false, prerelease = false, publishedAt }) => ({
  url: `https://api.github.com/repos/nostitos/android-file-transfer-for-macos/releases/${id}`,
  html_url: `https://github.com/nostitos/android-file-transfer-for-macos/releases/tag/${tag}`,
  id,
  tag_name: tag,
  target_commitish: 'main',
  name: tag,
  draft,
  prerelease,
  created_at: publishedAt,
  published_at: publishedAt,
  assets: []
});

assert.deepEqual(
  selectLatestRelease('0.1.0', [
    githubRelease({ id: 105, tag: 'v9.0.0', draft: true, publishedAt: '2026-07-15T14:00:00Z' }),
    githubRelease({ id: 104, tag: 'release-two', publishedAt: '2026-07-15T13:00:00Z' }),
    githubRelease({
      id: 103,
      tag: 'v0.3.0-beta.10',
      prerelease: true,
      publishedAt: '2026-07-15T12:00:00Z'
    }),
    githubRelease({ id: 102, tag: 'v0.1.1', publishedAt: '2026-07-14T12:00:00Z' }),
    githubRelease({ id: 101, tag: 'v0.2.0', publishedAt: '2026-07-13T12:00:00Z' })
  ]),
  { version: '0.2.0', tag: 'v0.2.0' }
);
assert.deepEqual(
  selectLatestRelease('0.9.0', [
    githubRelease({ id: 201, tag: 'v0.9.9', publishedAt: '2026-07-15T12:00:00Z' }),
    githubRelease({ id: 202, tag: 'v0.10.0', publishedAt: '2026-07-14T12:00:00Z' })
  ]),
  { version: '0.10.0', tag: 'v0.10.0' }
);
assert.equal(selectLatestRelease('1.0.0', [{ tag_name: 'v1.0.0' }, { tag_name: 'v0.9.9' }]), null);

const [types, main, preload, app, styles, menuCheck, packageJson] = await Promise.all([
  readProjectFile('src/shared/types.ts'),
  readProjectFile('src/main/index.ts'),
  readProjectFile('src/preload/index.ts'),
  readProjectFile('src/renderer/src/App.tsx'),
  readProjectFile('src/renderer/src/styles.css'),
  readProjectFile('scripts/check-app-menu-contract.mjs'),
  readProjectFile('package.json')
]);

assert.match(types, /interface AppUpdateCheckResult/);
assert.match(types, /checkForUpdates: \(interactive\?: boolean\)/);
assert.match(types, /openUpdateRelease: \(releaseTag: string\)/);
assert.match(main, /UPDATE_CHECK_TIMEOUT_MS/);
assert.match(main, /UPDATE_RESPONSE_MAX_BYTES/);
assert.match(main, /net\.fetch\(GITHUB_RELEASES_API/);
assert.match(main, /selectLatestRelease\(currentVersion/);
assert.match(main, /updateCheckInFlight/);
assert.match(main, /GITHUB_RELEASES_WEB.*github\.com\/nostitos\/android-file-transfer-for-macos\/releases\/tag/s);
assert.match(main, /normalizeSemanticVersion\(releaseTag\)/);
assert.match(main, /label:\s*'Check for Updates\.\.\.'/);
assert.match(main, /ipcMain\.handle\('app:checkForUpdates'/);
assert.match(main, /ipcMain\.handle\('app:openUpdateRelease'/);
assert.match(preload, /ipcRenderer\.invoke\('app:checkForUpdates'/);
assert.match(preload, /ipcRenderer\.invoke\('app:openUpdateRelease'/);
assert.match(app, /AUTO_UPDATE_CHECK_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/);
assert.match(app, /automaticUpdateCheckIsDue/);
assert.match(app, /case 'check-for-updates':[\s\S]*checkAppUpdates\(true\)/);
assert.match(app, /appUpdate\?\.status === 'update-available'/);
assert.match(styles, /\.update-action\.available/);
assert.match(menuCheck, /Check for Updates/);
assert.match(packageJson, /"check:app-updates"/);

console.log('App update behavior and contract check passed.');
