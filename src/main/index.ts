import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions
} from 'electron';
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidUsbFallbackKey, parseAndroidUsbDevicesFromIoreg } from './androidUsb';
import { publishTemporaryFile } from './atomicDownload';
import { removeVerifiedLocalMoveSource } from './localMoveSource';
import {
  deviceConnectionId as buildDeviceConnectionId,
  stableDeviceIdentity
} from '../shared/deviceIdentity';
import type {
  AdminRecoveryResult,
  AppMenuCommand,
  CommonMacFolder,
  CreateFolderRequest,
  CreateFolderResult,
  DiagnosticsCopyResult,
  DestinationResult,
  DeviceStatus,
  FolderListProgress,
  FolderListResult,
  InventoryResult,
  LocalDirectoryResult,
  LocalEntry,
  LocalModifiedTimeResult,
  LocalSourceIdentity,
  MtpDeviceInventory,
  MoveQueueResult,
  PhoneFilePromiseDragEvent,
  PhoneFilePromiseDragItem,
  PhoneFilePromiseDragRequest,
  RawDevice,
  TransferEvent,
  TransferJob,
  TransferOperation,
  TransferRequest,
  UploadRequest
} from '../shared/types';

const currentDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MAC_CAMERA_SERVICE_NAMES = ['icdd', 'ptpcamerad', 'mscamerad-xpc'];
const RAW_DEVICE_MISSING_SESSION_GRACE_MS = 12_000;
const ADMIN_SESSION_RECONNECT_TTL_MS = 10 * 60 * 1000;
const NORMAL_MTP_SESSION_OPEN_TIMEOUT_MS = 45_000;
const ADMIN_MTP_SESSION_OPEN_TIMEOUT_MS = 240_000;
const ADMIN_MTP_OPEN_ATTEMPT_TIMEOUT_SECONDS = 70;
const ADMIN_MTP_OPEN_MAX_ATTEMPTS = 3;
const TRANSFER_COMMAND_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMISED_PHONE_FILES = 20_000;
const MAX_PROMISED_PHONE_FOLDERS = 5_000;
let mainWindow: BrowserWindow | null = null;
const transferJobs = new Map<string, TransferJob>();
let activeJobId: string | null = null;
let activeWasCanceled = false;
let activeTransferUsesAdminSession = false;
let pendingPromisePlanningCount = 0;

interface NativePromiseDragEvent {
  type: 'write' | 'drag-ended' | 'internal-hover';
  promiseId?: string;
  path?: string;
  active?: boolean;
  operation?: number;
}

interface FilePromiseDragAddon {
  startDrag: (
    options: {
      viewHandle: Buffer;
      items: Array<{ promiseId: string; name: string; kind: 'file' | 'folder' }>;
      internalDestination?: PhoneFilePromiseDragRequest['internalDestination'];
    },
    callback: (event: NativePromiseDragEvent) => void
  ) => boolean;
  completePromise: (promiseId: string, error?: string) => boolean;
  failAll: (error?: string) => void;
}

interface PromisedDirectory {
  path: string;
  modified: number;
}

interface PromisedDownloadFile {
  request: TransferRequest;
  destinationPath: string;
}

interface PromiseSourceRecord {
  id: string;
  item: PhoneFilePromiseDragItem;
}

interface PromiseFulfillment {
  id: string;
  rootPath: string;
  rootKind: 'file' | 'folder';
  directories: PromisedDirectory[];
  remainingJobIds: Set<string>;
  settled: boolean;
}

let filePromiseDragAddon: FilePromiseDragAddon | null | undefined;
const promiseSources = new Map<string, PromiseSourceRecord>();
const promiseFulfillments = new Map<string, PromiseFulfillment>();

interface SessionPayload {
  type?: string;
  requestId?: string;
  ok?: boolean;
  state?: string;
  message?: string;
  event?: 'started' | 'progress' | 'complete' | 'failed';
  sent?: number;
  total?: number;
  objectId?: number;
  verified?: boolean;
  destination?: string;
  bus?: number;
  device?: number;
  vendorId?: number;
  productId?: number;
  serial?: string;
  usbSessionId?: string;
  [key: string]: unknown;
}

interface SessionCommand {
  id: string;
  name: string;
  line: string;
  timeoutMs: number;
  resolve: (payload: SessionPayload) => void;
  reject: (error: Error) => void;
  onEvent?: (payload: SessionPayload) => void;
  timer?: ReturnType<typeof setTimeout>;
}

let sessionProcess: ChildProcessWithoutNullStreams | null = null;
let sessionDeviceIndex: number | null = null;
let sessionRawKey: string | null = null;
let pendingSessionRawKey: string | null = null;
let sessionConnectionId: string | null = null;
let pendingSessionConnectionId: string | null = null;
let lastRawDevices: RawDevice[] = [];
let sessionReady: Promise<void> | null = null;
let sessionReadyResolve: (() => void) | null = null;
let sessionReadyReject: ((error: Error) => void) | null = null;
let sessionReadyTimer: ReturnType<typeof setTimeout> | null = null;
let sessionStdoutBuffer = '';
let sessionStderrBuffer = '';
let lastSessionStderr = '';
let activeSessionCommand: SessionCommand | null = null;
const sessionQueue: SessionCommand[] = [];
let lastAndroidUsbFallbackKey: string | null = null;
let rawDevicesMissingSince: number | null = null;

interface AdminSessionState {
  deviceIndex: number;
  connectionId: string;
  rawKey: string;
  deviceIdentityKey: string;
  usbSessionId: string | null;
  stageRoot: string;
  stagedHelper: string;
  runnerPath: string;
  inputPath: string;
  outputPath: string;
  pidPath: string;
  stopPath: string;
  expirePath: string;
  processPid: number | null;
  input: WriteStream | null;
  outputOffset: number;
  outputBuffer: string;
  stderrBuffer: string;
  isReady: boolean;
  ready: Promise<void>;
  readyResolve: (() => void) | null;
  readyReject: ((error: Error) => void) | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  activeCommand: SessionCommand | null;
  queue: SessionCommand[];
}

interface AdminSessionManifest {
  version: 3;
  deviceIndex: number;
  connectionId: string;
  rawKey: string;
  deviceIdentityKey?: string;
  usbSessionId?: string | null;
  stageRoot: string;
  stagedHelper: string;
  runnerPath: string;
  inputPath: string;
  outputPath: string;
  pidPath: string;
  stopPath: string;
  expirePath: string;
  processPid: number | null;
  createdAt: number;
  expiresAt: number;
}

let adminSession: AdminSessionState | null = null;

function getLogPath(): string {
  const logsDir = join(app.getPath('userData'), 'logs');
  mkdirSync(logsDir, { recursive: true });
  return join(logsDir, 'mtp.log');
}

function appendLog(message: string): void {
  const timestamp = new Date().toISOString();
  appendFileSync(getLogPath(), `[${timestamp}] ${message}\n`, 'utf8');
}

function removeLegacyPrecopyDirectory(): void {
  const legacyDirectory = join(app.getPath('userData'), ['drag', 'cache'].join('-'));
  if (!existsSync(legacyDirectory)) {
    return;
  }

  try {
    rmSync(legacyDirectory, { recursive: true, force: true });
    appendLog('removed obsolete phone drag pre-copy data');
  } catch (error) {
    appendLog(`warning: unable to remove obsolete phone drag pre-copy data: ${String(error)}`);
  }
}

function getBridgePath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'mtp-json');
  }

  return resolve(process.cwd(), 'resources/bin/mtp-json');
}

function getFilePromiseDragAddonPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'file-promise-drag.node');
  }
  return resolve(process.cwd(), 'resources/bin/file-promise-drag.node');
}

function loadFilePromiseDragAddon(): FilePromiseDragAddon | null {
  if (filePromiseDragAddon !== undefined) {
    return filePromiseDragAddon;
  }
  try {
    filePromiseDragAddon = require(getFilePromiseDragAddonPath()) as FilePromiseDragAddon;
    appendLog('native file-promise drag bridge loaded');
  } catch (error) {
    filePromiseDragAddon = null;
    appendLog(`native file-promise drag bridge unavailable: ${String(error)}`);
  }
  return filePromiseDragAddon;
}

function sendPhoneFilePromiseDragEvent(event: PhoneFilePromiseDragEvent): void {
  mainWindow?.webContents.send('phone-file-promise:event', event);
}

function getPreloadPath(): string {
  const candidates = [
    join(currentDir, '../preload/index.mjs'),
    join(currentDir, '../preload/index.js')
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    appendLog(`preload script missing; tried ${candidates.join(', ')}`);
  }
  return found ?? candidates[0];
}

async function ensureBridge(): Promise<string> {
  const bridgePath = getBridgePath();
  await access(bridgePath, constants.X_OK);
  return bridgePath;
}

function missingBridgeStatus(error: unknown): DeviceStatus {
  const helperPath = getBridgePath();
  const message =
    error instanceof Error ? error.message : 'Native MTP helper could not be executed.';

  appendLog(`bridge missing: ${message}`);

  return {
    ok: false,
    state: 'bridge-missing',
    message: `Native MTP helper is missing or not executable at ${helperPath}. Run npm run native:build.`,
    deviceCount: 0,
    rawDevices: [],
    helperPath,
    logPath: getLogPath(),
    stderr: message
  };
}

function parseJson<T>(stdout: string, fallback: T): T {
  const payload = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'));

  if (!payload) {
    return fallback;
  }

  return JSON.parse(payload) as T;
}

