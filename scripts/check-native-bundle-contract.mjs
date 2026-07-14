import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helperPath = resolve(root, 'resources/bin/mtp-json');
const filePromiseAddonPath = resolve(root, 'resources/bin/file-promise-drag.node');
const libmtpPath = resolve(root, 'resources/lib/libmtp.9.dylib');
const libusbPath = resolve(root, 'resources/lib/libusb-1.0.0.dylib');

function otool(path) {
  const result = spawnSync('otool', ['-L', path], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || `otool failed for ${path}`);
  return result.stdout;
}

function verifyCodeSignature(path) {
  const result = spawnSync('codesign', ['--verify', '--verbose=2', path], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `codesign failed for ${path}`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const extraResources = packageJson.build?.extraResources ?? [];
const nativeHelperSource = readFileSync(resolve(root, 'src/native/mtp-json.c'), 'utf8');
const buildScript = readFileSync(resolve(root, 'scripts/build-native.mjs'), 'utf8');

assert.ok(existsSync(helperPath), 'Native helper must exist.');
assert.ok(existsSync(filePromiseAddonPath), 'Native AppKit file-promise addon must exist.');
assert.ok(existsSync(libmtpPath), 'Bundled libmtp dylib must exist.');
assert.ok(existsSync(libusbPath), 'Bundled libusb dylib must exist.');
assert.ok(
  extraResources.some((entry) => entry.from === 'resources/lib' && entry.to === 'lib'),
  'macOS package must include bundled native libraries.'
);
assert.ok(
  extraResources.some((entry) => entry.from === 'resources/bin' && entry.to === 'bin'),
  'macOS package must include the native helper and file-promise addon.'
);

const helperLinks = otool(helperPath);
const libmtpLinks = otool(libmtpPath);
const libusbLinks = otool(libusbPath);
const filePromiseLinks = otool(filePromiseAddonPath);
const combinedLinks = `${helperLinks}\n${libmtpLinks}\n${libusbLinks}`;

assert.doesNotMatch(
  combinedLinks,
  /\/opt\/homebrew/,
  'Packaged native helper must not depend on Homebrew runtime library paths.'
);
assert.match(
  helperLinks,
  /@loader_path\/\.\.\/lib\/libmtp\.9\.dylib/,
  'Native helper must load bundled libmtp relative to its bin directory.'
);
assert.match(filePromiseLinks, /AppKit\.framework/, 'File-promise addon must link AppKit.');
assert.match(buildScript, /file-promise-drag\.node/, 'Native build must package the file-promise addon.');
assert.match(
  helperLinks,
  /@loader_path\/\.\.\/lib\/libusb-1\.0\.0\.dylib/,
  'Native helper must load bundled libusb relative to its bin directory.'
);
assert.match(
  libmtpLinks,
  /@loader_path\/libusb-1\.0\.0\.dylib/,
  'Bundled libmtp must load bundled libusb from the same directory.'
);
assert.match(
  helperLinks,
  /CoreFoundation\.framework/,
  'Native helper must link CoreFoundation for the macOS IOKit fallback.'
);

assert.match(
  nativeHelperSource,
  /IOServiceMatching\("IOUSBHostDevice"\)/,
  'Native helper status must use IOKit to see Android USB devices that libmtp/libusb miss.'
);
assert.match(
  nativeHelperSource,
  /emit_iokit_android_usb_fallback_status\(\)[\s\S]*emit_libusb_android_usb_fallback_status\(\)/,
  'Native helper status must try IOKit before falling back to libusb-only USB detection.'
);
assert.match(
  buildScript,
  /'-framework',\s*'CoreFoundation'/,
  'Native build must explicitly link CoreFoundation for IOKit property reads.'
);

verifyCodeSignature(helperPath);
verifyCodeSignature(filePromiseAddonPath);
verifyCodeSignature(libmtpPath);
verifyCodeSignature(libusbPath);

console.log('Native bundle contract check passed.');
