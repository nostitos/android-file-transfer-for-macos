import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readProjectFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

const [types, main, preload, app, styles, readme, checklist, architecture] = await Promise.all([
  readProjectFile('src/shared/types.ts'),
  readProjectFile('src/main/index.ts'),
  readProjectFile('src/preload/index.ts'),
  readProjectFile('src/renderer/src/App.tsx'),
  readProjectFile('src/renderer/src/styles.css'),
  readProjectFile('README.md'),
  readProjectFile('docs/manual-test-checklist.md'),
  readProjectFile('docs/architecture.md')
]);

assert.match(
  types,
  /listLocalDirectory: \(directoryPath\?: string, showHiddenFiles\?: boolean\)/,
  'Local directory IPC must accept the hidden-file visibility preference.'
);

assert.match(
  types,
  /'toggle-hidden-files'/,
  'The app menu command type must include hidden-file visibility.'
);

assert.match(
  preload,
  /listLocalDirectory: \(directoryPath\?: string, showHiddenFiles\?: boolean\)[\s\S]*ipcRenderer\.invoke\('local:listDirectory', directoryPath, showHiddenFiles\)/,
  'Preload must forward hidden-file visibility to the main process.'
);

assert.match(
  main,
  /function listLocalDirectory\(directoryPath\?: string, showHiddenFiles = false\)/,
  'Main process must make local hidden-file listing explicit and default to hidden.'
);

assert.match(
  main,
  /!showHiddenFiles && entry\.name\.startsWith\('\.'\)/,
  'Main process must filter Mac dotfiles unless the user enables hidden files.'
);

assert.match(
  main,
  /label:\s*'Show\/Hide Hidden Files'[\s\S]*'toggle-hidden-files'/,
  'View menu must expose hidden-file visibility.'
);

assert.match(
  app,
  /SHOW_HIDDEN_STORAGE_KEY\s*=\s*'androidFileTransferForMacOS\.showHiddenFiles'/,
  'Renderer must persist the hidden-file visibility preference.'
);

assert.match(
  app,
  /function isHiddenFileName\(name: string\): boolean[\s\S]*name\.startsWith\('\.'\)/,
  'Renderer must define the same hidden-name rule for phone rows.'
);

assert.match(
  app,
  /visibleLocationRows[\s\S]*showHiddenFiles \|\| row\.kind === 'storage' \|\| !isHiddenFileName\(row\.name\)/,
  'Phone rows must hide dotfiles and dotfolders unless the user enables hidden files.'
);

assert.match(
  app,
  /className=\{`icon-button hidden-files-toggle \$\{showHiddenFiles \? 'active' : ''\}`\}/,
  'Toolbar must expose a stateful hidden-file toggle.'
);

assert.match(
  app,
  /case 'toggle-hidden-files':[\s\S]*toggleHiddenFiles\(\)/,
  'Renderer must handle the View menu hidden-file command.'
);

assert.match(
  styles,
  /\.icon-button\.active[\s\S]*var\(--row-selected-bg\)/,
  'Hidden-file toggle must have a visible active state.'
);

assert.match(readme, /Show or hide hidden files/, 'README must document hidden-file visibility.');
assert.match(checklist, /hidden files/, 'Manual checklist must cover hidden-file visibility.');
assert.match(architecture, /hidden-file visibility/i, 'Architecture note must describe hidden-file visibility.');

console.log('Hidden files contract check passed.');
