import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readProjectFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

const [app, readme, checklist, architecture] = await Promise.all([
  readProjectFile('src/renderer/src/App.tsx'),
  readProjectFile('README.md'),
  readProjectFile('docs/manual-test-checklist.md'),
  readProjectFile('docs/architecture.md')
]);

assert.match(
  app,
  /function phoneNeedsUnlockOrAllow\(/,
  'Renderer must explicitly classify visible phones that may still need unlock or Allow.'
);

assert.match(
  app,
  /function phoneFileSessionNotOpen\(/,
  'Renderer must explicitly classify visible MTP phones whose file session is not open.'
);

assert.match(
  app,
  /interface ConnectionStageItem/,
  'Renderer must expose a compact connection-stage model for regular users.'
);

assert.match(
  app,
  /const connectionStages = useMemo<ConnectionStageItem\[\]>/,
  'Renderer must derive connection-stage rows from live state instead of free-form error text.'
);

assert.match(
  app,
  /label: 'Open files'[\s\S]*Press Open files, then enter your Mac login password\./,
  'Connection stages must explain the current Open files action in plain language.'
);

assert.match(
  app,
  /label: 'Storage'[\s\S]*did not return storage information/,
  'Connection stages must distinguish storage discovery failure from raw USB visibility.'
);

assert.match(
  app,
  /className="connection-stages"/,
  'Sidebar must show the compact connection-stage strip.'
);

assert.match(
  app,
  /className="connection-stages main"/,
  'Main connection help must show the same stage strip near the recovery instructions.'
);

assert.match(
  app,
  /return 'USB visible';/,
  'Top connection status must expose visible USB/MTP separately from readable phone files.'
);

assert.match(
  app,
  /File session[\s\S]*fileSessionStatus/,
  'Details must show the file-session state separately from raw USB visibility.'
);

assert.match(
  app,
  /return 'Unlock phone';/,
  'Top connection status must expose a locked or permission-waiting phone as Unlock phone.'
);

assert.match(
  app,
  /Unlock the phone and tap Allow if Android asks to open file access\./,
  'Connection status tooltip must tell regular users how to answer the phone permission prompt.'
);

assert.match(
  app,
  /Unlock the phone and allow file access\./,
  'Main connection help must use plain locked-phone wording.'
);

assert.match(
  app,
  /If Android asks to allow access to phone data, tap Allow\./,
  'Locked-phone guidance must explain the Android Allow prompt.'
);

assert.match(
  app,
  /has not allowed file access\. Unlock it and tap Allow if asked\./,
  'Manual Check now feedback must explain locked or permission-waiting phones.'
);

assert.match(
  readme,
  /locked phone or Android Allow prompt/,
  'README must document the locked-phone connection state.'
);

assert.match(
  checklist,
  /Unlock phone/,
  'Manual checklist must cover the explicit locked-phone state.'
);

assert.match(
  architecture,
  /locked-phone\/permission-waiting state/,
  'Architecture note must document the locked-phone heuristic.'
);

console.log('Connection states contract check passed.');