function runningMacCameraServices(): string[] {
  if (process.platform !== 'darwin') {
    return [];
  }

  try {
    const output = execFileSync('/bin/ps', ['-axo', 'comm='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 1024 * 1024
    });
    const processNames = new Set(
      output
        .split('\n')
        .map((line) => basename(line.trim()))
        .filter(Boolean)
    );
    return MAC_CAMERA_SERVICE_NAMES.filter((serviceName) => processNames.has(serviceName));
  } catch (error) {
    appendLog(`macOS camera service check failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function macCameraServiceHint(): string | null {
  const services = runningMacCameraServices();
  if (!services.length) {
    return null;
  }

  return `macOS camera/import services are running: ${services.join(', ')}. Close Photos or Image Capture if either app is trying to use the phone.`;
}

function bridgeFailureHint(stderr: string, timedOut: boolean): string | null {
  const normalized = stderr.toLowerCase();
  const sessionOpenFailed =
    normalized.includes('ptp_error_io') ||
    normalized.includes('failed to open session') ||
    normalized.includes('libusb_claim_interface') ||
    normalized.includes('libusb_detach_kernel_driver') ||
    normalized.includes('usb device capture');

  if (sessionOpenFailed) {
    const serviceHint = macCameraServiceHint();
    return [
      'The phone was detected, but it did not open its files to this Mac.',
      'If the app shows Open files, use it to start one protected phone-file session.',
      serviceHint,
      'Keep the phone unlocked, tap any data-access prompt, switch USB mode away from File Transfer and back, and close other transfer or photo apps.',
      'On macOS, Image Capture or another USB service may be holding the phone until the USB connection is reset.'
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (timedOut) {
    return 'Keep the phone unlocked and confirm it is still in File Transfer / Android Auto mode before retrying.';
  }

  return null;
}

function helperMetadata<T extends object>(payload: T, stderr?: string): T & {
  helperPath: string;
  logPath: string;
  stderr?: string;
} {
  const stderrText = stderr?.trim() || undefined;
  return {
    ...payload,
    helperPath: getBridgePath(),
    logPath: getLogPath(),
    stderr: stderrText
  };
}

function rawDeviceKey(device: Pick<RawDevice, 'bus' | 'device' | 'vendorId' | 'productId'>): string {
  return `${device.bus}:${device.device}:${device.vendorId}:${device.productId}`;
}

function rawDeviceIdentityKey(device: RawDevice): string {
  return `${stableDeviceIdentity(device)}:${device.connectionMode ?? 'unknown'}`;
}

function rawDeviceConnectionId(device: RawDevice): string {
  return device.connectionId || buildDeviceConnectionId(device);
}

function readyPayloadMatchesConnection(
  payload: SessionPayload,
  expectedConnectionId: string | null,
  expectedRawKey: string | null
): boolean {
  if (
    !expectedConnectionId ||
    typeof payload.bus !== 'number' ||
    typeof payload.device !== 'number' ||
    typeof payload.vendorId !== 'number' ||
    typeof payload.productId !== 'number'
  ) {
    return false;
  }

  const expectedUsbMarker = '@usb:';
  const usbMarkerIndex = expectedConnectionId.indexOf(expectedUsbMarker);
  if (usbMarkerIndex >= 0) {
    const expectedUsbSessionId = expectedConnectionId.slice(
      usbMarkerIndex + expectedUsbMarker.length
    );
    return (
      payload.usbSessionId === expectedUsbSessionId &&
      expectedConnectionId.startsWith(`${payload.vendorId}:${payload.productId}:`)
    );
  }

  return (
    rawDeviceKey({
      bus: payload.bus,
      device: payload.device,
      vendorId: payload.vendorId,
      productId: payload.productId
    }) === expectedRawKey
  );
}

function withRawDeviceConnectionIds(rawDevices: RawDevice[]): RawDevice[] {
  return rawDevices.map((device) => ({
    ...device,
    connectionId: rawDeviceConnectionId(device)
  }));
}

function rawDeviceForConnection(deviceIndex: number, connectionId?: string): RawDevice | null {
  if (connectionId) {
    return (
      lastRawDevices.find((device) => rawDeviceConnectionId(device) === connectionId) ?? null
    );
  }
  return lastRawDevices.find((device) => device.index === deviceIndex) ?? null;
}

function rawDeviceUsbSessionId(device: Pick<RawDevice, 'usbSessionId'> | null | undefined): string | null {
  return typeof device?.usbSessionId === 'string' && device.usbSessionId.length > 0
    ? device.usbSessionId
    : null;
}

function usbSessionChanged(previousSessionId: string | null | undefined, rawDevice: RawDevice): boolean {
  const nextSessionId = rawDeviceUsbSessionId(rawDevice);
  return !!previousSessionId && !!nextSessionId && previousSessionId !== nextSessionId;
}

function findVisibleDeviceForAdminSession(session: AdminSessionState, rawDevices: RawDevice[]): RawDevice | null {
  return rawDevices.find((device) => rawDeviceConnectionId(device) === session.connectionId) ?? null;
}

function detectAndroidUsbDevices(): Promise<RawDevice[]> {
  return new Promise((resolvePromise) => {
    execFile(
      'ioreg',
      ['-p', 'IOUSB', '-l', '-w0'],
      { maxBuffer: 1024 * 1024 * 10, timeout: 2500 },
      (error, stdout) => {
        if (error) {
          appendLog(`ioreg USB fallback failed: ${error.message}`);
          resolvePromise([]);
          return;
        }
        resolvePromise(parseAndroidUsbDevicesFromIoreg(stdout));
      }
    );
  });
}

async function androidUsbFallbackStatus(baseStatus: DeviceStatus): Promise<DeviceStatus | null> {
  const usbDevices = await detectAndroidUsbDevices();
  if (!usbDevices.length) {
    lastAndroidUsbFallbackKey = null;
    return null;
  }

  const fallbackKey = androidUsbFallbackKey(usbDevices);
  if (fallbackKey !== lastAndroidUsbFallbackKey) {
    const mode = usbDevices.some((device) => device.connectionMode === 'mtp')
      ? 'with MTP USB mode visible'
      : 'without MTP file-transfer mode';
    appendLog(`Android USB device present ${mode}: ${fallbackKey}`);
    lastAndroidUsbFallbackKey = fallbackKey;
  }
  const hasMtpUsbDevice = usbDevices.some((device) => device.connectionMode === 'mtp');

  return {
    ...baseStatus,
    ok: false,
    state: 'connect-error',
    message: hasMtpUsbDevice
      ? 'Phone is visible in File Transfer mode, but its folders are not open yet. Use Open files to start one protected phone-file session.'
      : 'Phone is connected by USB, but File transfer is not active. Unlock the phone, open the USB notification, and choose File transfer or Transferring files.',
    deviceCount: usbDevices.length,
    rawDevices: usbDevices
  };
}

async function enrichRawDevicesWithAndroidUsbMetadata(rawDevices: RawDevice[]): Promise<RawDevice[]> {
  if (!rawDevices.length) {
    return rawDevices;
  }

  const usbDevices = await detectAndroidUsbDevices();
  if (!usbDevices.length) {
    return rawDevices;
  }

  return rawDevices.map((rawDevice) => {
    const candidates = usbDevices.filter(
      (usbDevice) =>
        usbDevice.vendorId === rawDevice.vendorId &&
        usbDevice.productId === rawDevice.productId
    );
    const metadata =
      candidates.find(
        (usbDevice) => usbDevice.bus === rawDevice.bus && usbDevice.device === rawDevice.device
      ) ??
      candidates.find(
        (usbDevice) => !!rawDevice.serial && usbDevice.serial === rawDevice.serial
      ) ??
      (candidates.length === 1 ? candidates[0] : null);

    if (!metadata) {
      return rawDevice;
    }

    return {
      ...rawDevice,
      serial: rawDevice.serial ?? metadata.serial,
      usbSessionId: rawDevice.usbSessionId ?? metadata.usbSessionId,
      usbCurrentConfiguration: rawDevice.usbCurrentConfiguration ?? metadata.usbCurrentConfiguration,
      usbPreferredConfiguration: rawDevice.usbPreferredConfiguration ?? metadata.usbPreferredConfiguration,
      needsDeviceAccessEntitlement:
        rawDevice.needsDeviceAccessEntitlement ?? metadata.needsDeviceAccessEntitlement
    };
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readPidFile(pidPath: string): number | null {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError.code === 'EPERM';
  }
}

function getAdminSessionManifestPath(): string {
  const sessionDir = join(app.getPath('userData'), 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  return join(sessionDir, 'protected-mtp-session.json');
}

function parseAdminSessionManifest(value: unknown): AdminSessionManifest | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const manifest = value as Record<string, unknown>;
  const stringKeys = [
    'rawKey',
    'stageRoot',
    'stagedHelper',
    'runnerPath',
    'inputPath',
    'outputPath',
    'pidPath',
    'stopPath',
    'expirePath'
  ];
  if (
    manifest.version !== 3 ||
    typeof manifest.deviceIndex !== 'number' ||
    !Number.isInteger(manifest.deviceIndex) ||
    manifest.deviceIndex < 0 ||
    typeof manifest.connectionId !== 'string' ||
    manifest.connectionId.length === 0 ||
    (typeof manifest.deviceIdentityKey !== 'string' && typeof manifest.deviceIdentityKey !== 'undefined') ||
    (typeof manifest.usbSessionId !== 'string' &&
      manifest.usbSessionId !== null &&
      typeof manifest.usbSessionId !== 'undefined') ||
    typeof manifest.createdAt !== 'number' ||
    typeof manifest.expiresAt !== 'number' ||
    (typeof manifest.processPid !== 'number' && manifest.processPid !== null)
  ) {
    return null;
  }

  for (const key of stringKeys) {
    if (typeof manifest[key] !== 'string' || !(manifest[key] as string).length) {
      return null;
    }
  }

  const stageRoot = resolve(manifest.stageRoot as string);
  const protectedRootPrefix = '/private/var/tmp/androidFileTransferForMacOS-protected-';
  if (!stageRoot.startsWith(protectedRootPrefix) || stageRoot !== (manifest.stageRoot as string)) {
    return null;
  }
  for (const key of stringKeys.filter((key) => key !== 'stageRoot')) {
    const filePath = resolve(manifest[key] as string);
    if (!filePath.startsWith(`${stageRoot}/`)) {
      return null;
    }
  }

  return manifest as unknown as AdminSessionManifest;
}

function readAdminSessionManifest(): AdminSessionManifest | null {
  try {
    return parseAdminSessionManifest(JSON.parse(readFileSync(getAdminSessionManifestPath(), 'utf8')));
  } catch {
    return null;
  }
}

function removeAdminSessionManifest(): void {
  try {
    rmSync(getAdminSessionManifestPath(), { force: true });
  } catch {
    // The app may be quitting before Electron has a usable userData path.
  }
}

function writeAdminSessionManifest(session: AdminSessionState, expiresAt: number): void {
  const manifest: AdminSessionManifest = {
    version: 3,
    deviceIndex: session.deviceIndex,
    connectionId: session.connectionId,
    rawKey: session.rawKey,
    deviceIdentityKey: session.deviceIdentityKey,
    usbSessionId: session.usbSessionId,
    stageRoot: session.stageRoot,
    stagedHelper: session.stagedHelper,
    runnerPath: session.runnerPath,
    inputPath: session.inputPath,
    outputPath: session.outputPath,
    pidPath: session.pidPath,
    stopPath: session.stopPath,
    expirePath: session.expirePath,
    processPid: session.processPid ?? readPidFile(session.pidPath),
    createdAt: Date.now(),
    expiresAt
  };

  const manifestPath = getAdminSessionManifestPath();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  chmodSync(manifestPath, 0o600);
}

function stopDetachedAdminSession(manifest: AdminSessionManifest, reason: string): void {
  try {
    writeFileSync(manifest.stopPath, `${new Date().toISOString()} ${reason}\n`, 'utf8');
    appendLog(`requested detached admin mtp runner stop through stop file: ${reason}`);
  } catch (error) {
    appendLog(`unable to write detached admin mtp stop file: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pid = manifest.processPid ?? readPidFile(manifest.pidPath);
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    appendLog(`sent SIGTERM to detached admin mtp runner ${pid}: ${reason}`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EPERM') {
      appendLog(`unable to signal detached admin mtp runner ${pid}: ${nodeError.message || String(error)}`);
    }
  }
}

async function attachDetachedAdminMtpSession(deviceIndex: number, rawDevice: RawDevice): Promise<boolean> {
  if (adminSession) {
    return true;
  }

  const manifest = readAdminSessionManifest();
  if (!manifest) {
    return false;
  }

  const rawKey = rawDeviceKey(rawDevice);
  const connectionId = rawDeviceConnectionId(rawDevice);
  const identityKey = rawDeviceIdentityKey(rawDevice);
  if (manifest.connectionId !== connectionId || usbSessionChanged(manifest.usbSessionId, rawDevice)) {
    appendLog(
      `discarding detached protected MTP session because phone attachment changed: ${manifest.connectionId} -> ${connectionId}`
    );
    stopDetachedAdminSession(manifest, 'Phone was unplugged and reconnected.');
    removeAdminSessionManifest();
    return false;
  }

  if (manifest.rawKey !== rawKey || manifest.deviceIndex !== deviceIndex) {
    appendLog(
      `reattaching protected MTP session for the same phone attachment across index/address change: ${manifest.deviceIndex}/${manifest.rawKey} -> ${deviceIndex}/${rawKey}`
    );
  }

  if (Date.now() >= manifest.expiresAt) {
    appendLog('discarding expired detached admin mtp session');
    stopDetachedAdminSession(manifest, 'Detached protected session expired.');
    removeAdminSessionManifest();
    return false;
  }

  const processPid = manifest.processPid ?? readPidFile(manifest.pidPath);
  if (
    !existsSync(manifest.stageRoot) ||
    !existsSync(manifest.inputPath) ||
    !existsSync(manifest.outputPath) ||
    !isProcessAlive(processPid)
  ) {
    appendLog('discarding detached admin mtp session because its runner is no longer available');
    removeAdminSessionManifest();
    return false;
  }

  let outputOffset = 0;
  try {
    outputOffset = statSync(manifest.outputPath).size;
  } catch {
    outputOffset = 0;
  }

  const session: AdminSessionState = {
    deviceIndex,
    connectionId,
    rawKey,
    deviceIdentityKey: identityKey,
    usbSessionId: manifest.usbSessionId ?? rawDeviceUsbSessionId(rawDevice),
    stageRoot: manifest.stageRoot,
    stagedHelper: manifest.stagedHelper,
    runnerPath: manifest.runnerPath,
    inputPath: manifest.inputPath,
    outputPath: manifest.outputPath,
    pidPath: manifest.pidPath,
    stopPath: manifest.stopPath,
    expirePath: manifest.expirePath,
    processPid,
    input: null,
    outputOffset,
    outputBuffer: '',
    stderrBuffer: '',
    isReady: true,
    ready: Promise.resolve(),
    readyResolve: null,
    readyReject: null,
    readyTimer: null,
    pollTimer: null,
    activeCommand: null,
    queue: []
  };

  try {
    writeFileSync(session.expirePath, '', 'utf8');
  } catch {
    // The runner only uses this file as an idle-session deadline.
  }

  adminSession = session;
  session.pollTimer = setInterval(() => pollAdminSessionOutput(session), 100);
  session.input = createWriteStream(session.inputPath, { flags: 'w' });
  session.input.on('error', (error) => {
    if (adminSession === session) {
      destroyAdminMtpSession(`Admin MTP input error after reconnect: ${error.message}`, true);
    }
  });
  appendLog(`reattached protected MTP session without a new Mac password prompt for raw device ${rawKey}`);
  return true;
}

async function reattachProtectedSessionFromRawDevices(rawDevices: RawDevice[]): Promise<boolean> {
  if (adminSession) {
    return true;
  }

  const rawMtpDevice = rawDevices.find((device) => device.connectionMode === 'mtp');
  if (!rawMtpDevice) {
    return false;
  }

  try {
    return await attachDetachedAdminMtpSession(rawMtpDevice.index, rawMtpDevice);
  } catch (error) {
    appendLog(
      `status protected MTP reattach failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

function stopAdminSessionProcess(session: AdminSessionState, reason: string): void {
  try {
    writeFileSync(session.stopPath, `${new Date().toISOString()} ${reason}\n`, 'utf8');
    appendLog(`requested admin mtp runner stop through stop file: ${reason}`);
  } catch (error) {
    appendLog(`unable to write admin mtp stop file: ${error instanceof Error ? error.message : String(error)}`);
  }

  const pid = session.processPid ?? readPidFile(session.pidPath);
  if (!pid) {
    appendLog(`admin mtp session has no runner pid to stop: ${reason}`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    appendLog(`sent SIGTERM to admin mtp runner ${pid}: ${reason}`);
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
        appendLog(`sent SIGKILL to admin mtp runner ${pid}: ${reason}`);
      } catch {
        // The runner already exited.
      }
    }, 1200);
    return;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EPERM') {
      appendLog(`unable to signal admin mtp runner ${pid}: ${nodeError.message || String(error)}`);
      return;
    }
  }

  appendLog(`admin mtp runner ${pid} is root-owned; waiting for stop file handling: ${reason}`);
}

async function refreshRawDevices(): Promise<RawDevice[]> {
  let status = await runBridgeJson<DeviceStatus>(
    'status',
    [],
    {
      ok: false,
      state: 'error',
      message: 'Unable to check MTP device status.',
      deviceCount: 0,
      rawDevices: [],
      helperPath: getBridgePath(),
      logPath: getLogPath()
    },
    10_000
  );

  if (status.state === 'no-device' && status.rawDevices.length === 0) {
    status = (await androidUsbFallbackStatus(status)) ?? status;
  }

  if (status.rawDevices.length > 0) {
    status = {
      ...status,
      rawDevices: withRawDeviceConnectionIds(
        await enrichRawDevicesWithAndroidUsbMetadata(status.rawDevices)
      )
    };
  }

  lastRawDevices = status.rawDevices;
  return lastRawDevices;
}

function getRawKeyForDeviceIndex(deviceIndex: number): string | null {
  const rawDevice = lastRawDevices.find((device) => device.index === deviceIndex);
  return rawDevice ? rawDeviceKey(rawDevice) : null;
}

function blockedMtpAccessMessage(): string {
  const serviceHint = macCameraServiceHint();
  return [
    'Phone is visible in File Transfer mode, but its folders are not open yet.',
    'Use Open files to start one protected phone-file session.',
    serviceHint
  ]
    .filter(Boolean)
    .join(' ');
}

function sessionErrorMessage(base: string, error: unknown, stderr: string): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (normalMtpAccessBlocked(error, stderr)) {
    return blockedMtpAccessMessage();
  }

  const hint = bridgeFailureHint(stderr, rawMessage.toLowerCase().includes('timed out'));
  return `${base} ${rawMessage}${hint ? ` ${hint}` : ''}`;
}

function normalMtpAccessBlocked(error: unknown, stderr: string): boolean {
  if (!lastRawDevices.some((device) => device.connectionMode === 'mtp')) {
    return false;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const combined = `${rawMessage}\n${stderr}`.toLowerCase();
  return (
    combined.includes('usb connection is stuck') ||
    combined.includes('libusb_claim_interface') ||
    combined.includes('libusb_error_access') ||
    combined.includes('access denied') ||
    combined.includes('ptp_error_io') ||
    combined.includes('failed to open session') ||
    combined.includes('unable to initialize device')
  );
}

async function normalMtpAccessBlockedAfterRefresh(error: unknown, stderr: string): Promise<boolean> {
  if (normalMtpAccessBlocked(error, stderr)) {
    return true;
  }

  await refreshRawDevices();
  return normalMtpAccessBlocked(error, stderr);
}

function cancelFolderListing(): boolean {
  let stopped = false;
  const cancelError = new Error('Folder listing stopped by user.');
  const canCancelCommand = (command: SessionCommand | null): boolean =>
    command?.name === 'list' || command?.name === 'inventory';
  const rejectQueuedCommands = (queue: SessionCommand[]): number => {
    let rejected = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (!canCancelCommand(queue[index])) {
        continue;
      }
      const [command] = queue.splice(index, 1);
      if (command.timer) {
        clearTimeout(command.timer);
      }
      command.reject(cancelError);
      rejected += 1;
    }
    return rejected;
  };

  const queuedNormal = rejectQueuedCommands(sessionQueue);
  if (queuedNormal > 0) {
    appendLog(`user stopped ${queuedNormal} queued MTP folder listing command(s)`);
    stopped = true;
  }

  if (adminSession) {
    const queuedProtected = rejectQueuedCommands(adminSession.queue);
    if (queuedProtected > 0) {
      appendLog(`user stopped ${queuedProtected} queued protected MTP folder listing command(s)`);
      stopped = true;
    }
  }

  if (canCancelCommand(activeSessionCommand)) {
    appendLog(`user stopped active MTP ${activeSessionCommand?.name} command`);
    destroyMtpSession(cancelError.message, true);
    stopped = true;
  }

  if (adminSession && canCancelCommand(adminSession.activeCommand)) {
    appendLog(`user stopped active protected MTP ${adminSession.activeCommand?.name} command`);
    destroyAdminMtpSession(cancelError.message, true);
    stopped = true;
  }

  return stopped;
}

function rejectSessionCommands(error: Error): void {
  if (activeSessionCommand) {
    if (activeSessionCommand.timer) {
      clearTimeout(activeSessionCommand.timer);
    }
    activeSessionCommand.reject(error);
    activeSessionCommand = null;
  }

  while (sessionQueue.length > 0) {
    const command = sessionQueue.shift();
    command?.reject(error);
  }
}

function clearSessionReady(error?: Error): void {
  if (sessionReadyTimer) {
    clearTimeout(sessionReadyTimer);
    sessionReadyTimer = null;
  }

  if (error && sessionReadyReject) {
    sessionReadyReject(error);
  }

  sessionReady = null;
  sessionReadyResolve = null;
  sessionReadyReject = null;
}

function clearCommandTimer(command: SessionCommand): void {
  if (command.timer) {
    clearTimeout(command.timer);
    command.timer = undefined;
  }
}

function armCommandTimer(command: SessionCommand, onTimeout: () => void): void {
  clearCommandTimer(command);
  command.timer = setTimeout(onTimeout, command.timeoutMs);
}

function waitForChildProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off('close', finish);
      child.off('error', finish);
      resolvePromise();
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      setTimeout(finish, 250);
    }, timeoutMs);
    child.once('close', finish);
    child.once('error', finish);
  });
}

function destroyMtpSession(reason: string, forceProcessStop = false): void {
  appendLog(`mtp session closing: ${reason}`);
  const processToClose = sessionProcess;
  const error = new Error(reason);

  lastSessionStderr = sessionStderrBuffer.trim() || lastSessionStderr;
  clearSessionReady(error);
  rejectSessionCommands(error);

  sessionProcess = null;
  sessionDeviceIndex = null;
  sessionRawKey = null;
  pendingSessionRawKey = null;
  sessionConnectionId = null;
  pendingSessionConnectionId = null;
  if (!adminSession) {
    rawDevicesMissingSince = null;
  }
  sessionStdoutBuffer = '';
  sessionStderrBuffer = '';

  if (processToClose && processToClose.exitCode === null && processToClose.signalCode === null) {
    try {
      if (!processToClose.stdin.destroyed && processToClose.stdin.writable) {
        processToClose.stdin.end('quit\n');
        appendLog(`sent graceful quit to MTP session: ${reason}`);
      }
    } catch (closeError) {
      appendLog(`unable to send graceful quit to MTP session: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }

    if (forceProcessStop) {
      setTimeout(() => {
        if (processToClose.exitCode === null && processToClose.signalCode === null) {
          processToClose.kill('SIGTERM');
          appendLog(`sent SIGTERM to MTP session: ${reason}`);
        }
        setTimeout(() => {
          if (processToClose.exitCode === null && processToClose.signalCode === null) {
            processToClose.kill('SIGKILL');
            appendLog(`sent SIGKILL to MTP session: ${reason}`);
          }
        }, 1500);
      }, 1500);
    }
  }
}

function finishActiveSessionCommand(payload: SessionPayload): void {
  const command = activeSessionCommand;
  if (!command) {
    appendLog(`session response without active command: ${JSON.stringify(payload)}`);
    return;
  }

  if (payload.requestId !== command.id) {
    appendLog(`session response id mismatch: ${JSON.stringify(payload)}`);
    return;
  }

  clearCommandTimer(command);
  activeSessionCommand = null;
  command.resolve(payload);
  pumpSessionQueue();
  processTransferQueue();
}

function handleSessionPayload(payload: SessionPayload): void {
  if (payload.type === 'ready') {
    if (payload.ok) {
      if (!readyPayloadMatchesConnection(payload, pendingSessionConnectionId, pendingSessionRawKey)) {
        destroyMtpSession('The MTP helper opened a different phone connection than the one requested.', true);
        return;
      }
      if (
        typeof payload.bus === 'number' &&
        typeof payload.device === 'number' &&
        typeof payload.vendorId === 'number' &&
        typeof payload.productId === 'number'
      ) {
        sessionRawKey = rawDeviceKey({
          bus: payload.bus,
          device: payload.device,
          vendorId: payload.vendorId,
          productId: payload.productId
        });
        sessionConnectionId = pendingSessionConnectionId;
        pendingSessionRawKey = null;
        pendingSessionConnectionId = null;
      }
      if (sessionReadyTimer) {
        clearTimeout(sessionReadyTimer);
        sessionReadyTimer = null;
      }
      sessionReadyResolve?.();
      sessionReadyResolve = null;
      sessionReadyReject = null;
      appendLog(payload.message || 'mtp session opened');
    } else {
      const message = payload.message || 'Unable to open the MTP session.';
      destroyMtpSession(message);
    }
    return;
  }

  if (
    (payload.type === 'download' || payload.type === 'upload' || payload.type === 'list') &&
    activeSessionCommand
  ) {
    const command = activeSessionCommand;
    if (payload.requestId === command.id) {
      command.onEvent?.(payload);
      if (payload.event === 'progress') {
        armCommandTimer(command, () => {
          destroyMtpSession(`MTP session command timed out after ${command.timeoutMs}ms.`, true);
        });
      }
      return;
    }
  }

  if (payload.type === 'response') {
    finishActiveSessionCommand(payload);
    return;
  }

  if (payload.type !== 'bye') {
    appendLog(`session payload ignored: ${JSON.stringify(payload)}`);
  }
}

function handleSessionStdout(chunk: Buffer): void {
  sessionStdoutBuffer += chunk.toString('utf8');
  const lines = sessionStdoutBuffer.split('\n');
  sessionStdoutBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!trimmed.startsWith('{')) {
      appendLog(`session stdout: ${trimmed}`);
      continue;
    }

    try {
      handleSessionPayload(JSON.parse(trimmed) as SessionPayload);
    } catch (error) {
      appendLog(`session JSON parse failed: ${String(error)} line=${trimmed}`);
    }
  }
}

