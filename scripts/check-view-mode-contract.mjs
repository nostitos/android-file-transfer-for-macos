import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readProjectFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

const [app, styles] = await Promise.all([
  readProjectFile('src/renderer/src/App.tsx'),
  readProjectFile('src/renderer/src/styles.css')
]);

assert.match(app, /type PhoneViewMode = 'list' \| 'grid'/, 'Renderer must model list and grid phone view modes.');
assert.match(app, /VIEW_MODE_STORAGE_KEY/, 'Phone view mode must have a stable storage key.');
assert.match(app, /readStoredPhoneViewMode/, 'Renderer must read the saved phone view mode.');
assert.match(app, /return stored === 'grid' \|\| stored === 'list' \? stored : 'list'/, 'List view must remain the default.');
assert.match(app, /setItem\(VIEW_MODE_STORAGE_KEY,\s*phoneViewMode\)/, 'Renderer must persist the selected phone view mode.');
assert.match(app, /className="view-switch"/, 'Toolbar must expose a compact list/grid switch.');
assert.match(app, /setPhoneViewMode\('list'\)/, 'View switch must include list view.');
assert.match(app, /setPhoneViewMode\('grid'\)/, 'View switch must include grid view.');
assert.match(app, /phoneViewMode === 'grid' && rows\.length > 0/, 'Renderer must render a grid for phone rows.');
assert.match(app, /className=\{`file-tile/, 'Grid view must render selectable file tiles.');
assert.match(app, /onDragStart=\{\(event\) => startFileDrag\(row, event\)\}/, 'Grid view must reuse phone drag preparation.');
assert.match(app, /onDoubleClick=\{\(\) => openRow\(row\)\}/, 'Grid view must support opening storage and folders.');
assert.match(app, /function getPhoneGridColumnCount\(\)/, 'Grid view must derive a keyboard column count.');
assert.match(app, /phoneViewMode === 'grid'[\s\S]*ArrowRight[\s\S]*movePhoneSelection\(1,\s*event\.shiftKey\)/, 'Grid Right Arrow must move selection instead of opening.');
assert.match(app, /phoneViewMode === 'grid'[\s\S]*ArrowLeft[\s\S]*movePhoneSelection\(-1,\s*event\.shiftKey\)/, 'Grid Left Arrow must move selection instead of folder up.');
assert.match(app, /phoneViewMode === 'grid'[\s\S]*movePhoneSelection\(columnCount,\s*event\.shiftKey\)/, 'Grid Down Arrow must move by one grid row.');
assert.match(app, /phoneViewMode === 'grid'[\s\S]*movePhoneSelection\(-columnCount,\s*event\.shiftKey\)/, 'Grid Up Arrow must move by one grid row.');

assert.match(styles, /\.view-switch/, 'View switch must have dedicated styling.');
assert.match(styles, /\.file-grid/, 'Grid view must have a stable grid layout.');
assert.match(styles, /\.file-tile/, 'Grid view must have stable tile styling.');
assert.match(styles, /\.app-shell\[data-theme='dark'\] \.file-tile/, 'Grid view must be covered by dark mode.');

console.log('View mode contract check passed.');
