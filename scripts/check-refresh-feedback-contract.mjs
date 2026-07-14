import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readProjectFile(path) {
  return readFile(resolve(root, path), 'utf8');
}

const [app, checklist, architecture] = await Promise.all([
  readProjectFile('src/renderer/src/App.tsx'),
  readProjectFile('docs/manual-test-checklist.md'),
  readProjectFile('docs/architecture.md')
]);

assert.match(app, /function renderRefreshFeedback\(\): JSX\.Element \| null/, 'Refresh feedback must render from one shared compact helper.');
assert.match(app, /className=\{`refresh-feedback \$\{refreshFeedback\.phase\} sidebar`\}/, 'Refresh feedback must render only in the sidebar.');
assert.doesNotMatch(app, /renderRefreshFeedback\('banner'\)/, 'Refresh feedback must not be duplicated in the main browser banner.');
assert.match(app, /const AUTO_PHONE_CHECK_INTERVAL_MS = 3000;/, 'Automatic phone checks must run every 3 seconds.');
assert.match(app, /setInterval\(\(\) => \{[\s\S]*pollForPhone\(\)[\s\S]*AUTO_PHONE_CHECK_INTERVAL_MS\)/, 'Polling must use the shared 3-second auto-check interval.');
assert.match(app, /const pollInFlight = useRef\(false\)/, 'Automatic checks must have a dedicated single-flight guard.');
assert.match(app, /scanInFlight\.current \|\| pollInFlight\.current/, 'A timer tick must not overlap a scan or prior poll.');
assert.match(app, /finally \{\s*pollInFlight\.current = false;/, 'The polling guard must reset on success and failure.');
assert.doesNotMatch(app, /autoCheckStatusText|auto-check-status|Auto-checks every 3 sec\./, 'Automatic polling must not add persistent status noise to the sidebar.');
assert.match(app, /className="auto-check-note"[\s\S]*No need to refresh\./, 'Simple waiting panels must not make manual refresh the primary action.');
assert.match(app, /phone files are still not open\. Use Open files or Details\./, 'Manual check failure copy must stay concise.');
assert.match(app, /Optional: check now instead of waiting for the next automatic check\./, 'Sidebar check button must be framed as optional.');
assert.match(app, /Check now repeats the automatic check\./, 'Blocked-phone copy must position Check now as secondary.');
assert.match(checklist, /Check now feedback appears once/, 'Manual checklist must cover single-location Check now feedback.');
assert.match(architecture, /checks automatically every 3 seconds/, 'Architecture docs must explain the automatic check interval.');

console.log('Refresh feedback contract check passed.');