function pumpSessionQueue(): void {
  if (activeSessionCommand || !sessionProcess || sessionProcess.stdin.destroyed) {
    return;
  }

  const command = sessionQueue.shift();
  if (!command) {
    return;
  }

  activeSessionCommand = command;
  armCommandTimer(command, () => {
    destroyMtpSession(`MTP session command timed out after ${command.timeoutMs}ms.`, true);
  });
  sessionProcess.stdin.write(command.line);
}

async function ensureMtpSession(deviceIndex: number, expectedConnectionId?: string): Promise<void> {
  const helperPath = await ensureBridge();

  if (lastRawDevices.length === 0) {
    await refreshRawDevices();
  }
  let rawDevice = rawDeviceForConnection(deviceIndex, expectedConnectionId);
  if (!rawDevice) {
    await refreshRawDevices();
    rawDevice = rawDeviceForConnection(deviceIndex, expectedConnectionId);
  }
  if (!rawDevice) {
    throw new Error('The selected phone connection changed or is no longer available.');
  }
  const connectionId = rawDeviceConnectionId(rawDevice);
  const rawKey = rawDeviceKey(rawDevice);
  deviceIndex = rawDevice.index;

  if (
    sessionProcess &&
    sessionConnectionId === connectionId &&
    sessionReady
  ) {
    sessionDeviceIndex = deviceIndex;
    await sessionReady;
    return;
  }

  if (sessionProcess) {
    const previousSession = sessionProcess;
    destroyMtpSession('Restarting MTP session for a different phone connection.', true);
    await waitForChildProcessExit(previousSession, 4000);
  }

  sessionStdoutBuffer = '';
  sessionStderrBuffer = '';
  const child = spawn(helperPath, ['session', String(deviceIndex)]);
  sessionProcess = child;
  sessionDeviceIndex = deviceIndex;
  sessionRawKey = null;
  pendingSessionRawKey = rawKey;
  sessionConnectionId = null;
  pendingSessionConnectionId = connectionId;
  appendLog(`mtp session starting for device index ${deviceIndex}`);

  sessionReady = new Promise<void>((resolve, reject) => {
    sessionReadyResolve = resolve;
    sessionReadyReject = reject;
    sessionReadyTimer = setTimeout(() => {
      destroyMtpSession(`MTP session open timed out after ${NORMAL_MTP_SESSION_OPEN_TIMEOUT_MS}ms.`, true);
    }, NORMAL_MTP_SESSION_OPEN_TIMEOUT_MS);
  });

  child.stdout.on('data', handleSessionStdout);
  child.stderr.on('data', (chunk: Buffer) => {
    sessionStderrBuffer += chunk.toString('utf8');
    if (sessionStderrBuffer.length > 20_000) {
      sessionStderrBuffer = sessionStderrBuffer.slice(-20_000);
    }
    lastSessionStderr = sessionStderrBuffer.trim();
  });
  child.on('error', (error) => {
    if (sessionProcess === child) {
      destroyMtpSession(`MTP session process error: ${error.message}`);
    }
  });
  child.on('close', (code, signal) => {
    const message = `MTP session exited with code ${code ?? 'null'} signal ${signal ?? 'null'}.`;
    appendLog(message);
    if (sessionProcess === child) {
      lastSessionStderr = sessionStderrBuffer.trim() || lastSessionStderr;
      clearSessionReady(new Error(message));
      rejectSessionCommands(new Error(message));
      sessionProcess = null;
      sessionDeviceIndex = null;
      sessionRawKey = null;
      pendingSessionRawKey = null;
      sessionConnectionId = null;
      pendingSessionConnectionId = null;
      sessionStdoutBuffer = '';
      sessionStderrBuffer = '';
    }
  });

  await sessionReady;
}

async function runSessionCommand<T extends SessionPayload>(
  deviceIndex: number,
  deviceConnectionId: string,
  commandName: string,
  args: string[],
  timeoutMs: number,
  onEvent?: (payload: SessionPayload) => void
): Promise<T> {
  await ensureMtpSession(deviceIndex, deviceConnectionId);

  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error('MTP command arguments cannot contain newlines.');
  }

  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const line = [commandName, id, ...args].join(' ') + '\n';
    sessionQueue.push({
      id,
      name: commandName,
      line,
      timeoutMs,
      resolve: (payload) => resolve(payload as T),
      reject,
      onEvent
    });
    pumpSessionQueue();
  });
}

async function runBridgeJson<T>(
  command: string,
  args: string[],
  fallback: T,
  timeoutMs: number
): Promise<T & { helperPath: string; logPath: string; stderr?: string }> {
  try {
    const helperPath = await ensureBridge();

    return await new Promise((resolvePromise) => {
      let settled = false;
      let timedOut = false;
      const child = execFile(
        helperPath,
        [command, ...args],
        { maxBuffer: 1024 * 1024 * 100 },
        (error, stdout, stderr) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);

          const fallbackWithError = { ...fallback };
          const stderrText = stderr.trim();
          if (error || timedOut) {
            const errorMessage = timedOut
              ? `The MTP helper timed out after ${timeoutMs}ms.`
              : error?.message || 'The MTP helper failed.';
            const hint = bridgeFailureHint(stderrText, timedOut);
            appendLog(`${command} failed: ${errorMessage}`);
            const target = fallbackWithError as { message?: string };
            if (target.message) {
              const reason = timedOut
                ? 'The MTP helper timed out while opening the phone session.'
                : errorMessage;
              target.message = `${target.message} ${reason}${hint ? ` ${hint}` : ''}`;
            }
          }
          if (stderrText) {
            appendLog(`${command} stderr: ${stderrText}`);
          }

          try {
            const parsed = parseJson<T>(stdout, fallback);
            resolvePromise({
              ...parsed,
              helperPath,
              logPath: getLogPath(),
              stderr: stderr.trim() || undefined
            });
          } catch (parseError) {
            const message =
              parseError instanceof Error ? parseError.message : 'Unknown JSON parse error';
            appendLog(`${command} parse failed: ${message}`);
            resolvePromise({
              ...fallbackWithError,
              helperPath,
              logPath: getLogPath(),
              stderr: `${stderr.trim()}\n${message}`.trim()
            });
          }
        }
      );

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 1500);
      }, timeoutMs);
    });
  } catch (error) {
    return {
      ...fallback,
      ...missingBridgeStatus(error),
      helperPath: getBridgePath(),
      logPath: getLogPath()
    };
  }
}

async function getStatus(): Promise<DeviceStatus> {
  let status = await runBridgeJson<DeviceStatus>(
    'status',
    [],
    {
      ok: false,
      state: 'error',
      message: 'Unable to check MTP device status.',
      deviceCount: 0,
      rawDevices: [],
      helperPath: getBridgePath(),
      logPath: getLogPath()
    },
    10_000
  );

  if (status.state === 'no-device' && status.rawDevices.length === 0) {
    status = (await androidUsbFallbackStatus(status)) ?? status;
  }

  if (status.rawDevices.length > 0) {
    status = {
      ...status,
      rawDevices: withRawDeviceConnectionIds(
        await enrichRawDevicesWithAndroidUsbMetadata(status.rawDevices)
      )
    };
  }

  lastRawDevices = status.rawDevices;
  const protectedSessionReattached = await reattachProtectedSessionFromRawDevices(lastRawDevices);
  if (protectedSessionReattached && status.state !== 'connected') {
    status = {
      ...status,
      ok: true,
      state: 'connected',
      message: 'Protected phone-file session is still open. Reconnecting without another Mac password prompt.',
      deviceCount: Math.max(status.deviceCount, lastRawDevices.length),
      rawDevices: lastRawDevices
    };
  }

  const currentKeys = new Set(lastRawDevices.map((device) => rawDeviceKey(device)));
  const currentConnectionIds = new Set(lastRawDevices.map(rawDeviceConnectionId));
  if (currentKeys.size > 0) {
    rawDevicesMissingSince = null;
  }

  if (adminSession && currentKeys.size > 0) {
    const visibleAdminDevice = findVisibleDeviceForAdminSession(adminSession, lastRawDevices);
    if (!visibleAdminDevice) {
      destroyAdminMtpSession('The protected session belongs to a different phone connection.', true);
    } else if (usbSessionChanged(adminSession.usbSessionId, visibleAdminDevice)) {
      appendLog(
        `discarding protected MTP session because USB session changed: ${adminSession.usbSessionId} -> ${visibleAdminDevice.usbSessionId}`
      );
      destroyAdminMtpSession('Phone was unplugged and reconnected. Open files again for this USB session.', true);
    }
  }

  if (
    sessionProcess &&
    sessionConnectionId &&
    currentConnectionIds.size > 0 &&
    !currentConnectionIds.has(sessionConnectionId)
  ) {
    destroyMtpSession('The open MTP session belongs to a different phone connection.', true);
  }

  if (sessionProcess || adminSession) {
    if (currentKeys.size === 0) {
      if (adminSession && !sessionProcess) {
        if (rawDevicesMissingSince === null) {
          rawDevicesMissingSince = Date.now();
          appendLog('raw MTP device not visible to status while protected session is open; keeping protected session alive until the helper exits');
        }
      } else {
        const now = Date.now();
        if (rawDevicesMissingSince === null) {
          rawDevicesMissingSince = now;
          appendLog('raw MTP device temporarily missing while a normal session is open; keeping the session alive');
        }

        if (now - rawDevicesMissingSince >= RAW_DEVICE_MISSING_SESSION_GRACE_MS && sessionProcess) {
          destroyMtpSession('MTP raw device disappeared.');
        }
      }
    } else {
      if (sessionProcess && sessionRawKey && !currentKeys.has(sessionRawKey)) {
        appendLog(`preserving open MTP session for the same USB attachment across raw address change: ${sessionRawKey} -> ${Array.from(currentKeys).join(',')}`);
      }
      if (adminSession && !currentKeys.has(adminSession.rawKey)) {
        appendLog(`preserving protected MTP session across raw USB re-enumeration: ${adminSession.rawKey} -> ${Array.from(currentKeys).join(',')}`);
      }
    }
  }

  return {
    ...status,
    sessionOpen: !!sessionProcess || !!adminSession,
    protectedSessionOpen: !!adminSession,
    sessionConnectionId:
      adminSession?.connectionId ?? sessionConnectionId ?? pendingSessionConnectionId ?? undefined,
    sessionConnectionIds: Array.from(
      new Set(
        [adminSession?.connectionId, sessionConnectionId, pendingSessionConnectionId].filter(
          (connectionId): connectionId is string => !!connectionId
        )
      )
    )
  };
}

