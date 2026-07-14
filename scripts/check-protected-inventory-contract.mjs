import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(resolve(root, 'src/main/index.ts'), 'utf8');
const native = readFileSync(resolve(root, 'src/native/mtp-json.c'), 'utf8');

assert.doesNotMatch(main, /killall|camera_guard/, 'Protected access must not terminate global camera services.');
assert.match(main, /version: 3/, 'Old protected-session manifests must be invalidated.');
assert.match(main, /androidFileTransferForMacOS-protected-/, 'Protected runtime files need a dedicated root-owned directory.');
assert.match(main, /privilegedIpcDir/, 'Protected-session IPC must live inside the protected runtime directory.');
assert.match(main, /\/bin\/chmod 711[^\n]*privilegedIpcDir/, 'The user may traverse, but not replace, protected IPC paths.');
assert.match(main, /MAC_ANDROID_TRANSFER_REQUIRE_PRIVILEGE_DROP=1/, 'The elevated runner must require privilege drop.');
assert.match(main, /\/usr\/bin\/env -i/, 'The protected helper must start with a controlled environment.');
assert.match(main, /readyPayloadMatchesConnection/g, 'Opened helpers must be checked against the requested USB attachment.');
assert.match(main, /for \(const rawDevice of candidates\)/, 'Inventory must inspect each visible MTP phone.');
assert.match(main, /connectionId,\s*protectedAccess: useProtectedAccess/, 'Each inventory device must retain its own access mode and identity.');
assert.match(main, /immediately returns to your normal account permissions/, 'The password prompt must explain the privilege boundary.');

assert.match(native, /drop_protected_session_privileges\(\)/, 'The helper must implement privilege drop.');
assert.match(native, /initgroups[\s\S]*setgid[\s\S]*setuid/, 'Supplementary groups, gid, and uid must all be dropped.');
const sessionBody = native.slice(native.indexOf('static int command_session'));
const openIndex = sessionBody.indexOf('LIBMTP_Open_Raw_Device_Uncached');
const dropIndex = sessionBody.indexOf('drop_protected_session_privileges');
const readyIndex = sessionBody.indexOf('MTP session opened.');
assert.ok(openIndex >= 0 && openIndex < dropIndex && dropIndex < readyIndex, 'Only USB open may happen before privilege drop.');
assert.match(native, /#define INFERRED_STORAGE_ID 0xfffffffeu/, 'Unknown storage must use an explicit synthetic ID.');
assert.doesNotMatch(native, /\"id\":65537/, 'The helper must not claim Samsung storage ID 65537 without evidence.');
assert.match(native, /ensure_session_fallback_files/, 'The expensive Samsung file index must be session cached.');
assert.match(native, /session_list_progress_callback/, 'Long fallback listings must emit liveness progress.');

assert.equal(existsSync(resolve(root, 'index.js')), false, 'A stale extracted main-process artifact must not remain at repo root.');

console.log('Protected inventory and session hardening check passed.');
