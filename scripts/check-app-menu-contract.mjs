import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readProjectFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

const [types, main, preload, app] = await Promise.all([
  readProjectFile('src/shared/types.ts'),
  readProjectFile('src/main/index.ts'),
  readProjectFile('src/preload/index.ts'),
  readProjectFile('src/renderer/src/App.tsx')
]);

assert.match(types, /export type AppMenuCommand/, 'Shared types must define app menu commands.');
assert.match(types, /onAppMenuCommand: \(callback: \(command: AppMenuCommand\) => void\)/, 'MtpApi must expose app menu command events.');

assert.match(main, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\)/, 'Main process must install a custom application menu.');
assert.match(main, /webContents\.send\('app-menu:command', command\)/, 'Main process must forward menu commands to the renderer.');
assert.match(main, /accelerator:\s*'CommandOrControl\+N'[\s\S]*'new-folder'/, 'Menu must expose New Folder.');
assert.match(main, /label:\s*'Copy File Selection'[\s\S]*'copy-selection'/, 'Menu must expose safe file-selection copy.');
assert.match(main, /label:\s*'Paste File Selection'[\s\S]*'paste-selection'/, 'Menu must expose safe file-selection paste.');
assert.match(main, /accelerator:\s*'CommandOrControl\+Shift\+C'[\s\S]*'copy-to-queue'/, 'Menu must expose Copy to Queue.');
assert.match(main, /accelerator:\s*'CommandOrControl\+B'[\s\S]*'folder-up'/, 'Menu must expose Folder Up.');
assert.match(main, /label:\s*'Check Phone Now'[\s\S]*accelerator:\s*'CommandOrControl\+R'[\s\S]*'refresh'/, 'Menu must expose Check Phone Now.');
assert.match(main, /accelerator:\s*'CommandOrControl\+1'[\s\S]*'focus-phone'/, 'Menu must expose Focus Phone Pane.');
assert.match(main, /accelerator:\s*'CommandOrControl\+2'[\s\S]*'focus-mac'/, 'Menu must expose Focus Mac Pane.');
assert.match(main, /label:\s*'Show\/Hide Hidden Files'[\s\S]*'toggle-hidden-files'/, 'Menu must expose hidden-file visibility.');
assert.doesNotMatch(main, /Backspace|Delete Phone|delete-phone|rename-phone/, 'Native menu must not expose destructive phone actions in v1.');

assert.match(preload, /ipcRenderer\.on\('app-menu:command', listener\)/, 'Preload must subscribe to app menu commands.');
assert.match(preload, /ipcRenderer\.off\('app-menu:command', listener\)/, 'Preload must unsubscribe app menu commands.');

assert.match(app, /function handleAppMenuCommand\(command: AppMenuCommand\)/, 'Renderer must handle app menu commands.');
assert.match(app, /case 'new-folder':[\s\S]*openNewFolderDialog\(\)/, 'Renderer menu handler must open New Folder.');
assert.match(app, /case 'copy-selection':[\s\S]*copyActivePaneSelectionToClipboard\(\)/, 'Renderer menu handler must copy the file selection.');
assert.match(app, /case 'paste-selection':[\s\S]*pasteTransferClipboard\(\)/, 'Renderer menu handler must paste the file selection.');
assert.match(app, /case 'copy-to-queue':[\s\S]*copyActivePaneSelectionToQueue\(\)/, 'Renderer menu handler must copy to queue.');
assert.match(app, /case 'folder-up':[\s\S]*goUpActivePane\(\)/, 'Renderer menu handler must go folder up.');
assert.match(app, /case 'focus-phone':[\s\S]*focusPhonePane\(\)/, 'Renderer menu handler must focus the phone pane.');
assert.match(app, /case 'focus-mac':[\s\S]*focusMacPane\(\)/, 'Renderer menu handler must focus the Mac pane.');
assert.match(app, /case 'toggle-hidden-files':[\s\S]*toggleHiddenFiles\(\)/, 'Renderer menu handler must toggle hidden-file visibility.');
assert.match(app, /case 'select-all':[\s\S]*selectAllActiveContext\(\)/, 'Renderer menu handler must preserve Select All behavior.');
assert.match(app, /onAppMenuCommand\(handleAppMenuCommand\)/, 'Renderer must register the menu command listener.');

console.log('App menu contract check passed.');