function limitDiagnosticText(value: string | undefined, maxLength = 4000): string {
  const normalized = (value ?? '').replace(/\0/g, '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n... truncated ...`;
}

function hexDeviceId(value: number): string {
  return value.toString(16).padStart(4, '0');
}

function rawDeviceLine(device: RawDevice): string {
  const usbProtection =
    device.needsDeviceAccessEntitlement === undefined
      ? 'not reported'
      : device.needsDeviceAccessEntitlement
        ? 'required'
        : 'not reported';
  const configuration =
    device.usbCurrentConfiguration === undefined
      ? 'unknown'
      : String(device.usbCurrentConfiguration);

  return [
    `- ${device.vendor || 'Unknown vendor'} ${device.product || 'Unknown product'}`,
    `vid:pid ${hexDeviceId(device.vendorId)}:${hexDeviceId(device.productId)}`,
    `bus/device ${device.bus}/${device.device}`,
    `usb session ${device.usbSessionId || 'unknown'}`,
    `mode ${device.connectionMode ?? 'unknown'}`,
    `serial ${device.serial || 'unknown'}`,
    `usb configuration ${configuration}`,
    `macOS USB protection ${usbProtection}`
  ].join(' | ');
}

function countJobsByStatus(): string {
  const counts = {
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
    canceled: 0
  };

  for (const job of transferJobs.values()) {
    counts[job.status] += 1;
  }

  return Object.entries(counts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
}

function connectionDiagnosis(status: DeviceStatus): string {
  const rawMtpVisible = status.rawDevices.some((device) => device.connectionMode === 'mtp');
  const rawUsbVisible = status.rawDevices.length > 0;

  if (status.protectedSessionOpen) {
    return 'Protected MTP file session is open.';
  }
  if (status.sessionOpen || status.state === 'connected') {
    return 'MTP file session is open.';
  }
  if (rawMtpVisible && status.state === 'connect-error') {
    return 'USB and File Transfer mode are visible, but the MTP file session is not open.';
  }
  if (rawUsbVisible) {
    return 'USB device is visible, but File Transfer mode or file access is not open.';
  }
  return 'No Android file-transfer USB device is visible.';
}

function buildDiagnosticsReport(status: DeviceStatus, generatedAt: string): string {
  const cameraServices = runningMacCameraServices();
  const rawDevices = status.rawDevices.length
    ? status.rawDevices.map(rawDeviceLine)
    : ['- none reported'];
  const stderr = limitDiagnosticText(status.stderr || lastSessionStderr || adminSession?.stderrBuffer);

  return [
    'Android File Transfer for macOS Diagnostics',
    `Generated: ${generatedAt}`,
    '',
    'App',
    `Version: ${app.getVersion()}`,
    `Packaged: ${app.isPackaged ? 'yes' : 'no'}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron ?? 'unknown'}`,
    `Node: ${process.versions.node}`,
    '',
    'Paths',
    `Helper: ${getBridgePath()}`,
    `Log: ${getLogPath()}`,
    '',
    'Connection',
    `Diagnosis: ${connectionDiagnosis(status)}`,
    `State: ${status.state}`,
    `OK: ${status.ok ? 'yes' : 'no'}`,
    `Message: ${status.message}`,
    `Device count: ${status.deviceCount}`,
    `Session open: ${status.sessionOpen ? 'yes' : 'no'}`,
    `Protected session open: ${status.protectedSessionOpen ? 'yes' : 'no'}`,
    `Camera/import services: ${cameraServices.length ? cameraServices.join(', ') : 'none detected'}`,
    '',
    'Raw USB devices',
    ...rawDevices,
    '',
    'Transfer queue',
    countJobsByStatus(),
    '',
    'Recent native error',
    stderr || 'none',
    '',
    'Privacy note',
    'This report includes connection state, USB metadata, helper paths, and recent native error text. It does not include a phone file listing.'
  ].join('\n');
}

async function copyDiagnostics(): Promise<DiagnosticsCopyResult> {
  const generatedAt = new Date().toISOString();

  try {
    const status = await getStatus();
    const text = buildDiagnosticsReport(status, generatedAt);
    clipboard.writeText(text);
    appendLog('diagnostics report copied to clipboard');
    return {
      ok: true,
      copied: true,
      generatedAt,
      text,
      message: 'Copied connection report. It includes USB/session state, not phone file names.'
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const text = [
      'Android File Transfer for macOS Diagnostics',
      `Generated: ${generatedAt}`,
      '',
      'Status check failed while building the report.',
      limitDiagnosticText(detail) || 'Unknown error.',
      '',
      `Helper: ${getBridgePath()}`,
      `Log: ${getLogPath()}`
    ].join('\n');

    clipboard.writeText(text);
    appendLog(`limited diagnostics report copied after status failure: ${detail}`);
    return {
      ok: false,
      copied: true,
      generatedAt,
      text,
      message: 'Copied a limited report. The phone status check failed while building it.'
    };
  }
}

async function scanInventory(): Promise<InventoryResult> {
  const fallback: InventoryResult = {
    ok: false,
    state: 'error',
    message: 'Unable to scan the MTP device.',
    devices: [],
    helperPath: getBridgePath(),
    logPath: getLogPath()
  };

  await refreshRawDevices();
  const candidates = lastRawDevices.filter((device) => device.connectionMode !== 'usb-only');
  if (!candidates.length) {
    return helperMetadata({
      ...fallback,
      state: lastRawDevices.length ? 'connect-error' : 'no-device',
      message: lastRawDevices.length
        ? 'A phone is connected, but File Transfer mode is not available.'
        : 'No phone file-transfer connection was detected.'
    });
  }

  const devices: MtpDeviceInventory[] = [];
  const failures: string[] = [];
  const stderrParts: string[] = [];
  let usedProtectedAccess = false;

  for (const rawDevice of candidates) {
    const connectionId = rawDeviceConnectionId(rawDevice);
    try {
      const useProtectedAccess = await adminFallbackIsAvailable(rawDevice.index, connectionId);
      const result = useProtectedAccess
        ? await runAdminSessionCommand<InventoryResult & SessionPayload>(
            rawDevice.index,
            connectionId,
            'inventory',
            [],
            60_000
          )
        : await runSessionCommand<InventoryResult & SessionPayload>(
            rawDevice.index,
            connectionId,
            'inventory',
            [],
            60_000
          );
      const nativeDevice =
        result.devices?.find((candidate) => candidate.index === rawDevice.index) ?? result.devices?.[0];
      if (!result.ok || !nativeDevice) {
        failures.push(result.message || `${rawDevice.vendor || rawDevice.product} did not return storage information.`);
        continue;
      }

      devices.push({
        ...nativeDevice,
        index: rawDevice.index,
        connectionId,
        protectedAccess: useProtectedAccess
      });
      usedProtectedAccess = usedProtectedAccess || useProtectedAccess;
      const stderr = useProtectedAccess ? adminSession?.stderrBuffer : lastSessionStderr;
      if (stderr?.trim()) {
        stderrParts.push(stderr.trim());
      }
    } catch (error) {
      const stderr = adminSession?.connectionId === connectionId ? adminSession.stderrBuffer : lastSessionStderr;
      const message = sessionErrorMessage(
        `Unable to open ${rawDevice.vendor || rawDevice.product || 'the phone'}.`,
        error,
        stderr ?? ''
      );
      appendLog(`inventory failed for ${connectionId}: ${message}`);
      failures.push(message);
      if (stderr?.trim()) {
        stderrParts.push(stderr.trim());
      }
    }
  }

  if (devices.length) {
    return helperMetadata(
      {
        ok: true,
        state: 'connected',
        message: failures.length
          ? `Opened ${devices.length} phone${devices.length === 1 ? '' : 's'}; ${failures.length} other connection${failures.length === 1 ? '' : 's'} could not be opened.`
          : `Opened ${devices.length} phone${devices.length === 1 ? '' : 's'}.`,
        devices,
        helperPath: getBridgePath(),
        logPath: getLogPath(),
        protectedAccess: usedProtectedAccess
      },
      stderrParts.join('\n')
    );
  }

  const combinedMessage = failures.join(' ').trim();
  const accessBlocked = candidates.some((device) => device.needsDeviceAccessEntitlement) ||
    normalMtpAccessBlocked(combinedMessage, stderrParts.join('\n'));
  return helperMetadata(
    {
      ...fallback,
      state: accessBlocked ? 'connect-error' : 'error',
      message: accessBlocked ? blockedMtpAccessMessage() : combinedMessage || fallback.message
    },
    stderrParts.join('\n')
  );
}

async function listFolder(
  deviceIndex: number,
  deviceConnectionId: string,
  storageId: number,
  parentId: number
): Promise<FolderListResult> {
  const reportProgress = (payload: SessionPayload): void => {
    if (
      payload.event !== 'progress' ||
      typeof payload.sent !== 'number' ||
      typeof payload.total !== 'number'
    ) {
      return;
    }
    const progress: FolderListProgress = {
      deviceConnectionId,
      storageId,
      parentId,
      sent: payload.sent,
      total: payload.total
    };
    mainWindow?.webContents.send('folder-list:progress', progress);
  };
  const fallback: FolderListResult = {
    ok: false,
    state: 'error',
    message: 'Unable to list the selected MTP folder.',
    deviceIndex,
    storageId,
    parentId,
    objects: [],
    helperPath: getBridgePath(),
    logPath: getLogPath()
  };

  if (await adminFallbackIsAvailable(deviceIndex, deviceConnectionId)) {
    try {
      const result = await runAdminSessionCommand<FolderListResult & SessionPayload>(
        deviceIndex,
        deviceConnectionId,
        'list',
        [String(storageId), String(parentId)],
        180_000,
        reportProgress
      );
      return helperMetadata(result, adminSession?.stderrBuffer);
    } catch (error) {
      appendLog(`admin session list failed: ${String(error)}`);
      return helperMetadata(
        {
          ...fallback,
          state: normalMtpAccessBlocked(error, adminSession?.stderrBuffer ?? '') ? 'connect-error' : fallback.state,
          message: sessionErrorMessage(fallback.message, error, adminSession?.stderrBuffer ?? '')
        },
        adminSession?.stderrBuffer
      );
    }
  }

  try {
    const result = await runSessionCommand<FolderListResult & SessionPayload>(
      deviceIndex,
      deviceConnectionId,
      'list',
      [String(storageId), String(parentId)],
      180_000,
      reportProgress
    );
    return helperMetadata(result, lastSessionStderr);
  } catch (error) {
    appendLog(`session list failed: ${String(error)}`);
    const accessBlocked = await normalMtpAccessBlockedAfterRefresh(error, lastSessionStderr);
    return helperMetadata(
      {
        ...fallback,
        state: accessBlocked ? 'connect-error' : fallback.state,
        message: accessBlocked
          ? blockedMtpAccessMessage()
          : sessionErrorMessage(fallback.message, error, lastSessionStderr)
      },
      lastSessionStderr
    );
  }
}

async function createPhoneFolder(request: CreateFolderRequest): Promise<CreateFolderResult> {
  const folderName = request.name.replace(/\0/g, '').trim();
  const fallback: CreateFolderResult = {
    ok: false,
    state: 'error',
    message: 'Unable to create the folder on the phone.',
    deviceIndex: request.deviceIndex,
    storageId: request.storageId,
    parentId: request.parentId,
    folderId: 0,
    name: folderName,
    helperPath: getBridgePath(),
    logPath: getLogPath()
  };

  if (!folderName) {
    return {
      ...fallback,
      message: 'The folder name is empty.'
    };
  }

  const normalizeResult = (result: SessionPayload, stderr?: string): CreateFolderResult => {
    const folderId = typeof result.folderId === 'number' ? result.folderId : 0;
    return helperMetadata(
      {
        ok: Boolean(result.ok && folderId > 0),
        state: result.ok && folderId > 0 ? 'connected' : 'error',
        message:
          result.ok && folderId > 0
            ? `Created ${folderName} on the phone.`
            : result.message || fallback.message,
        deviceIndex: request.deviceIndex,
        storageId: request.storageId,
        parentId: request.parentId,
        folderId,
        name: folderName
      },
      stderr
    );
  };

  if (await adminFallbackIsAvailable(request.deviceIndex, request.deviceConnectionId)) {
    try {
      const result = await runAdminSessionCommand<SessionPayload>(
        request.deviceIndex,
        request.deviceConnectionId,
        'mkdir',
        [String(request.storageId), String(request.parentId), folderName],
        60_000
      );
      return normalizeResult(result, adminSession?.stderrBuffer);
    } catch (error) {
      appendLog(`admin session mkdir failed: ${String(error)}`);
      return helperMetadata(
        {
          ...fallback,
          state: normalMtpAccessBlocked(error, adminSession?.stderrBuffer ?? '') ? 'connect-error' : fallback.state,
          message: sessionErrorMessage(fallback.message, error, adminSession?.stderrBuffer ?? '')
        },
        adminSession?.stderrBuffer
      );
    }
  }

  try {
    const result = await runSessionCommand<SessionPayload>(
      request.deviceIndex,
      request.deviceConnectionId,
      'mkdir',
      [String(request.storageId), String(request.parentId), folderName],
      60_000
    );
    return normalizeResult(result, lastSessionStderr);
  } catch (error) {
    appendLog(`session mkdir failed: ${String(error)}`);
    const accessBlocked = await normalMtpAccessBlockedAfterRefresh(error, lastSessionStderr);
    return helperMetadata(
      {
        ...fallback,
        state: accessBlocked ? 'connect-error' : fallback.state,
        message: accessBlocked
          ? blockedMtpAccessMessage()
          : sessionErrorMessage(fallback.message, error, lastSessionStderr)
      },
      lastSessionStderr
    );
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/:]/g, '_').replace(/\0/g, '').trim();
  return cleaned || 'mtp-file';
}

function uniqueDestinationPath(
  directory: string,
  name: string,
  reservedPaths: ReadonlySet<string> = new Set()
): string {
  const safeName = sanitizeFileName(name);
  const dot = safeName.lastIndexOf('.');
  const base = dot > 0 ? safeName.slice(0, dot) : safeName;
  const ext = dot > 0 ? safeName.slice(dot) : '';
  let candidate = join(directory, safeName);
  let counter = 2;

  while (existsSync(candidate) || reservedPaths.has(candidate)) {
    candidate = join(directory, `${base} ${counter}${ext}`);
    counter += 1;
  }

  return candidate;
}

function downloadDestinationPlan(
  directory: string,
  name: string,
  reservedPaths: ReadonlySet<string> = new Set()
): Pick<
  TransferJob,
  'destinationPath' | 'originalDestinationPath' | 'renamedDestination'
> {
  const originalDestinationPath = join(directory, sanitizeFileName(name));
  const destinationPath = uniqueDestinationPath(directory, name, reservedPaths);
  return {
    destinationPath,
    originalDestinationPath,
    renamedDestination: destinationPath !== originalDestinationPath
  };
}

function reservedDownloadDestinationPaths(excludeJobId?: string): Set<string> {
  return new Set(
    Array.from(transferJobs.values())
      .filter(
        (job) =>
          job.id !== excludeJobId &&
          job.direction === 'download' &&
          (job.status === 'queued' || job.status === 'active')
      )
      .map((job) => job.destinationPath)
  );
}

function temporaryDownloadPath(destinationPath: string): string {
  return join(
    dirname(destinationPath),
    `.android-file-transfer-for-macos-${randomUUID()}-${sanitizeFileName(basename(destinationPath))}.partial`
  );
}

function cleanupTemporaryDownload(job: TransferJob): void {
  if (!job.temporaryPath) {
    return;
  }
  try {
    rmSync(job.temporaryPath, { force: true });
  } catch (error) {
    appendLog(`warning: unable to remove partial transfer ${job.temporaryPath}: ${String(error)}`);
  }
  job.temporaryPath = undefined;
}

function finalizeDownloadedFile(job: TransferJob): void {
  const temporaryPath = job.temporaryPath;
  if (!temporaryPath) {
    throw new Error('The transfer completed without a partial Mac file to publish.');
  }

  if (job.direction === 'download' && job.promiseId) {
    publishTemporaryFile({
      temporaryPath,
      destinationPath: job.destinationPath,
      expectedSize: job.size
    });
    job.originalDestinationPath = job.destinationPath;
    job.renamedDestination = false;
  } else if (job.direction === 'download') {
    const reservedPaths = reservedDownloadDestinationPaths(job.id);
    if (reservedPaths.has(job.destinationPath)) {
      job.destinationPath = uniqueDestinationPath(job.destinationDirectory, job.name, reservedPaths);
    }
    const published = publishTemporaryFile({
      temporaryPath,
      destinationPath: job.destinationPath,
      expectedSize: job.size,
      onCollision: () => uniqueDestinationPath(job.destinationDirectory, job.name, reservedPaths)
    });
    job.destinationPath = published.destinationPath;
    job.originalDestinationPath ??= join(job.destinationDirectory, sanitizeFileName(job.name));
    job.renamedDestination = job.destinationPath !== job.originalDestinationPath;
  } else {
    publishTemporaryFile({
      temporaryPath,
      destinationPath: job.destinationPath,
      expectedSize: job.size,
      allowExistingEquivalent: true
    });
  }

  job.temporaryPath = undefined;
}

function formatBytesForMessage(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'an unknown amount of space';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function availableBytesForDirectory(directory: string): { bytes: number; volumeKey: string } {
  const stats = statfsSync(directory);
  const directoryStats = statSync(directory);
  const availableBlocks = Number(stats.bavail);
  const blockSize = Number(stats.bsize);
  const bytes = availableBlocks * blockSize;

  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`Unable to read free space for ${directory}.`);
  }

  return {
    bytes,
    volumeKey: String(directoryStats.dev)
  };
}

function downloadSpaceError(
  job: TransferJob,
  reservedBytesByVolume: Map<string, number>
): string | null {
  if (job.direction !== 'download' || job.size <= 0) {
    return null;
  }

  try {
    const available = availableBytesForDirectory(job.destinationDirectory);
    const alreadyReserved = reservedBytesByVolume.get(available.volumeKey) ?? 0;
    const remainingBytes = Math.max(available.bytes - alreadyReserved, 0);

    if (job.size > remainingBytes) {
      const recovery = job.promiseId
        ? 'Free space on the Mac, then drag the item again.'
        : 'Choose another Mac folder or free space, then Retry.';
      return [
        'Not enough free space on the Mac.',
        `${job.name} needs ${formatBytesForMessage(job.size)}, but this Mac volume has about ${formatBytesForMessage(remainingBytes)} free.`,
        recovery
      ].join(' ');
    }

    reservedBytesByVolume.set(available.volumeKey, alreadyReserved + job.size);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`warning: unable to check Mac free space for ${job.destinationDirectory}: ${message}`);
  }

  return null;
}

function applyDownloadSpacePreflight(
  job: TransferJob,
  reservedBytesByVolume: Map<string, number>
): boolean {
  const error = downloadSpaceError(job, reservedBytesByVolume);
  if (!error) {
    return true;
  }

  job.status = 'failed';
  job.error = error;
  job.finishedAt = Date.now();
  job.bytesTransferred = 0;
  job.totalBytes = job.size;
  appendLog(`${job.direction} preflight failed: ${job.name}: ${error}`);
  return false;
}

