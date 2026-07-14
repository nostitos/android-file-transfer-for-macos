import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'src/main/atomicDownload.ts');
const outDir = resolve(root, '.tmp');
const outPath = resolve(outDir, 'atomic-download-check.mjs');
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
await mkdir(outDir, { recursive: true });
await writeFile(outPath, compiled, 'utf8');
const { publishTemporaryFile } = await import(`${pathToFileURL(outPath).href}?t=${Date.now()}`);

const directory = await mkdtemp(join(tmpdir(), 'android-file-transfer-for-macos-atomic-check-'));
try {
  const firstPartial = join(directory, 'first.partial');
  const firstFinal = join(directory, 'first.txt');
  await writeFile(firstPartial, 'complete');
  const first = publishTemporaryFile({
    temporaryPath: firstPartial,
    destinationPath: firstFinal,
    expectedSize: 8
  });
  assert.equal(first.destinationPath, firstFinal);
  assert.equal(await readFile(firstFinal, 'utf8'), 'complete');
  assert.equal(existsSync(firstPartial), false);

  const collisionPartial = join(directory, 'collision.partial');
  const occupied = join(directory, 'occupied.txt');
  const renamed = join(directory, 'occupied 2.txt');
  await writeFile(collisionPartial, 'new bytes');
  await writeFile(occupied, 'old bytes');
  const collision = publishTemporaryFile({
    temporaryPath: collisionPartial,
    destinationPath: occupied,
    expectedSize: 9,
    onCollision: () => renamed
  });
  assert.equal(collision.destinationPath, renamed);
  assert.equal(await readFile(occupied, 'utf8'), 'old bytes');
  assert.equal(await readFile(renamed, 'utf8'), 'new bytes');

  const shortPartial = join(directory, 'short.partial');
  const shortFinal = join(directory, 'short.txt');
  await writeFile(shortPartial, 'short');
  assert.throws(
    () => publishTemporaryFile({ temporaryPath: shortPartial, destinationPath: shortFinal, expectedSize: 10 }),
    /10 bytes were expected/
  );
  assert.equal(existsSync(shortFinal), false);

  const symlinkPartial = join(directory, 'link.partial');
  await symlink(firstFinal, symlinkPartial);
  assert.throws(
    () => publishTemporaryFile({ temporaryPath: symlinkPartial, destinationPath: join(directory, 'link.txt'), expectedSize: 8 }),
    /not a regular file/
  );

  const cachedPartial = join(directory, 'cached.partial');
  const cachedFinal = join(directory, 'cached.txt');
  await writeFile(cachedPartial, 'same');
  await writeFile(cachedFinal, 'same');
  const cached = publishTemporaryFile({
    temporaryPath: cachedPartial,
    destinationPath: cachedFinal,
    expectedSize: 4,
    allowExistingEquivalent: true
  });
  assert.equal(cached.usedExisting, true);
  assert.equal(existsSync(cachedPartial), false);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('Atomic download behavior check passed.');
