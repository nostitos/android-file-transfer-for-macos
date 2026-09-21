import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'src/main/macMtpCamera.ts');
const outDir = resolve(root, '.tmp');
const outPath = resolve(outDir, 'mac-mtp-camera-check.mjs');

const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

await mkdir(outDir, { recursive: true });
await writeFile(outPath, compiled, 'utf8');

const { findMacMtpCameraOwner } = await import(`${pathToFileURL(outPath).href}?t=${Date.now()}`);

const sample = `
+-o MTP@0  <class IOUSBHostInterface, id 0x101fcf17d>
  | {
  |   "idProduct" = 26720
  |   "bInterfaceClass" = 6
  |   "bInterfaceSubClass" = 1
  |   "UsbExclusiveOwner" = "pid 36792, ptpcamerad"
  |   "idVendor" = 1256
  |   "USB Serial Number" = "SYNTHETIC-MTP-0001"
  | }
  +-o ptpcamerad  <class AppleUSBHostInterfaceUserClient, id 0x101fcf18e>
      {
        "IOUserClientCreator" = "pid 36792, ptpcamerad"
      }

+-o Still Image Capture@0  <class IOUSBHostInterface, id 0x101fcf17f>
    {
      "idProduct" = 26720
      "bInterfaceClass" = 6
      "bInterfaceSubClass" = 1
      "UsbExclusiveOwner" = "pid 40000, another-process"
      "idVendor" = 1256
      "USB Serial Number" = "SYNTHETIC-MTP-0002"
    }
`;

assert.deepEqual(
  findMacMtpCameraOwner(sample, {
    vendorId: 1256,
    productId: 26720,
    serial: 'SYNTHETIC-MTP-0001'
  }),
  { pid: 36792, processName: 'ptpcamerad' }
);

assert.equal(
  findMacMtpCameraOwner(sample, {
    vendorId: 1256,
    productId: 26720,
    serial: 'SYNTHETIC-MTP-9999'
  }),
  null
);

assert.equal(
  findMacMtpCameraOwner(sample.replace('ptpcamerad"', 'Photos"'), {
    vendorId: 1256,
    productId: 26720,
    serial: 'SYNTHETIC-MTP-0001'
  }),
  null
);

console.log('Mac MTP camera owner parser check passed.');