function preserveDownloadedModifiedTime(job: TransferJob): void {
  if (
    job.direction !== 'download' ||
    typeof job.modified !== 'number' ||
    !Number.isFinite(job.modified) ||
    job.modified <= 0
  ) {
    return;
  }

  try {
    const fileStat = statSync(job.destinationPath);
    const modifiedAt = new Date(job.modified * 1000);
    utimesSync(job.destinationPath, fileStat.atime, modifiedAt);
    appendLog(`preserved phone modified time for ${job.destinationPath}: ${modifiedAt.toISOString()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`warning: unable to preserve phone modified time for ${job.destinationPath}: ${message}`);
  }
}

function pathIsInside(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function localTypeForName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return 'File';
  }
  return name.slice(dot + 1).toUpperCase();
}

function localEntryForPath(entryPath: string): LocalEntry | null {
  try {
    const entryStat = lstatSync(entryPath);
    if (entryStat.isSymbolicLink()) {
      appendLog(`local symbolic link skipped during phone upload planning: ${entryPath}`);
      return null;
    }
    const isFolder = entryStat.isDirectory();
    const isFile = entryStat.isFile();
    if (!isFolder && !isFile) {
      return null;
    }

    const name = basename(entryPath);
    return {
      path: entryPath,
      name,
      kind: isFolder ? 'folder' : 'file',
      size: isFile ? entryStat.size : 0,
      modified: Math.floor(entryStat.mtimeMs / 1000),
      type: isFolder ? 'Folder' : localTypeForName(name)
    };
  } catch (error) {
    appendLog(`local path skipped: ${entryPath}: ${String(error)}`);
    return null;
  }
}

function listLocalDirectory(directoryPath?: string, showHiddenFiles = false): LocalDirectoryResult {
  const targetPath = resolve(directoryPath || app.getPath('home'));
  const parentPath = dirname(targetPath);

  try {
    const targetStat = statSync(targetPath);
    if (!targetStat.isDirectory()) {
      return {
        ok: false,
        path: targetPath,
        parentPath,
        message: 'Choose a folder to browse Mac files.',
        entries: []
      };
    }

    const entries: LocalEntry[] = readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
      if (!showHiddenFiles && entry.name.startsWith('.')) {
        return [];
      }
      const entryPath = join(targetPath, entry.name);
      const localEntry = localEntryForPath(entryPath);
      return localEntry ? [localEntry] : [];
    });

    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return {
      ok: true,
      path: targetPath,
      parentPath,
      message: `Listed ${entries.length} ${entries.length === 1 ? 'item' : 'items'} in ${basename(targetPath) || targetPath}.`,
      entries
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read that Mac folder.';
    appendLog(`local directory list failed: ${targetPath}: ${message}`);
    return {
      ok: false,
      path: targetPath,
      parentPath,
      message,
      entries: []
    };
  }
}

function getCommonMacFolders(): CommonMacFolder[] {
  const candidates: CommonMacFolder[] = [
    { id: 'home', label: 'Home', path: app.getPath('home') },
    { id: 'downloads', label: 'Downloads', path: app.getPath('downloads') },
    { id: 'documents', label: 'Documents', path: app.getPath('documents') },
    { id: 'pictures', label: 'Pictures', path: app.getPath('pictures') },
    { id: 'movies', label: 'Movies', path: app.getPath('videos') },
    { id: 'desktop', label: 'Desktop', path: app.getPath('desktop') }
  ];
  const seenPaths = new Set<string>();
  return candidates.filter((folder) => {
    try {
      const folderPath = resolve(folder.path);
      if (seenPaths.has(folderPath) || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
        return false;
      }
      seenPaths.add(folderPath);
      folder.path = folderPath;
      return true;
    } catch (error) {
      appendLog(`common Mac folder skipped: ${folder.label}: ${String(error)}`);
      return false;
    }
  });
}

function ensureLocalDirectory(directoryPath: string): LocalDirectoryResult {
  const targetPath = resolve(directoryPath);
  try {
    mkdirSync(targetPath, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create that Mac folder.';
    appendLog(`local directory create failed: ${targetPath}: ${message}`);
    return {
      ok: false,
      path: targetPath,
      parentPath: dirname(targetPath),
      message,
      entries: []
    };
  }
  return listLocalDirectory(targetPath);
}

function setLocalModifiedTime(localPath: string, modified: number): LocalModifiedTimeResult {
  const targetPath = resolve(localPath);
  if (!Number.isFinite(modified) || modified <= 0) {
    return {
      ok: false,
      path: targetPath,
      message: 'The phone did not report a valid modified date.'
    };
  }

  try {
    const fileStat = statSync(targetPath);
    const modifiedAt = new Date(modified * 1000);
    utimesSync(targetPath, fileStat.atime, modifiedAt);
    appendLog(`preserved phone modified time for local path ${targetPath}: ${modifiedAt.toISOString()}`);
    return {
      ok: true,
      path: targetPath,
      modified,
      message: 'Modified date preserved.'
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to preserve that modified date.';
    appendLog(`warning: unable to preserve phone folder modified time for ${targetPath}: ${message}`);
    return {
      ok: false,
      path: targetPath,
      message
    };
  }
}

function cloneJob(job: TransferJob): TransferJob {
  return { ...job };
}

function sendTransferEvent(type: TransferEvent['type'], job: TransferJob): void {
  mainWindow?.webContents.send('transfer:event', { type, job: cloneJob(job) });
}

function nextQueuedJob(): TransferJob | undefined {
  return Array.from(transferJobs.values()).find((job) => job.status === 'queued');
}

async function requireCurrentPhoneConnection(job: TransferJob): Promise<void> {
  let rawDevice = rawDeviceForConnection(job.deviceIndex, job.deviceConnectionId);
  if (!rawDevice) {
    await refreshRawDevices();
    rawDevice = rawDeviceForConnection(job.deviceIndex, job.deviceConnectionId);
  }
  if (!rawDevice) {
    throw new Error('The phone connection changed before this transfer started. Queue the file again for the currently connected phone.');
  }
}

function handleTransferPayload(job: TransferJob, payload: SessionPayload): void {
  if (payload.event === 'started') {
    sendTransferEvent('started', job);
    return;
  }

  if (payload.event === 'progress') {
    const now = Date.now();
    const elapsedSeconds = Math.max((now - (job.startedAt ?? now)) / 1000, 0.1);
    const knownTotal = job.size > 0 ? job.size : job.totalBytes;
    const reportedTransferred = typeof payload.sent === 'number' ? payload.sent : job.bytesTransferred;
    job.totalBytes = knownTotal > 0 ? knownTotal : typeof payload.total === 'number' ? payload.total : job.totalBytes;
    job.bytesTransferred =
      job.totalBytes > 0
        ? Math.min(Math.max(reportedTransferred, 0), job.totalBytes)
        : Math.max(reportedTransferred, 0);
    job.speedBytesPerSecond = job.bytesTransferred / elapsedSeconds;
    const remaining = Math.max(job.totalBytes - job.bytesTransferred, 0);
    job.etaSeconds = job.speedBytesPerSecond > 0 ? remaining / job.speedBytesPerSecond : null;
    sendTransferEvent('progress', job);
    return;
  }

  if (payload.event === 'failed') {
    job.error = payload.message || 'Transfer failed.';
  }
}

function transferCommandForJob(job: TransferJob): { commandName: string; args: string[] } {
  if (job.direction === 'upload') {
    if (job.storageId === undefined || job.parentId === undefined || !job.sourcePath) {
      throw new Error('Upload job is missing its phone destination or Mac source path.');
    }
    return {
      commandName: 'upload',
      args: [String(job.storageId), String(job.parentId), job.sourcePath]
    };
  }

  if (job.objectId === undefined || !job.temporaryPath) {
    throw new Error('Download job is missing its phone object id.');
  }
  return {
    commandName: 'download',
    args: [String(job.objectId), job.temporaryPath]
  };
}

async function removeMoveSource(
  job: TransferJob,
  transferResult: SessionPayload,
  usesAdminSession: boolean
): Promise<void> {
  job.sourceRemovalStatus = 'pending';
  job.sourceRemovalError = undefined;

  try {
    if (job.direction === 'download') {
      if (job.objectId === undefined) {
        throw new Error('The completed copy no longer has a phone source identifier.');
      }
      const deleteResult = usesAdminSession
        ? await runAdminSessionCommand<SessionPayload>(
            job.deviceIndex,
            job.deviceConnectionId,
            'delete',
            [String(job.objectId)],
            TRANSFER_COMMAND_IDLE_TIMEOUT_MS
          )
        : await runSessionCommand<SessionPayload>(
            job.deviceIndex,
            job.deviceConnectionId,
            'delete',
            [String(job.objectId)],
            TRANSFER_COMMAND_IDLE_TIMEOUT_MS
          );
      if (!deleteResult.ok || deleteResult.event !== 'complete') {
        throw new Error(deleteResult.message || 'The phone did not delete the source file.');
      }
    } else if (job.direction === 'upload') {
      if (transferResult.verified !== true || !transferResult.objectId) {
        throw new Error('The phone copy could not be verified after upload.');
      }
      if (!job.sourcePath || !job.sourceIdentity) {
        throw new Error('The Mac source identity was not recorded when this move was queued.');
      }
      removeVerifiedLocalMoveSource(job.sourcePath, job.sourceIdentity);
    } else {
      throw new Error('Drag preparation cannot remove its source.');
    }

    job.sourceRemovalStatus = 'removed';
    job.resultMessage = 'Moved. The source was deleted after the copy was verified.';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.sourceRemovalStatus = 'kept';
    job.sourceRemovalError = message;
    job.resultMessage = `Copy finished, but the source was kept. ${message}`;
    appendLog(`move source kept: ${job.name}: ${message}`);
  }
}

async function runTransferJob(job: TransferJob): Promise<void> {
  activeTransferUsesAdminSession = false;
  const label =
    job.direction === 'upload'
      ? 'upload'
      : 'download';
  try {
    await requireCurrentPhoneConnection(job);
    if (job.direction === 'download') {
      cleanupTemporaryDownload(job);
      job.temporaryPath = temporaryDownloadPath(job.destinationPath);
    }
    const command = transferCommandForJob(job);
    activeTransferUsesAdminSession = await adminFallbackIsAvailable(
      job.deviceIndex,
      job.deviceConnectionId
    );
    const result = activeTransferUsesAdminSession
      ? await runAdminSessionCommand<SessionPayload>(
          job.deviceIndex,
          job.deviceConnectionId,
          command.commandName,
          command.args,
          TRANSFER_COMMAND_IDLE_TIMEOUT_MS,
          (payload) => handleTransferPayload(job, payload)
        )
      : await runSessionCommand<SessionPayload>(
          job.deviceIndex,
          job.deviceConnectionId,
          command.commandName,
          command.args,
          TRANSFER_COMMAND_IDLE_TIMEOUT_MS,
          (payload) => handleTransferPayload(job, payload)
        );

    if (activeWasCanceled) {
      job.status = 'canceled';
      job.error = 'Transfer canceled.';
      appendLog(`${label} canceled: ${job.name}`);
    } else if (result.ok && result.event === 'complete') {
      if (job.direction === 'download') {
        finalizeDownloadedFile(job);
      }
      if (job.operation === 'move') {
        await removeMoveSource(job, result, activeTransferUsesAdminSession);
      }
      job.status = 'completed';
      job.totalBytes = job.size > 0 ? job.size : job.totalBytes;
      job.bytesTransferred = job.totalBytes || job.size;
      job.etaSeconds = 0;
      if (job.operation === 'copy') {
        job.resultMessage = result.message;
      }
      preserveDownloadedModifiedTime(job);
      appendLog(`${label} completed: ${job.destinationPath}`);
    } else {
      job.status = 'failed';
      job.error = result.message || 'Transfer failed.';
      appendLog(`${label} failed: ${job.name}: ${job.error}`);
    }
  } catch (error) {
    if (activeWasCanceled) {
      job.status = 'canceled';
      job.error = 'Transfer canceled.';
      appendLog(`${label} canceled: ${job.name}`);
    } else {
      job.status = 'failed';
      job.error = sessionErrorMessage('Transfer failed.', error, lastSessionStderr);
      appendLog(`${label} failed: ${job.name}: ${job.error}`);
    }
  } finally {
    cleanupTemporaryDownload(job);
    job.finishedAt = Date.now();
    activeJobId = null;
    activeTransferUsesAdminSession = false;

    if (job.status === 'completed') {
      sendTransferEvent('completed', job);
    } else if (job.status === 'canceled') {
      sendTransferEvent('canceled', job);
    } else {
      sendTransferEvent('failed', job);
    }

    handlePromiseTransferTerminal(job);

    processTransferQueue();
  }
}

function processTransferQueue(): void {
  if (
    pendingPromisePlanningCount > 0 ||
    activeJobId !== null ||
    activeSessionCommand !== null ||
    adminSession?.activeCommand
  ) {
    return;
  }

  const job = nextQueuedJob();
  if (!job) {
    return;
  }

  activeWasCanceled = false;
  job.status = 'active';
  job.startedAt = Date.now();
  job.finishedAt = undefined;
  job.error = undefined;
  job.resultMessage = undefined;
  job.sourceRemovalStatus = undefined;
  job.sourceRemovalError = undefined;
  job.bytesTransferred = 0;
  job.totalBytes = job.size;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  activeJobId = job.id;
  sendTransferEvent('started', job);
  appendLog(`${job.direction} started: ${job.name} -> ${job.destinationPath}`);
  void runTransferJob(job);
}

function enqueueDownloads(
  requests: TransferRequest[],
  operation: TransferOperation = 'copy'
): TransferJob[] {
  const reservedBytesByVolume = new Map<string, number>();
  const reservedPaths = reservedDownloadDestinationPaths();
  const jobs = requests.map((request) => {
    mkdirSync(request.destinationDirectory, { recursive: true });
    const destination = downloadDestinationPlan(
      request.destinationDirectory,
      request.name,
      reservedPaths
    );
    reservedPaths.add(destination.destinationPath);
    const job: TransferJob = {
      id: randomUUID(),
      direction: 'download',
      operation,
      deviceIndex: request.deviceIndex,
      deviceConnectionId: request.deviceConnectionId,
      storageId: request.storageId,
      parentId: request.parentId,
      objectId: request.objectId,
      name: request.name,
      size: request.size,
      modified: request.modified,
      destinationDirectory: request.destinationDirectory,
      destinationPath: destination.destinationPath,
      originalDestinationPath: destination.originalDestinationPath,
      renamedDestination: destination.renamedDestination,
      status: 'queued',
      bytesTransferred: 0,
      totalBytes: request.size,
      speedBytesPerSecond: 0,
      etaSeconds: null
    };
    const canQueue = applyDownloadSpacePreflight(job, reservedBytesByVolume);
    transferJobs.set(job.id, job);
    sendTransferEvent(canQueue ? 'queued' : 'failed', job);
    return cloneJob(job);
  });

  processTransferQueue();
  return jobs;
}

function enqueuePromisedDownloads(
  files: PromisedDownloadFile[],
  promiseId: string
): TransferJob[] {
  const reservedBytesByVolume = new Map<string, number>();
  const jobs = files.map(({ request, destinationPath }) => {
    mkdirSync(dirname(destinationPath), { recursive: true });
    const job: TransferJob = {
      id: randomUUID(),
      direction: 'download',
      operation: 'copy',
      deviceIndex: request.deviceIndex,
      deviceConnectionId: request.deviceConnectionId,
      storageId: request.storageId,
      parentId: request.parentId,
      objectId: request.objectId,
      promiseId,
      name: request.name,
      size: request.size,
      modified: request.modified,
      destinationDirectory: dirname(destinationPath),
      destinationPath,
      originalDestinationPath: destinationPath,
      renamedDestination: false,
      status: 'queued',
      bytesTransferred: 0,
      totalBytes: request.size,
      speedBytesPerSecond: 0,
      etaSeconds: null
    };
    if (existsSync(destinationPath)) {
      job.status = 'failed';
      job.error = `The destination already contains ${basename(destinationPath)}.`;
      job.finishedAt = Date.now();
    } else {
      applyDownloadSpacePreflight(job, reservedBytesByVolume);
    }
    transferJobs.set(job.id, job);
    sendTransferEvent(job.status === 'failed' ? 'failed' : 'queued', job);
    return cloneJob(job);
  });
  return jobs;
}

function enqueueUploads(
  requests: UploadRequest[],
  operation: TransferOperation = 'copy'
): TransferJob[] {
  const jobs = requests.flatMap((request) => {
    if (!request.sourcePath) {
      return [];
    }

    let fileSize = request.size;
    let sourceIdentity: LocalSourceIdentity;
    try {
      const sourceStat = lstatSync(request.sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        return [];
      }
      fileSize = sourceStat.size;
      sourceIdentity = {
        device: sourceStat.dev,
        inode: sourceStat.ino,
        size: sourceStat.size,
        modifiedMs: sourceStat.mtimeMs,
        changedMs: sourceStat.ctimeMs
      };
    } catch {
      return [];
    }

    const destinationPath = `mtp://${request.storageId}/${request.parentId}/${request.name}`;
    const job: TransferJob = {
      id: randomUUID(),
      direction: 'upload',
      operation,
      deviceIndex: request.deviceIndex,
      deviceConnectionId: request.deviceConnectionId,
      storageId: request.storageId,
      parentId: request.parentId,
      sourcePath: request.sourcePath,
      sourceIdentity,
      name: request.name,
      size: fileSize,
      destinationDirectory: 'Phone folder',
      destinationPath,
      status: 'queued',
      bytesTransferred: 0,
      totalBytes: fileSize,
      speedBytesPerSecond: 0,
      etaSeconds: null
    };
    transferJobs.set(job.id, job);
    sendTransferEvent('queued', job);
    return [cloneJob(job)];
  });

  processTransferQueue();
  return jobs;
}

