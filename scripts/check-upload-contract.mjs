import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const [app, main, native] = await Promise.all([
  readFile(resolve(root, 'src/renderer/src/App.tsx'), 'utf8'),
  readFile(resolve(root, 'src/main/index.ts'), 'utf8'),
  readFile(resolve(root, 'src/native/mtp-json.c'), 'utf8')
]);

assert.match(app, /planLocalEntriesForUpload/, 'Folder upload planning must remain present.');
assert.match(app, /if \(!result\.ok\)[\s\S]*Could not check the destination phone folder/, 'A failed destination listing must stop upload planning.');
assert.match(app, /if \(existing\) \{\s*conflictCount \+= 1;\s*return;/, 'Every same-name destination item must be treated as a conflict.');
assert.doesNotMatch(app, /existing\.size[\s\S]{0,120}skippedDuplicate/, 'Name and size must not be treated as content identity.');
assert.match(app, /MAX_PLANNED_MAC_FOLDERS/, 'Recursive upload planning must cap folder count.');
assert.match(app, /MAX_PLANNED_MAC_DEPTH/, 'Recursive upload planning must cap depth.');

assert.match(main, /local symbolic link skipped during phone upload planning/, 'Local upload traversal must skip symlinks.');
assert.match(main, /const sourceStat = lstatSync\(request\.sourcePath\)/, 'Upload enqueue must revalidate sources without following symlinks.');
assert.match(main, /deviceConnectionId: request\.deviceConnectionId/, 'Upload jobs must remain bound to the selected phone attachment.');

assert.match(native, /if \(lstat\(source, &source_stat\) != 0\)/, 'The native upload helper must not follow source symlinks.');
assert.match(native, /strcmp\(current->filename, filename\) == 0[\s\S]*status = 2/, 'Any same-name phone item must block an upload.');
assert.doesNotMatch(native, /return -6|skippedDuplicate/, 'The native helper must not claim same-size files are duplicates.');
assert.match(native, /Nothing was overwritten/, 'Name conflicts must be reported as non-destructive failures.');

console.log('Upload safety contract check passed.');