async function confirmFileMove(
  direction: 'download' | 'upload',
  fileCount: number,
  destinationLabel: string
): Promise<boolean> {
  if (fileCount <= 0) {
    return false;
  }

  const sourceLabel = direction === 'download' ? 'the phone' : 'this Mac';
  const detail = [
    `Each file will be copied to ${destinationLabel} and checked first.`,
    `Only after a file's destination copy is verified will its source be deleted from ${sourceLabel}.`,
    'If copying, verification, or deletion fails, the source file is kept. Folders are copied, not moved.'
  ].join('\n\n');
  const options = {
    type: 'warning' as const,
    buttons: ['Move Files', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Confirm file move',
    message: `Move ${fileCount} ${fileCount === 1 ? 'file' : 'files'} to ${destinationLabel}?`,
    detail
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function enqueueMoveDownloads(requests: TransferRequest[]): Promise<MoveQueueResult> {
  const destinationLabel = requests[0]?.destinationDirectory || 'the selected Mac folder';
  const confirmed = await confirmFileMove('download', requests.length, destinationLabel);
  return {
    confirmed,
    jobs: confirmed ? enqueueDownloads(requests, 'move') : []
  };
}

async function enqueueMoveUploads(requests: UploadRequest[]): Promise<MoveQueueResult> {
  const confirmed = await confirmFileMove('upload', requests.length, 'the open phone folder');
  return {
    confirmed,
    jobs: confirmed ? enqueueUploads(requests, 'move') : []
  };
}

function retryTransfer(jobId: string): TransferJob | null {
  const job = transferJobs.get(jobId);
  if (!job || job.promiseId || (job.status !== 'failed' && job.status !== 'canceled')) {
    return null;
  }

  if (job.direction === 'download') {
    const destination = downloadDestinationPlan(
      job.destinationDirectory,
      job.name,
      reservedDownloadDestinationPaths(job.id)
    );
    job.destinationPath = destination.destinationPath;
    job.originalDestinationPath = destination.originalDestinationPath;
    job.renamedDestination = destination.renamedDestination;
  }
  job.error = undefined;
  job.resultMessage = undefined;
  job.sourceRemovalStatus = undefined;
  job.sourceRemovalError = undefined;
  job.bytesTransferred = 0;
  job.totalBytes = job.size;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.startedAt = undefined;
  job.finishedAt = undefined;

  if (job.direction === 'download' && !applyDownloadSpacePreflight(job, new Map())) {
    sendTransferEvent('failed', job);
    return cloneJob(job);
  }

  job.status = 'queued';
  sendTransferEvent('queued', job);
  processTransferQueue();
  return cloneJob(job);
}

function cancelTransfer(jobId: string): TransferJob | null {
  const job = transferJobs.get(jobId);
  if (!job || (job.status !== 'active' && job.status !== 'queued')) {
    return null;
  }

  if (job.status === 'queued') {
    job.status = 'canceled';
    job.finishedAt = Date.now();
    job.error = 'Transfer canceled.';
    sendTransferEvent('canceled', job);
    handlePromiseTransferTerminal(job);
    return cloneJob(job);
  }

  if (job.id === activeJobId) {
    activeWasCanceled = true;
    if (activeTransferUsesAdminSession) {
      destroyAdminMtpSession('Active protected transfer canceled.', true);
    } else {
      destroyMtpSession('Active transfer canceled.', true);
    }
    return cloneJob(job);
  }

  return null;
}

async function chooseDestination(): Promise<DestinationResult> {
  const options: OpenDialogOptions = {
    title: 'Choose Mac destination',
    properties: ['openDirectory', 'createDirectory']
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return { canceled: false, path: result.filePaths[0] };
}

function getDesktopDestination(): string {
  return app.getPath('desktop');
}

function nativeDragIcon() {
  const namedIcon = nativeImage.createFromNamedImage('NSMultipleDocuments');
  if (!namedIcon.isEmpty()) {
    return namedIcon;
  }

  const fallbackIcon = nativeImage.createFromNamedImage('NSActionTemplate');
  if (!fallbackIcon.isEmpty()) {
    return fallbackIcon;
  }

  const svg = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="24" height="28" x="4" y="2" rx="3" fill="#fdfbf4" stroke="#245d7a" stroke-width="2"/><path d="M10 12h12M10 18h12M10 24h8" stroke="#52634a" stroke-width="2" stroke-linecap="round"/></svg>'
  );
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
}

function startLocalFileDrag(event: Electron.IpcMainEvent, filePaths: string[]): void {
  const validPaths = filePaths.filter((filePath) => {
    try {
      const fileStat = statSync(filePath);
      return fileStat.isFile() || fileStat.isDirectory();
    } catch {
      return false;
    }
  });

  if (!validPaths.length) {
    appendLog('native drag skipped: no valid local files or folders were available');
    return;
  }

  try {
    event.sender.startDrag({
      file: validPaths[0],
      files: validPaths,
      icon: nativeDragIcon()
    });
    appendLog(`native drag started for ${validPaths.length} local path(s)`);
  } catch (error) {
    appendLog(`native drag failed: ${String(error)}`);
  }
}

function preservePromisedDirectories(directories: PromisedDirectory[]): void {
  [...directories]
    .sort((left, right) => right.path.length - left.path.length)
    .forEach((directory) => {
      if (!directory.modified || !existsSync(directory.path)) {
        return;
      }
      try {
        const stats = statSync(directory.path);
        utimesSync(directory.path, stats.atime, new Date(directory.modified * 1000));
      } catch (error) {
        appendLog(`warning: unable to preserve promised folder time ${directory.path}: ${String(error)}`);
      }
    });
}

function completePromiseFulfillment(promiseId: string): void {
  const fulfillment = promiseFulfillments.get(promiseId);
  if (!fulfillment || fulfillment.settled) {
    return;
  }
  fulfillment.settled = true;
  preservePromisedDirectories(fulfillment.directories);
  loadFilePromiseDragAddon()?.completePromise(promiseId);
  promiseFulfillments.delete(promiseId);
  promiseSources.delete(promiseId);
  appendLog(`file promise completed: ${fulfillment.rootPath}`);
}

function failPromiseFulfillment(promiseId: string, message: string): void {
  const fulfillment = promiseFulfillments.get(promiseId);
  if (fulfillment?.settled) {
    return;
  }
  if (fulfillment) {
    fulfillment.settled = true;
    for (const jobId of fulfillment.remainingJobIds) {
      const job = transferJobs.get(jobId);
      if (job?.status === 'queued' || job?.status === 'active') {
        cancelTransfer(jobId);
      }
    }
    try {
      rmSync(fulfillment.rootPath, {
        force: true,
        recursive: fulfillment.rootKind === 'folder'
      });
    } catch (error) {
      appendLog(`warning: unable to remove failed promised output ${fulfillment.rootPath}: ${String(error)}`);
    }
  }
  loadFilePromiseDragAddon()?.completePromise(promiseId, message);
  promiseFulfillments.delete(promiseId);
  promiseSources.delete(promiseId);
  sendPhoneFilePromiseDragEvent({ type: 'failed', promiseId, message: `${message} Drag again.` });
  appendLog(`file promise failed: ${promiseId}: ${message}`);
}

function handlePromiseTransferTerminal(job: TransferJob): void {
  if (!job.promiseId) {
    return;
  }
  const fulfillment = promiseFulfillments.get(job.promiseId);
  if (!fulfillment || fulfillment.settled || !fulfillment.remainingJobIds.has(job.id)) {
    return;
  }
  fulfillment.remainingJobIds.delete(job.id);
  if (job.status === 'failed' || job.status === 'canceled') {
    failPromiseFulfillment(job.promiseId, job.error || 'The promised file could not be copied.');
    return;
  }
  if (job.status === 'completed' && fulfillment.remainingJobIds.size === 0) {
    completePromiseFulfillment(job.promiseId);
  }
}

async function waitForPromisePlanningSlot(): Promise<void> {
  pendingPromisePlanningCount += 1;
  while (activeJobId !== null || activeSessionCommand !== null || adminSession?.activeCommand) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function releasePromisePlanningSlot(): void {
  pendingPromisePlanningCount = Math.max(0, pendingPromisePlanningCount - 1);
  processTransferQueue();
}

async function planPromisedPhoneItem(
  source: PhoneFilePromiseDragItem,
  rootPath: string,
  promiseId: string
): Promise<{ files: PromisedDownloadFile[]; directories: PromisedDirectory[] }> {
  if (source.kind === 'file') {
    return {
      files: [
        {
          request: {
            deviceIndex: source.deviceIndex,
            deviceConnectionId: source.deviceConnectionId,
            storageId: source.storageId,
            parentId: source.parentId,
            objectId: source.objectId,
            name: source.name,
            size: source.size,
            modified: source.modified,
            destinationDirectory: dirname(rootPath),
            operation: 'copy'
          },
          destinationPath: rootPath
        }
      ],
      directories: []
    };
  }

  const files: PromisedDownloadFile[] = [];
  const directories: PromisedDirectory[] = [{ path: rootPath, modified: source.modified }];
  let folderCount = 1;

  async function collectFolder(
    storageId: number,
    parentId: number,
    destinationDirectory: string,
    currentName: string
  ): Promise<void> {
    sendPhoneFilePromiseDragEvent({
      type: 'planning',
      promiseId,
      files: files.length,
      folders: folderCount,
      currentName
    });
    const result = await listFolder(
      source.deviceIndex,
      source.deviceConnectionId,
      storageId,
      parentId
    );
    if (!result.ok) {
      throw new Error(result.message || `Unable to list ${currentName}.`);
    }
    for (const object of result.objects) {
      if (files.length >= MAX_PROMISED_PHONE_FILES) {
        throw new Error(`This folder contains more than ${MAX_PROMISED_PHONE_FILES} files. Copy a smaller folder.`);
      }
      const childPath = join(destinationDirectory, sanitizeFileName(object.name));
      if (!pathIsInside(rootPath, childPath)) {
        throw new Error('A phone item produced an invalid destination path.');
      }
      if (object.kind === 'folder') {
        folderCount += 1;
        if (folderCount > MAX_PROMISED_PHONE_FOLDERS) {
          throw new Error(`This selection contains more than ${MAX_PROMISED_PHONE_FOLDERS} folders.`);
        }
        directories.push({ path: childPath, modified: object.modified });
        await collectFolder(object.storageId, object.id, childPath, object.name);
      } else {
        files.push({
          request: {
            deviceIndex: source.deviceIndex,
            deviceConnectionId: source.deviceConnectionId,
            storageId: object.storageId,
            parentId: object.parentId,
            objectId: object.id,
            name: object.name,
            size: object.size,
            modified: object.modified,
            destinationDirectory,
            operation: 'copy'
          },
          destinationPath: childPath
        });
      }
    }
  }

  await waitForPromisePlanningSlot();
  try {
    await collectFolder(source.storageId, source.objectId, rootPath, source.name);
  } finally {
    releasePromisePlanningSlot();
  }
  return { files, directories };
}

async function fulfillPhoneFilePromise(promiseId: string, destinationPath: string): Promise<void> {
  const source = promiseSources.get(promiseId)?.item;
  if (!source) {
    loadFilePromiseDragAddon()?.completePromise(promiseId, 'The dragged phone item is no longer available.');
    sendPhoneFilePromiseDragEvent({
      type: 'failed',
      promiseId,
      message: 'The dragged phone item is no longer available. Drag again.'
    });
    appendLog(`file promise rejected before fulfillment: ${promiseId}: source unavailable`);
    return;
  }
  const resolvedDestination = resolve(destinationPath);
  if (resolvedDestination !== destinationPath || existsSync(resolvedDestination)) {
    const message = existsSync(resolvedDestination)
      ? `The destination already contains ${basename(resolvedDestination)}.`
      : 'The receiving app supplied an invalid destination.';
    loadFilePromiseDragAddon()?.completePromise(promiseId, message);
    promiseSources.delete(promiseId);
    sendPhoneFilePromiseDragEvent({ type: 'failed', promiseId, message: `${message} Drag again.` });
    appendLog(`file promise rejected before fulfillment: ${promiseId}: ${message}`);
    return;
  }

  appendLog(`file promise accepted: ${source.name} -> ${resolvedDestination}`);

  sendPhoneFilePromiseDragEvent({
    type: 'accepted',
    message: `Dropped in ${dirname(resolvedDestination)}. Copying from the phone now.`
  });

  try {
    const plan = await planPromisedPhoneItem(source, resolvedDestination, promiseId);
    for (const directory of plan.directories) {
      if (!pathIsInside(resolvedDestination, directory.path)) {
        throw new Error('A promised folder path escaped its destination.');
      }
      mkdirSync(directory.path, { recursive: true });
    }
    const fulfillment: PromiseFulfillment = {
      id: promiseId,
      rootPath: resolvedDestination,
      rootKind: source.kind,
      directories: plan.directories,
      remainingJobIds: new Set(),
      settled: false
    };
    promiseFulfillments.set(promiseId, fulfillment);
    if (!plan.files.length) {
      completePromiseFulfillment(promiseId);
      return;
    }

    const jobs = enqueuePromisedDownloads(plan.files, promiseId);
    jobs.forEach((job) => fulfillment.remainingJobIds.add(job.id));
    const failed = jobs.find((job) => job.status === 'failed' || job.status === 'canceled');
    if (failed) {
      failPromiseFulfillment(promiseId, failed.error || 'The promised file could not be queued.');
      return;
    }
    if (fulfillment.remainingJobIds.size === 0) {
      completePromiseFulfillment(promiseId);
      return;
    }
    processTransferQueue();
  } catch (error) {
    failPromiseFulfillment(
      promiseId,
      error instanceof Error ? error.message : 'The promised file could not be prepared.'
    );
  }
}

function startPhoneFilePromiseDrag(request: PhoneFilePromiseDragRequest): void {
  const addon = loadFilePromiseDragAddon();
  if (!addon || !mainWindow || mainWindow.isDestroyed()) {
    sendPhoneFilePromiseDragEvent({
      type: 'failed',
      message: 'Dragging phone files is unavailable. Use Copy to Mac.'
    });
    return;
  }
  const items = request.items.filter(
    (item) =>
      Number.isInteger(item.deviceIndex) &&
      item.deviceConnectionId.trim() &&
      Number.isInteger(item.storageId) &&
      Number.isInteger(item.objectId) &&
      (item.kind === 'file' || item.kind === 'folder')
  );
  if (!items.length || items.length > 1_000) {
    sendPhoneFilePromiseDragEvent({
      type: 'failed',
      message: items.length ? 'Drag fewer than 1,000 items at once.' : 'No phone files were available to drag.'
    });
    return;
  }
  const connectionId = items[0].deviceConnectionId;
  if (items.some((item) => item.deviceConnectionId !== connectionId)) {
    sendPhoneFilePromiseDragEvent({ type: 'failed', message: 'Drag files from one phone at a time.' });
    return;
  }

  const nativeItems = items.map((item) => {
    const promiseId = randomUUID();
    promiseSources.set(promiseId, { id: promiseId, item });
    return {
      promiseId,
      name: sanitizeFileName(item.name),
      kind: item.kind
    };
  });

  try {
    const started = addon.startDrag(
      {
        viewHandle: mainWindow.getNativeWindowHandle(),
        items: nativeItems,
        internalDestination: request.internalDestination
      },
      (event) => {
        if (event.type === 'write' && event.promiseId && event.path) {
          void fulfillPhoneFilePromise(event.promiseId, event.path);
        } else if (event.type === 'internal-hover') {
          sendPhoneFilePromiseDragEvent({ type: 'internal-hover', active: event.active === true });
        } else if (event.type === 'drag-ended' && !event.operation) {
          nativeItems.forEach(({ promiseId }) => {
            if (!promiseFulfillments.has(promiseId)) {
              addon.completePromise(promiseId, 'Drag canceled.');
              promiseSources.delete(promiseId);
            }
          });
          appendLog(`file promise drag canceled for ${nativeItems.length} phone item(s)`);
          sendPhoneFilePromiseDragEvent({ type: 'canceled', message: 'Drag canceled. Nothing was copied.' });
        } else if (event.type === 'drag-ended') {
          appendLog(`file promise drag accepted with operation ${event.operation}`);
        }
      }
    );
    if (!started) {
      nativeItems.forEach(({ promiseId }) => {
        addon.completePromise(promiseId, 'The native drag session did not start.');
        promiseSources.delete(promiseId);
      });
      throw new Error('The native drag session did not start.');
    }
    appendLog(`file promise drag started for ${nativeItems.length} phone item(s)`);
    sendPhoneFilePromiseDragEvent({
      type: 'started',
      message: 'Drag to Finder, Desktop, another app, or the Mac pane.'
    });
  } catch (error) {
    nativeItems.forEach(({ promiseId }) => {
      addon.completePromise(promiseId, 'Dragging could not start.');
      promiseSources.delete(promiseId);
    });
    sendPhoneFilePromiseDragEvent({
      type: 'failed',
      message: `${error instanceof Error ? error.message : 'Dragging could not start.'} Use Copy to Mac.`
    });
  }
}

function runAppleScript(script: string, timeoutMs: number): Promise<{
  stdout: string;
  stderr: string;
  error: Error | null;
}> {
  return new Promise((resolvePromise) => {
    execFile(
      'osascript',
      ['-e', script],
      { maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolvePromise({
          stdout,
          stderr,
          error: error ?? null
        });
      }
    );
  });
}

function adminSessionStartMessage(result: {
  stdout: string;
  stderr: string;
  error: Error | null;
}): string {
  const combined = `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`.toLowerCase();
  const execError = result.error as
    | (Error & { killed?: boolean; signal?: NodeJS.Signals | string | null; code?: string | number | null })
    | null;

  if (combined.includes('user canceled') || combined.includes('-128')) {
    return 'Open files was canceled. Nothing was changed.';
  }

  if (
    execError?.killed ||
    execError?.signal === 'SIGTERM' ||
    execError?.code === 'ETIMEDOUT' ||
    combined.includes('timed out') ||
    combined.includes('etimedout') ||
    combined.includes('signal sigterm')
  ) {
    return 'The Mac password prompt timed out. Click Open files again when you are ready to enter your Mac login password.';
  }

  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    'macOS did not explain why the protected session could not start.';
  return `macOS did not start protected phone-file access. ${detail}`;
}

function adminPrompt(rawDevice: RawDevice): string {
  return [
    `Android File Transfer for macOS needs your Mac login password because macOS refused normal USB access to ${rawDevice.vendor || rawDevice.product || 'your phone'}.`,
    'The password lets macOS open the USB connection once; the file helper then immediately returns to your normal account permissions.',
    'The app reads and copies only the items you choose. It deletes a source file only when you explicitly choose Move, and only after the destination copy is verified.'
  ].join(' ');
}

function appendAdminSessionText(session: AdminSessionState, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  appendLog(`admin session output: ${trimmed}`);
  session.stderrBuffer = `${session.stderrBuffer}\n${trimmed}`.trim();
  if (session.stderrBuffer.length > 20_000) {
    session.stderrBuffer = session.stderrBuffer.slice(-20_000);
  }
}

function rejectAdminSessionCommands(session: AdminSessionState, error: Error): void {
  if (session.activeCommand) {
    if (session.activeCommand.timer) {
      clearTimeout(session.activeCommand.timer);
    }
    session.activeCommand.reject(error);
    session.activeCommand = null;
  }

  while (session.queue.length > 0) {
    const command = session.queue.shift();
    command?.reject(error);
  }
}

function clearAdminReady(session: AdminSessionState, error?: Error): void {
  if (session.readyTimer) {
    clearTimeout(session.readyTimer);
    session.readyTimer = null;
  }

  if (error && session.readyReject) {
    session.readyReject(error);
  }

  session.readyResolve = null;
  session.readyReject = null;
}

function finishAdminSessionCommand(session: AdminSessionState, payload: SessionPayload): void {
  const command = session.activeCommand;
  if (!command) {
    appendLog(`admin session response without active command: ${JSON.stringify(payload)}`);
    return;
  }

  if (payload.requestId !== command.id) {
    appendLog(`admin session response id mismatch: ${JSON.stringify(payload)}`);
    return;
  }

  clearCommandTimer(command);
  session.activeCommand = null;
  command.resolve(payload);
  pumpAdminSessionQueue(session);
  processTransferQueue();
}

function handleAdminSessionPayload(session: AdminSessionState, payload: SessionPayload): void {
  if (payload.type === 'ready') {
    if (payload.ok) {
      if (!readyPayloadMatchesConnection(payload, session.connectionId, session.rawKey)) {
        destroyAdminMtpSession(
          'The protected helper opened a different phone connection than the one requested.',
          true
        );
        return;
      }
      session.isReady = true;
      if (session.readyTimer) {
        clearTimeout(session.readyTimer);
        session.readyTimer = null;
      }
      const resolveReady = session.readyResolve;
      session.readyResolve = null;
      session.readyReject = null;
      resolveReady?.();
      appendLog(payload.message || 'admin MTP session opened');
    } else {
      destroyAdminMtpSession(payload.message || 'Unable to open the admin MTP session.');
    }
    return;
  }

  if (
    (payload.type === 'download' || payload.type === 'upload' || payload.type === 'list') &&
    session.activeCommand
  ) {
    const command = session.activeCommand;
    if (payload.requestId === command.id) {
      command.onEvent?.(payload);
      if (payload.event === 'progress') {
        armCommandTimer(command, () => {
          destroyAdminMtpSession(`Admin MTP command timed out after ${command.timeoutMs}ms.`, true);
        });
      }
      return;
    }
  }

  if (payload.type === 'response') {
    finishAdminSessionCommand(session, payload);
    return;
  }

  if (payload.type !== 'bye') {
    appendLog(`admin session payload ignored: ${JSON.stringify(payload)}`);
  }
}

function pollAdminSessionOutput(session: AdminSessionState): void {
  if (adminSession !== session) {
    return;
  }

  let fileDescriptor: number | null = null;
  let chunk: Buffer;
  try {
    fileDescriptor = openSync(session.outputPath, 'r');
    const size = fstatSync(fileDescriptor).size;
    if (size <= session.outputOffset) {
      closeSync(fileDescriptor);
      return;
    }
    const bytesToRead = Math.min(size - session.outputOffset, 4 * 1024 * 1024);
    chunk = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(
      fileDescriptor,
      chunk,
      0,
      bytesToRead,
      session.outputOffset
    );
    chunk = chunk.subarray(0, bytesRead);
    session.outputOffset += bytesRead;
    closeSync(fileDescriptor);
    fileDescriptor = null;
  } catch {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    return;
  }

  if (!chunk.length) {
    return;
  }

  session.outputBuffer += chunk.toString('utf8');
  const lines = session.outputBuffer.split('\n');
  session.outputBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const exitMatch = trimmed.match(/^__MTP_ADMIN_SESSION_EXIT:(\d+)$/);
    if (exitMatch) {
      destroyAdminMtpSession(`Admin MTP session exited with code ${exitMatch[1]}.`);
      return;
    }
    if (!trimmed.startsWith('{')) {
      appendAdminSessionText(session, trimmed);
      continue;
    }

    try {
      handleAdminSessionPayload(session, JSON.parse(trimmed) as SessionPayload);
    } catch (error) {
      appendLog(`admin session JSON parse failed: ${String(error)} line=${trimmed}`);
    }
  }
}

function pumpAdminSessionQueue(session: AdminSessionState): void {
  if (session.activeCommand || !session.input || session.input.destroyed) {
    return;
  }

  const command = session.queue.shift();
  if (!command) {
    return;
  }

  session.activeCommand = command;
  armCommandTimer(command, () => {
    destroyAdminMtpSession(`Admin MTP command timed out after ${command.timeoutMs}ms.`, true);
  });
  session.input.write(command.line);
}

function detachAdminMtpSessionForRelaunch(reason: string): boolean {
  const session = adminSession;
  if (!session || !session.isReady || session.activeCommand || session.queue.length > 0 || activeJobId !== null) {
    return false;
  }

  const expiresAt = Date.now() + ADMIN_SESSION_RECONNECT_TTL_MS;
  try {
    writeFileSync(session.expirePath, `${Math.floor(expiresAt / 1000)}\n`, 'utf8');
    chmodSync(session.expirePath, 0o600);
    writeAdminSessionManifest(session, expiresAt);
  } catch (error) {
    appendLog(`unable to detach protected MTP session for relaunch: ${error instanceof Error ? error.message : String(error)}`);
    removeAdminSessionManifest();
    return false;
  }

  appendLog(`admin mtp session detached for relaunch: ${reason}`);
  adminSession = null;
  if (session.readyTimer) {
    clearTimeout(session.readyTimer);
  }
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
  }
  clearAdminReady(session);
  rejectAdminSessionCommands(session, new Error(reason));
  if (session.input && !session.input.destroyed) {
    session.input.end();
  }
  return true;
}

function destroyAdminMtpSession(reason: string, forceProcessStop = false): void {
  const session = adminSession;
  if (!session) {
    removeAdminSessionManifest();
    return;
  }

  appendLog(`admin mtp session closing: ${reason}`);
  removeAdminSessionManifest();
  adminSession = null;
  if (!sessionProcess) {
    rawDevicesMissingSince = null;
  }

  if (session.readyTimer) {
    clearTimeout(session.readyTimer);
  }
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
  }
  clearAdminReady(session, new Error(reason));
  rejectAdminSessionCommands(session, new Error(reason));

  if (session.input && !session.input.destroyed) {
    session.input.write('quit\n');
    session.input.end();
  }

  if (forceProcessStop) {
    stopAdminSessionProcess(session, reason);
  }

  // The root-owned runner removes its private runtime directory after the helper exits.
}

async function startAdminMtpSession(deviceIndex: number, rawDevice: RawDevice): Promise<void> {
  deviceIndex = rawDevice.index;
  const helperPath = await ensureBridge();
  const rawKey = rawDeviceKey(rawDevice);
  const connectionId = rawDeviceConnectionId(rawDevice);
  const deviceIdentityKey = rawDeviceIdentityKey(rawDevice);
  const usbSessionId = rawDeviceUsbSessionId(rawDevice);

  if (
    adminSession &&
    adminSession.connectionId === connectionId
  ) {
    adminSession.deviceIndex = rawDevice.index;
    adminSession.rawKey = rawKey;
    await adminSession.ready;
    return;
  }

  if (await attachDetachedAdminMtpSession(deviceIndex, rawDevice)) {
    await adminSession?.ready;
    return;
  }

  if (adminSession) {
    destroyAdminMtpSession('Restarting admin MTP session for selected device.');
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), 'androidFileTransferForMacOS-admin-session-'));
  const stagedBinDir = join(stagingRoot, 'resources', 'bin');
  const stagedLibDir = join(stagingRoot, 'resources', 'lib');
  const stagedHelper = join(stagedBinDir, 'mtp-json');
  const stagedRunner = join(stagingRoot, 'run-session.sh');

  mkdirSync(stagedBinDir, { recursive: true });
  mkdirSync(stagedLibDir, { recursive: true });
  copyFileSync(helperPath, stagedHelper);
  const helperLibDir = resolve(dirname(helperPath), '..', 'lib');
  if (existsSync(helperLibDir)) {
    cpSync(helperLibDir, stagedLibDir, { recursive: true });
  } else {
    appendLog(`admin mtp session library directory missing: ${helperLibDir}`);
  }
  chmodSync(stagedHelper, 0o755);
  writeFileSync(
    stagedRunner,
    `#!/bin/sh
set -u
helper="$1"
device_index="$2"
input_path="$3"
output_path="$4"
stop_path="$5"
expire_path="$6"
root_stage="$7"
owner_uid="$8"
owner_gid="$9"
child_pid=""
open_ready_seen=0

cleanup_root_stage() {
  sleep 5
  rm -rf "$root_stage"
}

ready_seen() {
  grep -q '"type":"ready","ok":true' "$output_path" 2>/dev/null
}

kill_child() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$child_pid" 2>/dev/null || true
  fi
}

term_handler() {
  trap - TERM INT HUP
  kill_child
  printf "\\n__MTP_ADMIN_SESSION_EXIT:143\\n" >> "$output_path"
  exit 143
}

trap term_handler TERM INT HUP
trap cleanup_root_stage EXIT
exec 3<>"$input_path"

attempt=1
while [ "$attempt" -le ${ADMIN_MTP_OPEN_MAX_ATTEMPTS} ]; do
  if [ "$attempt" -gt 1 ]; then
    printf "\\n__MTP_ADMIN_OPEN_RETRY:%s\\n" "$attempt" >> "$output_path"
    sleep 2
  fi

  open_ready_seen=0
  /usr/bin/env -i \
    HOME=/var/empty \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    MAC_ANDROID_TRANSFER_ADMIN_RETRY_READY=1 \
    MAC_ANDROID_TRANSFER_REQUIRE_PRIVILEGE_DROP=1 \
    MAC_ANDROID_TRANSFER_OWNER_UID="$owner_uid" \
    MAC_ANDROID_TRANSFER_OWNER_GID="$owner_gid" \
    "$helper" session "$device_index" < "$input_path" >> "$output_path" 2>&1 &
  child_pid="$!"
  attempt_started_at="$(date +%s)"

  while kill -0 "$child_pid" 2>/dev/null; do
    now="$(date +%s)"
    if [ "$open_ready_seen" -eq 0 ] && ready_seen; then
      open_ready_seen=1
    fi

    if [ -s "$stop_path" ]; then
      kill_child
      wait "$child_pid" 2>/dev/null || true
      code=143
      printf "\\n__MTP_ADMIN_SESSION_EXIT:%s\\n" "$code" >> "$output_path"
      exit "$code"
    fi

    if [ -s "$expire_path" ]; then
      expire_at="$(cat "$expire_path" 2>/dev/null || echo 0)"
      case "$expire_at" in
        ''|*[!0-9]*) expire_at=0 ;;
      esac
      if [ "$expire_at" -gt 0 ] && [ "$now" -ge "$expire_at" ]; then
        kill_child
        wait "$child_pid" 2>/dev/null || true
        code=143
        printf "\\n__MTP_ADMIN_SESSION_EXIT:%s\\n" "$code" >> "$output_path"
        exit "$code"
      fi
    fi

    if [ "$open_ready_seen" -eq 0 ] && [ $((now - attempt_started_at)) -ge ${ADMIN_MTP_OPEN_ATTEMPT_TIMEOUT_SECONDS} ]; then
      printf "\\n__MTP_ADMIN_OPEN_ATTEMPT_TIMEOUT:%s\\n" "$attempt" >> "$output_path"
      kill_child
      break
    fi

    sleep 1
  done

  wait "$child_pid" 2>/dev/null
  code="$?"
  child_pid=""

  if [ "$open_ready_seen" -eq 1 ] || [ "$code" -eq 0 ]; then
    printf "\\n__MTP_ADMIN_SESSION_EXIT:%s\\n" "$code" >> "$output_path"
    exit "$code"
  fi

  if [ "$attempt" -ge ${ADMIN_MTP_OPEN_MAX_ATTEMPTS} ]; then
    printf '{"type":"ready","ok":false,"state":"connect-error","message":"Phone USB was detected in File Transfer mode, but the MTP file session did not open. The OpenSession step failed after USB reset attempts, so this app never received the phone folder list. Keep the phone unlocked, tap Allow if asked, then switch USB mode away from File Transfer and back before trying Open files again."}\\n' >> "$output_path"
    printf "\\n__MTP_ADMIN_SESSION_EXIT:%s\\n" "$code" >> "$output_path"
    exit "$code"
  fi

  attempt=$((attempt + 1))
done
printf "\\n__MTP_ADMIN_SESSION_EXIT:1\\n" >> "$output_path"
exit 1
`,
    'utf8'
  );
  chmodSync(stagedRunner, 0o755);

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const privilegedStageRoot = `/private/var/tmp/androidFileTransferForMacOS-protected-${randomUUID()}`;
  const privilegedBinDir = join(privilegedStageRoot, 'resources', 'bin');
  const privilegedLibDir = join(privilegedStageRoot, 'resources', 'lib');
  const privilegedIpcDir = join(privilegedStageRoot, 'ipc');
  const privilegedHelper = join(privilegedBinDir, 'mtp-json');
  const privilegedRunner = join(privilegedStageRoot, 'run-session.sh');
  const inputPath = join(privilegedIpcDir, 'stdin.fifo');
  const outputPath = join(privilegedIpcDir, 'stdout.log');
  const pidPath = join(privilegedIpcDir, 'session.pid');
  const stopPath = join(privilegedIpcDir, 'stop-requested');
  const expirePath = join(privilegedIpcDir, 'session-expire-at');
  const stagedLibraries = readdirSync(stagedLibDir)
    .filter((name) => name.endsWith('.dylib'))
    .map((name) => ({
      source: join(stagedLibDir, name),
      target: join(privilegedLibDir, name)
    }));
  const privilegedFiles = [
    { source: stagedHelper, target: privilegedHelper, mode: '755' },
    ...stagedLibraries.map((library) => ({ ...library, mode: '755' })),
    { source: stagedRunner, target: privilegedRunner, mode: '700' }
  ];
  const installAndVerifyCommands = privilegedFiles.flatMap((file) => {
    const expectedHash = sha256File(file.source);
    return [
      `/usr/bin/install -o root -g wheel -m ${file.mode} ${shellQuote(file.source)} ${shellQuote(file.target)}`,
      `test "$(/usr/bin/shasum -a 256 ${shellQuote(file.target)} | /usr/bin/awk '{print $1}')" = ${shellQuote(expectedHash)}`
    ];
  });
  const shellCommand = [
    'set -e',
    `trap ${shellQuote(`/bin/rm -rf ${privilegedStageRoot}`)} 0 1 2 15`,
    `/bin/rm -rf ${shellQuote(privilegedStageRoot)}`,
    `/bin/mkdir -p ${shellQuote(privilegedBinDir)} ${shellQuote(privilegedLibDir)} ${shellQuote(privilegedIpcDir)}`,
    `/bin/chmod 711 ${shellQuote(privilegedStageRoot)} ${shellQuote(privilegedIpcDir)}`,
    `/bin/chmod 700 ${shellQuote(join(privilegedStageRoot, 'resources'))} ${shellQuote(privilegedBinDir)} ${shellQuote(privilegedLibDir)}`,
    ...installAndVerifyCommands,
    `/usr/bin/mkfifo ${shellQuote(inputPath)}`,
    `/usr/bin/touch ${shellQuote(outputPath)} ${shellQuote(pidPath)} ${shellQuote(stopPath)} ${shellQuote(expirePath)}`,
    `/usr/sbin/chown ${uid}:${gid} ${shellQuote(inputPath)} ${shellQuote(outputPath)} ${shellQuote(pidPath)} ${shellQuote(stopPath)} ${shellQuote(expirePath)}`,
    `/bin/chmod 600 ${shellQuote(inputPath)} ${shellQuote(outputPath)} ${shellQuote(pidPath)} ${shellQuote(stopPath)} ${shellQuote(expirePath)}`,
    `${shellQuote(privilegedRunner)} ${shellQuote(privilegedHelper)} ${shellQuote(String(deviceIndex))} ${shellQuote(inputPath)} ${shellQuote(outputPath)} ${shellQuote(stopPath)} ${shellQuote(expirePath)} ${shellQuote(privilegedStageRoot)} ${shellQuote(String(uid))} ${shellQuote(String(gid))} >/dev/null 2>&1 & printf "%s\\n" "$!" > ${shellQuote(pidPath)}`,
    'trap - 0 1 2 15',
    'exit 0'
  ].join('; ');

  appendLog(`admin mtp session starting for raw device ${rawKey} (${rawDevice.vendor} ${rawDevice.product})`);
  const result = await runAppleScript(
    `do shell script ${appleScriptString(shellCommand)} with administrator privileges with prompt ${appleScriptString(adminPrompt(rawDevice))}`,
    180_000
  );

  if (result.error) {
    const message = adminSessionStartMessage(result);
    appendLog(`admin mtp session did not start: ${message}`);
    rmSync(stagingRoot, { recursive: true, force: true });
    throw new Error(message);
  }

  rmSync(stagingRoot, { recursive: true, force: true });

  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const session: AdminSessionState = {
    deviceIndex,
    connectionId,
    rawKey,
    deviceIdentityKey,
    usbSessionId,
    stageRoot: privilegedStageRoot,
    stagedHelper: privilegedHelper,
    runnerPath: privilegedRunner,
    inputPath,
    outputPath,
    pidPath,
    stopPath,
    expirePath,
    processPid: readPidFile(pidPath),
    input: null,
    outputOffset: 0,
    outputBuffer: '',
    stderrBuffer: '',
    isReady: false,
    ready,
    readyResolve,
    readyReject,
    readyTimer: null,
    pollTimer: null,
    activeCommand: null,
    queue: []
  };

  adminSession = session;
  session.pollTimer = setInterval(() => pollAdminSessionOutput(session), 100);
  session.readyTimer = setTimeout(() => {
    destroyAdminMtpSession(`Admin MTP session open timed out after ${ADMIN_MTP_SESSION_OPEN_TIMEOUT_MS}ms.`, true);
  }, ADMIN_MTP_SESSION_OPEN_TIMEOUT_MS);

  session.input = createWriteStream(inputPath, { flags: 'w' });
  session.input.on('error', (error) => {
    if (adminSession === session) {
      destroyAdminMtpSession(`Admin MTP input error: ${error.message}`, true);
    }
  });

  try {
    await session.ready;
  } catch (error) {
    if (adminSession === session) {
      destroyAdminMtpSession(error instanceof Error ? error.message : String(error), true);
    }
    throw error;
  }
}

async function adminFallbackIsAvailable(
  deviceIndex: number,
  expectedConnectionId?: string
): Promise<boolean> {
  if (
    adminSession &&
    (!expectedConnectionId || adminSession.connectionId === expectedConnectionId)
  ) {
    const visibleDevice = expectedConnectionId
      ? rawDeviceForConnection(deviceIndex, expectedConnectionId)
      : rawDeviceForConnection(deviceIndex);
    if (visibleDevice) {
      adminSession.deviceIndex = visibleDevice.index;
      adminSession.rawKey = rawDeviceKey(visibleDevice);
    }
    await adminSession.ready;
    return true;
  }

  if (lastRawDevices.length === 0) {
    await refreshRawDevices();
  }

  const rawDevice = rawDeviceForConnection(deviceIndex, expectedConnectionId);
  if (rawDevice && (await attachDetachedAdminMtpSession(deviceIndex, rawDevice))) {
    await adminSession?.ready;
    return true;
  }

  return false;
}

async function runAdminSessionCommand<T extends SessionPayload>(
  deviceIndex: number,
  deviceConnectionId: string,
  commandName: string,
  args: string[],
  timeoutMs: number,
  onEvent?: (payload: SessionPayload) => void
): Promise<T> {
  if (lastRawDevices.length === 0) {
    await refreshRawDevices();
  }
  const rawDevice = rawDeviceForConnection(deviceIndex, deviceConnectionId);
  if (!rawDevice) {
    throw new Error('No raw MTP device is available for the admin session.');
  }

  await startAdminMtpSession(rawDevice.index, rawDevice);
  const session = adminSession;
  if (!session) {
    throw new Error('Admin MTP session was not available after startup.');
  }

  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error('MTP command arguments cannot contain newlines.');
  }

  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const line = [commandName, id, ...args].join(' ') + '\n';
    session.queue.push({
      id,
      name: commandName,
      line,
      timeoutMs,
      resolve: (payload) => resolve(payload as T),
      reject,
      onEvent
    });
    pumpAdminSessionQueue(session);
  });
}

async function confirmAdminRecovery(rawDevice: RawDevice): Promise<boolean> {
  const detail = [
    `Android File Transfer for macOS can see ${rawDevice.vendor || rawDevice.product || 'your phone'}, but macOS blocked the normal USB file connection.`,
    'To open the files, the app needs to start one protected phone-file session.',
    'Choose Continue, then enter the same password you use to unlock this Mac.',
    'The next macOS password window may say "osascript wants to make changes." That is the macOS password prompt for this protected file session.',
    'Choose Cancel if you did not ask to open phone files.',
    'Opening files does not delete, move, or change anything. A source file is deleted only if you later choose Move and its destination copy is verified.'
  ].join('\n\n');

  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Continue', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Why macOS asks for your password',
        message: 'Why macOS asks for your password',
        detail
      })
    : await dialog.showMessageBox({
        type: 'question',
        buttons: ['Continue', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Why macOS asks for your password',
        message: 'Why macOS asks for your password',
        detail
      });

  return result.response === 0;
}

async function recoverWithAdmin(): Promise<AdminRecoveryResult> {
  const logPath = getLogPath();
  const helperPath = getBridgePath();

  try {
    await ensureBridge();
  } catch (error) {
    const missing = missingBridgeStatus(error);
    return {
      ok: false,
      state: missing.state,
      message: missing.message,
      helperPath,
      logPath,
      stderr: missing.stderr
    };
  }

  const status = await getStatus();
  const rawDevice = status.rawDevices[0];
  const rawMtpDeviceVisible = rawDevice?.connectionMode === 'mtp';
  if (!rawDevice || (status.state !== 'connected' && !rawMtpDeviceVisible)) {
    return {
      ok: false,
      state: status.state,
      message: 'Open files was not started because no MTP phone is visible.',
      helperPath,
      logPath,
      stderr: status.stderr
    };
  }

  if (sessionProcess) {
    destroyMtpSession('Starting protected MTP session.');
  }

  try {
    const reattached = await attachDetachedAdminMtpSession(rawDevice.index, rawDevice);
    if (!reattached) {
      const confirmed = await confirmAdminRecovery(rawDevice);
      if (!confirmed) {
        return {
          ok: false,
          state: 'connected',
          message: 'Open files was canceled. Nothing was changed.',
          helperPath,
          logPath,
          rawDevice
        };
      }
    }

    await startAdminMtpSession(rawDevice.index, rawDevice);
    const inventory = await runAdminSessionCommand<InventoryResult & SessionPayload>(
      rawDevice.index,
      rawDeviceConnectionId(rawDevice),
      'inventory',
      [],
      60_000
    );

    if (!inventory.ok) {
      return {
        ok: false,
        state: inventory.state,
        message:
          inventory.message ||
          'Open files started, but the phone still did not return its storage list.',
        helperPath,
        logPath,
        stderr: adminSession?.stderrBuffer || undefined,
        rawDevice
      };
    }

    lastSessionStderr = '';

    return {
      ok: true,
      state: 'connected',
      message: reattached
        ? 'Reconnected to the open phone-file session. You can browse and copy files now.'
        : 'Phone files are open. You can browse and copy files now.',
      helperPath,
      logPath,
      inventory: {
        ok: true,
        state: 'connected',
        message: inventory.message || 'Inventory scan completed.',
        devices: inventory.devices.map((device) => ({
          ...device,
          index: rawDevice.index,
          connectionId: rawDeviceConnectionId(rawDevice),
          protectedAccess: true
        })),
        helperPath,
        logPath,
        protectedAccess: true,
        stderr: adminSession?.stderrBuffer || undefined
      },
      rawDevice
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`admin recovery failed: ${message}`);
    const canceled = message.toLowerCase().includes('was canceled');
    return {
      ok: false,
      state: canceled ? 'connected' : 'connect-error',
      message:
        message.startsWith('Open files') || message.startsWith('The Mac password prompt timed out')
          ? message
          : `Open files failed. ${message}`,
      helperPath,
      logPath,
      stderr: adminSession?.stderrBuffer || undefined,
      rawDevice
    };
  }
}

function getPrimaryWindowBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1220, Math.max(980, workArea.width - 96));
  const height = Math.min(780, Math.max(620, workArea.height - 96));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  };
}

function logDisplayLayout(): void {
  const displays = screen
    .getAllDisplays()
    .map((display) => {
      const bounds = display.bounds;
      const workArea = display.workArea;
      return `${display.id}:${bounds.x},${bounds.y},${bounds.width}x${bounds.height}:work=${workArea.x},${workArea.y},${workArea.width}x${workArea.height}`;
    })
    .join(' | ');
  appendLog(`display layout: ${displays}`);
}

function centerMainWindowOnPrimaryDisplay(reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const bounds = getPrimaryWindowBounds();
  mainWindow.setBounds(bounds, false);
  appendLog(`main window centered on primary display (${reason}): ${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`);
}

function createWindow(): void {
  logDisplayLayout();
  const initialBounds = getPrimaryWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 980,
    minHeight: 620,
    title: 'Android File Transfer for macOS',
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f6f1',
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  appendLog('main window created');

  mainWindow.once('ready-to-show', () => {
    appendLog('main window ready to show');
    centerMainWindowOnPrimaryDisplay('ready-to-show');
    mainWindow?.show();
    mainWindow?.focus();
  });
  const createdWindow = mainWindow;
  setTimeout(() => {
    if (mainWindow === createdWindow && !createdWindow.isDestroyed() && !createdWindow.isVisible()) {
      appendLog('main window fallback show');
      centerMainWindowOnPrimaryDisplay('fallback-show');
      createdWindow.show();
      createdWindow.focus();
    }
  }, 2500);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch((error) => {
      appendLog(`main window loadURL failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else {
    mainWindow.loadFile(join(currentDir, '../renderer/index.html')).catch((error) => {
      appendLog(`main window loadFile failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  centerMainWindowOnPrimaryDisplay('activate');
  mainWindow.show();
  mainWindow.focus();
}

function sendAppMenuCommand(command: AppMenuCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!target || target.isDestroyed()) {
    showMainWindow();
    return;
  }
  target.webContents.send('app-menu:command', command);
}

function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Phone Files...',
          click: () => sendAppMenuCommand('open-files')
        },
        {
          label: 'New Folder',
          accelerator: 'CommandOrControl+N',
          click: () => sendAppMenuCommand('new-folder')
        },
        { type: 'separator' },
        {
          label: 'Check Phone Now',
          accelerator: 'CommandOrControl+R',
          click: () => sendAppMenuCommand('refresh')
        },
        {
          label: 'Open Log',
          click: () => sendAppMenuCommand('open-log')
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        {
          label: 'Copy File Selection',
          click: () => sendAppMenuCommand('copy-selection')
        },
        {
          label: 'Paste File Selection',
          click: () => sendAppMenuCommand('paste-selection')
        },
        { type: 'separator' },
        {
          label: 'Copy to Queue',
          accelerator: 'CommandOrControl+Shift+C',
          click: () => sendAppMenuCommand('copy-to-queue')
        },
        {
          label: 'Select All Rows',
          accelerator: 'CommandOrControl+A',
          click: () => sendAppMenuCommand('select-all')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Folder Up',
          accelerator: 'CommandOrControl+B',
          click: () => sendAppMenuCommand('folder-up')
        },
        { type: 'separator' },
        {
          label: 'Focus Phone Pane',
          accelerator: 'CommandOrControl+1',
          click: () => sendAppMenuCommand('focus-phone')
        },
        {
          label: 'Focus Mac Pane',
          accelerator: 'CommandOrControl+2',
          click: () => sendAppMenuCommand('focus-mac')
        },
        { type: 'separator' },
        {
          label: 'List View',
          click: () => sendAppMenuCommand('view-list')
        },
        {
          label: 'Grid View',
          click: () => sendAppMenuCommand('view-grid')
        },
        {
          label: 'Show/Hide Hidden Files',
          click: () => sendAppMenuCommand('toggle-hidden-files')
        },
        { type: 'separator' },
        {
          label: 'Use System Appearance',
          click: () => sendAppMenuCommand('theme-system')
        },
        {
          label: 'Light Appearance',
          click: () => sendAppMenuCommand('theme-light')
        },
        {
          label: 'Dark Appearance',
          click: () => sendAppMenuCommand('theme-dark')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Log',
          click: () => sendAppMenuCommand('open-log')
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  removeLegacyPrecopyDirectory();
  appendLog('app ready');
  buildApplicationMenu();

  ipcMain.handle('mtp:getStatus', getStatus);
  ipcMain.handle('mtp:scanInventory', scanInventory);
  ipcMain.handle(
    'mtp:listFolder',
    (_event, deviceIndex: number, deviceConnectionId: string, storageId: number, parentId: number) =>
      listFolder(deviceIndex, deviceConnectionId, storageId, parentId)
  );
  ipcMain.handle('mtp:cancelFolderListing', () => cancelFolderListing());
  ipcMain.handle('local:listDirectory', (_event, directoryPath?: string, showHiddenFiles?: boolean) =>
    listLocalDirectory(directoryPath, showHiddenFiles === true)
  );
  ipcMain.handle('local:inspectPath', (_event, localPath: string) =>
    localEntryForPath(resolve(localPath))
  );
  ipcMain.handle('local:ensureDirectory', (_event, directoryPath: string) =>
    ensureLocalDirectory(directoryPath)
  );
  ipcMain.handle('local:setModifiedTime', (_event, localPath: string, modified: number) =>
    setLocalModifiedTime(localPath, modified)
  );
  ipcMain.handle('local:getCommonFolders', getCommonMacFolders);
  ipcMain.handle('mtp:chooseDestination', chooseDestination);
  ipcMain.handle('mtp:getDesktopDestination', getDesktopDestination);
  ipcMain.handle('mtp:startDownloads', (_event, requests: TransferRequest[]) =>
    enqueueDownloads(requests)
  );
  ipcMain.handle('mtp:startUploads', (_event, requests: UploadRequest[]) =>
    enqueueUploads(requests)
  );
  ipcMain.handle('mtp:startMoveDownloads', (_event, requests: TransferRequest[]) =>
    enqueueMoveDownloads(requests)
  );
  ipcMain.handle('mtp:startMoveUploads', (_event, requests: UploadRequest[]) =>
    enqueueMoveUploads(requests)
  );
  ipcMain.handle('mtp:createFolder', (_event, request: CreateFolderRequest) =>
    createPhoneFolder(request)
  );
  ipcMain.on('mtp:startPhoneFilePromiseDrag', (_event, request: PhoneFilePromiseDragRequest) =>
    startPhoneFilePromiseDrag(request)
  );
  ipcMain.on('mtp:startLocalFileDrag', startLocalFileDrag);
  ipcMain.handle('mtp:cancelTransfer', (_event, jobId: string) => cancelTransfer(jobId));
  ipcMain.handle('mtp:retryTransfer', (_event, jobId: string) => retryTransfer(jobId));
  ipcMain.handle('mtp:revealInFinder', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });
  ipcMain.handle('mtp:recoverWithAdmin', recoverWithAdmin);
  ipcMain.handle('mtp:openLog', async () => {
    await shell.openPath(getLogPath());
  });
  ipcMain.handle('mtp:copyDiagnostics', copyDiagnostics);

  showMainWindow();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  loadFilePromiseDragAddon()?.failAll('The app quit before the promised file finished copying.');
  for (const promiseId of promiseFulfillments.keys()) {
    failPromiseFulfillment(promiseId, 'The app quit before the promised file finished copying.');
  }
  if (sessionProcess) {
    destroyMtpSession('App is quitting.');
  }
  if (adminSession) {
    if (!detachAdminMtpSessionForRelaunch('App is quitting.')) {
      destroyAdminMtpSession('App is quitting.');
    }
  }
});
