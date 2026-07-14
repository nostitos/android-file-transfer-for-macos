import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  LayoutList,
  Loader2,
  Monitor,
  Moon,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  Smartphone,
  Sun,
  Upload,
  X
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import type {
  AdminRecoveryResult,
  AppMenuCommand,
  CommonMacFolder,
  DeviceStatus,
  FolderListProgress,
  InventoryResult,
  LocalEntry,
  LocalDirectoryResult,
  MtpDeviceInventory,
  MtpObject,
  MtpStorage,
  TransferJob,
  TransferOperation,
  TransferRequest,
  UploadRequest
} from '../../shared/types';

const ROOT_PARENT_ID = 4294967295;
const MAX_PLANNED_PHONE_FILES = 3000;
const MAX_PLANNED_MAC_FILES = 3000;
const MAX_PLANNED_MAC_FOLDERS = 1000;
const MAX_PLANNED_MAC_DEPTH = 100;
const AUTO_PHONE_CHECK_INTERVAL_MS = 3000;
const THEME_STORAGE_KEY = 'androidFileTransferForMacOS.themeMode';
const VIEW_MODE_STORAGE_KEY = 'androidFileTransferForMacOS.phoneViewMode';
const SHOW_HIDDEN_STORAGE_KEY = 'androidFileTransferForMacOS.showHiddenFiles';
const MAC_PANE_WIDTH_STORAGE_KEY = 'androidFileTransferForMacOS.macPaneWidth';
const BLOCKED_AUTO_DEVICE_KEYS_STORAGE_KEY = 'androidFileTransferForMacOS.blockedAutoDeviceKeys';
const NORMAL_ACCESS_BLOCKED_MESSAGE =
  'Phone is visible in File Transfer mode, but its folders are not open yet. Use Open files to start one protected phone-file session.';
const DEFAULT_MAC_PANE_WIDTH = 460;
const MIN_MAC_PANE_WIDTH = 400;
const MAX_MAC_PANE_WIDTH = 720;
const MIN_PHONE_PANE_WIDTH = 420;
const SIDEBAR_WIDTH = 246;
const PANE_RESIZER_WIDTH = 8;
const usbModeHelpText =
  'You may also see Charge only, Photo transfer, USB tethering, or MIDI. Those do not show the phone folders in this app.';

type SortKey = 'name' | 'size' | 'modified' | 'type';
type SortDirection = 'asc' | 'desc';
type RefreshFeedbackPhase = 'checking' | 'done' | 'failed';
type TransferNoticePhase = 'ready' | 'queued' | 'failed';
type ActivePane = 'phone' | 'mac';
type ThemeMode = 'system' | 'light' | 'dark';
type PhoneViewMode = 'list' | 'grid';
type ContextMenuPane = 'phone' | 'mac';
type ConnectionStageState = 'done' | 'current' | 'blocked' | 'waiting';
type TransferClipboard =
  | {
      source: 'phone';
      deviceIndex: number;
      deviceConnectionId: string;
      rows: BrowserRow[];
      label: string;
    }
  | {
      source: 'mac';
      entries: LocalEntry[];
      label: string;
    };

interface BrowserLocation {
  storageId: number | null;
  folderId: number;
  crumbs: Array<{ label: string; folderId: number }>;
}

interface BrowserRow {
  key: string;
  name: string;
  kind: 'storage' | 'folder' | 'file';
  size: number;
  modified: number;
  type: string;
  storage?: MtpStorage;
  object?: MtpObject;
}

interface RefreshFeedback {
  phase: RefreshFeedbackPhase;
  message: string;
}

interface TransferNotice {
  phase: TransferNoticePhase;
  message: string;
}

interface ConnectionStageItem {
  key: string;
  label: string;
  detail: string;
  state: ConnectionStageState;
}

interface PhoneDownloadPlan {
  requests: TransferRequest[];
  directories: PlannedLocalDirectory[];
}

interface PhoneDownloadPlanningProgress {
  files: number;
  folders: number;
  currentName: string;
}

interface PhoneDownloadPlanOptions {
  onProgress?: (progress: PhoneDownloadPlanningProgress) => void;
  shouldCancel?: () => boolean;
}

interface PlannedLocalDirectory {
  path: string;
  modified: number;
}

interface PhoneUploadPlan {
  requests: UploadRequest[];
  folderCount: number;
  conflictCount: number;
}

interface LocalCrumb {
  label: string;
  path: string;
}

interface ContextMenuState {
  pane: ContextMenuPane;
  x: number;
  y: number;
  rowKey?: string;
  localPath?: string;
}

const rootLocation: BrowserLocation = {
  storageId: null,
  folderId: ROOT_PARENT_ID,
  crumbs: []
};

function formatBytes(bytes: number): string {
  if (!bytes) {
    return bytes === 0 ? '0 B' : '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizePhoneObjects(objects: MtpObject[]): string {
  const fileCount = objects.filter((object) => object.kind === 'file').length;
  const folderCount = objects.filter((object) => object.kind === 'folder').length;
  const totalBytes = objects.reduce(
    (total, object) => total + (object.kind === 'file' ? Math.max(object.size || 0, 0) : 0),
    0
  );

  if (!objects.length) {
    return 'No items';
  }

  return [
    folderCount ? pluralize(folderCount, 'folder') : '',
    fileCount ? pluralize(fileCount, 'file') : '',
    fileCount ? `${formatBytes(totalBytes)} total` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

function summarizePhoneSelection(rows: BrowserRow[]): string {
  if (!rows.length) {
    return '';
  }

  const fileRows = rows.filter((row) => row.kind === 'file');
  const folderCount = rows.filter((row) => row.kind === 'folder').length;
  const storageCount = rows.filter((row) => row.kind === 'storage').length;
  const totalBytes = fileRows.reduce((total, row) => total + Math.max(row.size || 0, 0), 0);
  const parts = [`${pluralize(rows.length, 'item')} selected`];
  if (folderCount) {
    parts.push(pluralize(folderCount, 'folder'));
  }
  if (fileRows.length) {
    parts.push(`${pluralize(fileRows.length, 'file')} · ${formatBytes(totalBytes)}`);
  }
  if (storageCount) {
    parts.push(pluralize(storageCount, 'storage location'));
  }
  return parts.join(' · ');
}

function summarizeLocalSelection(entries: LocalEntry[]): string {
  if (!entries.length) {
    return '';
  }

  const fileEntries = entries.filter((entry) => entry.kind === 'file');
  const folderCount = entries.filter((entry) => entry.kind === 'folder').length;
  const totalBytes = fileEntries.reduce((total, entry) => total + Math.max(entry.size || 0, 0), 0);
  const parts = [`${pluralize(entries.length, 'item')} selected`];
  if (folderCount) {
    parts.push(pluralize(folderCount, 'folder'));
  }
  if (fileEntries.length) {
    parts.push(`${pluralize(fileEntries.length, 'file')} · ${formatBytes(totalBytes)}`);
  }
  return parts.join(' · ');
}

function uploadSkipSummary(conflictCount: number): string {
  return conflictCount > 0
    ? `${conflictCount} name conflict${conflictCount === 1 ? '' : 's'} skipped. Nothing was overwritten.`
    : '';
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').filter(Boolean).pop();
  return name || filePath;
}

function downloadRenameSummary(jobs: TransferJob[]): string {
  const renamedCount = jobs.filter((job) => job.direction === 'download' && job.renamedDestination).length;
  if (renamedCount === 0) {
    return '';
  }
  return `${renamedCount} will use new Mac ${renamedCount === 1 ? 'name' : 'names'}; nothing overwritten.`;
}

function directoryDepth(directoryPath: string): number {
  return directoryPath.replace(/\\/g, '/').split('/').filter(Boolean).length;
}

function plannedDirectoryKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function folderCopyPlanningStoppedMessage(): string {
  return 'Folder copy preparation stopped. Nothing was copied.';
}

async function preservePlannedLocalDirectories(directories: PlannedLocalDirectory[]): Promise<void> {
  const ordered = [...directories]
    .filter((directory) => Number.isFinite(directory.modified) && directory.modified > 0)
    .sort((a, b) => directoryDepth(b.path) - directoryDepth(a.path));

  for (const directory of ordered) {
    await window.mtp.setLocalModifiedTime(directory.path, directory.modified);
  }
}

function mergeTransferJobs(currentJobs: TransferJob[], incomingJobs: TransferJob[]): TransferJob[] {
  const nextJobs: TransferJob[] = [];
  const seenJobIds = new Set<string>();

  [...incomingJobs, ...currentJobs].forEach((job) => {
    if (seenJobIds.has(job.id)) {
      return;
    }
    seenJobIds.add(job.id);
    nextJobs.push(job);
  });

  return nextJobs;
}

function storageCapacityKnown(storage: MtpStorage | undefined): boolean {
  return !!storage && (storage.maxCapacity > 0 || storage.freeSpace > 0);
}

function formatStorageTotal(storage: MtpStorage | undefined): string {
  if (!storageCapacityKnown(storage)) {
    return 'Size unavailable';
  }

  return storage?.maxCapacity && storage.maxCapacity > 0
    ? `${formatBytes(storage.maxCapacity)} total`
    : 'Size unavailable';
}

function formatStorageFree(storage: MtpStorage | undefined): string {
  if (!storageCapacityKnown(storage)) {
    return 'Capacity unavailable';
  }

  return storage?.freeSpace && storage.freeSpace > 0
    ? `${formatBytes(storage.freeSpace)} free`
    : 'Free space unavailable';
}

function storageUsagePercent(storage: MtpStorage | undefined): number | null {
  if (!storage || storage.maxCapacity <= 0) {
    return null;
  }

  const freeBytes = Math.min(Math.max(storage.freeSpace || 0, 0), storage.maxCapacity);
  const usedBytes = storage.maxCapacity - freeBytes;
  return Math.max(0, Math.min(100, Math.round((usedBytes / storage.maxCapacity) * 100)));
}

function formatStorageUsage(storage: MtpStorage | undefined): string {
  if (!storage || storage.maxCapacity <= 0) {
    return formatStorageFree(storage);
  }

  const freeBytes = Math.min(Math.max(storage.freeSpace || 0, 0), storage.maxCapacity);
  const usedBytes = storage.maxCapacity - freeBytes;
  return `${formatBytes(usedBytes)} used of ${formatBytes(storage.maxCapacity)}`;
}

function formatBrowserRowSize(row: BrowserRow): string {
  if (row.kind === 'folder') {
    return '—';
  }

  if (row.kind === 'storage') {
    return storageCapacityKnown(row.storage) && row.storage?.maxCapacity
      ? formatBytes(row.storage.maxCapacity)
      : '—';
  }

  return formatBytes(row.size);
}

function formatDate(epochSeconds: number): string {
  if (!epochSeconds || epochSeconds < 1) {
    return '—';
  }
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(epochSeconds * 1000));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return '—';
  }
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function formatElapsed(seconds: number): string {
  if (seconds <= 0) {
    return 'Starting...';
  }
  if (seconds < 60) {
    return `Still working · ${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `Still working · ${minutes}m ${remainder}s`;
}

function formatClockTime(date = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function extensionFor(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) {
    return 'File';
  }
  return name.slice(index + 1).toUpperCase();
}

function folderLabelForPath(path: string): string {
  if (!path) {
    return 'Choose folder';
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'Users') {
    return 'Home';
  }
  return parts[parts.length - 1] || path;
}

function crumbsForMacPath(path: string): LocalCrumb[] {
  const parts = path.split('/').filter(Boolean);
  const crumbs: LocalCrumb[] = [{ label: 'Mac', path: '/' }];
  let current = '';
  parts.forEach((part) => {
    current = `${current}/${part}`;
    crumbs.push({ label: part, path: current });
  });
  return crumbs;
}

function sanitizePathPart(name: string): string {
  const cleaned = name.replace(/[/:]/g, '_').replace(/\0/g, '').trim();
  return cleaned || 'folder';
}

function cleanPhoneFolderName(name: string): string {
  return name.replace(/\0/g, '').trim();
}

function isEditableElement(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

function isInteractiveElement(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('button, input, textarea, select, a, [contenteditable="true"]')
  );
}

function readStoredThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDarkTheme(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function readStoredPhoneViewMode(): PhoneViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === 'grid' || stored === 'list' ? stored : 'list';
  } catch {
    return 'list';
  }
}

function readStoredShowHiddenFiles(): boolean {
  try {
    return window.localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function isHiddenFileName(name: string): boolean {
  return name.startsWith('.');
}

function clampMacPaneWidth(width: number, workspaceWidth?: number): number {
  const hasUsableWorkspace =
    typeof workspaceWidth === 'number' &&
    workspaceWidth >= SIDEBAR_WIDTH + PANE_RESIZER_WIDTH + MIN_PHONE_PANE_WIDTH + MIN_MAC_PANE_WIDTH;
  const maxForWorkspace =
    hasUsableWorkspace
      ? Math.max(
          MIN_MAC_PANE_WIDTH,
          workspaceWidth - SIDEBAR_WIDTH - PANE_RESIZER_WIDTH - MIN_PHONE_PANE_WIDTH
        )
      : MAX_MAC_PANE_WIDTH;
  const maxWidth = Math.min(MAX_MAC_PANE_WIDTH, maxForWorkspace);
  return Math.min(Math.max(Math.round(width), MIN_MAC_PANE_WIDTH), maxWidth);
}

function readStoredMacPaneWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(MAC_PANE_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) ? clampMacPaneWidth(stored) : DEFAULT_MAC_PANE_WIDTH;
  } catch {
    return DEFAULT_MAC_PANE_WIDTH;
  }
}

function joinMacPath(...parts: string[]): string {
  const [first = '', ...rest] = parts;
  return rest.reduce((path, part) => {
    const cleanPart = part.replace(/^\/+|\/+$/g, '');
    if (!cleanPart) {
      return path;
    }
    return `${path.replace(/\/+$/g, '')}/${cleanPart}`;
  }, first || '/');
}

function typeForObject(object: MtpObject): string {
  if (object.kind === 'folder') {
    return 'Folder';
  }
  return extensionFor(object.name);
}

function folderKey(deviceConnectionId: string, storageId: number, parentId: number): string {
  return `${deviceConnectionId}:${storageId}:${parentId}`;
}

function storageRowKey(deviceConnectionId: string, storageId: number): string {
  return `storage:${deviceConnectionId}:${storageId}`;
}

function objectRowKey(deviceConnectionId: string, storageId: number, objectId: number): string {
  return `object:${deviceConnectionId}:${storageId}:${objectId}`;
}

function deviceDisplayName(device: MtpDeviceInventory): string {
  return device.name || device.product || device.vendor || `Phone ${device.index + 1}`;
}

function rawDeviceKey(
  rawDevice: DeviceStatus['rawDevices'][number] | null | undefined
): string | null {
  if (!rawDevice) {
    return null;
  }
  return `${rawDevice.bus}:${rawDevice.device}:${rawDevice.vendorId}:${rawDevice.productId}`;
}

function rawDeviceIdentityKey(
  rawDevice: DeviceStatus['rawDevices'][number] | null | undefined
): string | null {
  if (!rawDevice) {
    return null;
  }

  return [
    rawDevice.vendorId,
    rawDevice.productId,
    rawDevice.serial?.toLowerCase() ?? '',
    rawDevice.vendor.toLowerCase(),
    rawDevice.product.toLowerCase(),
    rawDevice.connectionMode ?? 'unknown'
  ].join(':');
}

function rawDeviceAutomaticIdentityKey(
  rawDevice: DeviceStatus['rawDevices'][number] | null | undefined
): string | null {
  if (!rawDevice) {
    return null;
  }

  return [
    rawDevice.vendorId,
    rawDevice.productId,
    rawDevice.serial?.toLowerCase() ?? '',
    rawDevice.connectionMode ?? 'unknown'
  ].join(':');
}

function rawDeviceStableIdentityKey(
  rawDevice: DeviceStatus['rawDevices'][number] | null | undefined
): string | null {
  if (!rawDevice) {
    return null;
  }

  return [rawDevice.vendorId, rawDevice.productId, rawDevice.serial?.toLowerCase() ?? ''].join(':');
}

function rawDeviceConnectionKey(
  rawDevice: DeviceStatus['rawDevices'][number] | null | undefined
): string | null {
  const stableKey = rawDeviceStableIdentityKey(rawDevice);
  if (!rawDevice || !stableKey) {
    return null;
  }

  if (rawDevice.connectionId) {
    return rawDevice.connectionId;
  }

  const usbSessionKey = rawDevice.usbSessionId
    ? `usb-session:${rawDevice.usbSessionId}`
    : `raw:${rawDeviceKey(rawDevice) ?? 'unknown'}`;
  return `${stableKey}:${usbSessionKey}`;
}

function rawDeviceAutomaticBlockKeys(
  rawDevice: DeviceStatus['rawDevices'][number] | null | undefined
): string[] {
  if (!rawDevice) {
    return [];
  }

  return Array.from(
    new Set(
      [
        rawDeviceIdentityKey(rawDevice),
        rawDeviceAutomaticIdentityKey(rawDevice),
        `${rawDevice.vendorId}:${rawDevice.productId}:${rawDevice.connectionMode ?? 'unknown'}`
      ].filter((key): key is string => typeof key === 'string' && key.length > 0)
    )
  );
}

function statusRawKey(nextStatus: DeviceStatus | null): string | null {
  return rawDeviceKey(nextStatus?.rawDevices[0]);
}

function statusDeviceIdentityKey(nextStatus: DeviceStatus | null): string | null {
  return rawDeviceIdentityKey(nextStatus?.rawDevices[0]);
}

function statusStableDeviceIdentityKey(nextStatus: DeviceStatus | null): string | null {
  return rawDeviceStableIdentityKey(nextStatus?.rawDevices[0]);
}

function statusConnectionKey(nextStatus: DeviceStatus | null): string | null {
  return rawDeviceConnectionKey(nextStatus?.rawDevices[0]);
}

function statusAttachmentSetKey(nextStatus: DeviceStatus | null): string | null {
  const keys = (nextStatus?.rawDevices ?? [])
    .map(rawDeviceConnectionKey)
    .filter((key): key is string => !!key)
    .sort();
  return keys.length ? keys.join('|') : null;
}

function statusSessionConnectionIds(nextStatus: DeviceStatus): Set<string> {
  return new Set(
    [...(nextStatus.sessionConnectionIds ?? []), nextStatus.sessionConnectionId]
      .filter((connectionId): connectionId is string => !!connectionId)
  );
}

function statusAutomaticBlockKeys(nextStatus: DeviceStatus | null): string[] {
  return rawDeviceAutomaticBlockKeys(nextStatus?.rawDevices[0]);
}

function expandBlockedAutoDeviceKeyAliases(key: string): string[] {
  const parts = key.split(':');
  if (parts.length >= 6) {
    const [vendorId, productId, serial] = parts;
    const mode = parts[parts.length - 1] || 'unknown';
    return [key, `${vendorId}:${productId}:${serial}:${mode}`, `${vendorId}:${productId}:${mode}`];
  }
  if (parts.length === 4) {
    const [vendorId, productId, , mode] = parts;
    return [key, `${vendorId}:${productId}:${mode || 'unknown'}`];
  }
  return [key];
}

function readBlockedAutoDeviceKeys(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }

  try {
    const stored = window.localStorage.getItem(BLOCKED_AUTO_DEVICE_KEYS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    const keys = Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : [];
    return new Set(keys.flatMap(expandBlockedAutoDeviceKeyAliases));
  } catch {
    return new Set();
  }
}

function writeBlockedAutoDeviceKeys(keys: Set<string>): void {
  try {
    if (!keys.size) {
      window.localStorage.removeItem(BLOCKED_AUTO_DEVICE_KEYS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(BLOCKED_AUTO_DEVICE_KEYS_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Ignore private-mode or storage-quota failures; in-memory blocking still works.
  }
}

function refreshResultMessage(
  nextStatus: DeviceStatus | null,
  nextInventory: InventoryResult | null,
  openSessionKept: boolean
): string {
  const checkedAt = formatClockTime();
  if (openSessionKept) {
    return `Checked ${checkedAt}: phone-file session is still open.`;
  }
  if (nextInventory?.state === 'connected' && nextInventory.devices.length) {
    return `Checked ${checkedAt}: phone files are open.`;
  }
  if (!nextStatus) {
    return `Checked ${checkedAt}: check did not finish. Try again.`;
  }

  const rawDevice = nextStatus.rawDevices[0];
  const rawDeviceName = rawDevice?.vendor || rawDevice?.product || 'the phone';
  if (rawDevice?.connectionMode === 'mtp' && nextStatus.state === 'connect-error') {
    return `Checked ${checkedAt}: Mac sees ${rawDeviceName} over USB. The phone file session is not open yet.`;
  }
  if (rawDevice?.connectionMode === 'usb-only') {
    return `Checked ${checkedAt}: Mac sees ${rawDeviceName}, but files are not open. Choose File transfer on the phone.`;
  }
  if (phoneNeedsUnlockOrAllow(nextStatus, nextInventory)) {
    return `Checked ${checkedAt}: Mac sees ${rawDeviceName}, but the phone has not allowed file access. Unlock it and tap Allow if asked.`;
  }
  if (nextStatus.state === 'connect-error' && rawDevice) {
    return `Checked ${checkedAt}: Mac sees ${rawDeviceName}, but files are still not open.`;
  }
  if (nextStatus.state === 'no-device') {
    return `Checked ${checkedAt}: no phone file-transfer connection is visible.`;
  }
  if (nextInventory?.ok === false) {
    return `Checked ${checkedAt}: ${rawDeviceName} is visible, but phone files are still not open. Use Open files or Details.`;
  }
  return `Checked ${checkedAt}: phone connection checked.`;
}

function phoneNeedsUnlockOrAllow(
  status: DeviceStatus | null,
  inventory: InventoryResult | null
): boolean {
  const state = inventory?.state ?? status?.state ?? 'checking';
  if (state !== 'connect-error' || !status?.rawDevices.length) {
    return false;
  }

  const combinedText = [
    status.message,
    inventory?.message,
    status.stderr,
    inventory?.stderr
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  return (
    combinedText.includes('locked') ||
    combinedText.includes('allow access') ||
    combinedText.includes('not open') ||
    combinedText.includes('could not connect')
  );
}

function phoneNeedsProtectedUsbAccess(status: DeviceStatus | null): boolean {
  return status?.rawDevices[0]?.needsDeviceAccessEntitlement === true;
}

function phoneFileSessionNotOpen(status: DeviceStatus | null, inventory: InventoryResult | null): boolean {
  const state = inventory?.state ?? status?.state ?? 'checking';
  return state === 'connect-error' && status?.rawDevices[0]?.connectionMode === 'mtp' && !status?.sessionOpen;
}

function phoneFileSessionText(status: DeviceStatus | null, inventory: InventoryResult | null): string {
  const state = inventory?.state ?? status?.state ?? 'checking';
  if (inventory?.protectedAccess && state === 'connected') {
    return 'Open through protected access';
  }
  if (state === 'connected' || status?.sessionOpen) {
    return 'Open';
  }
  if (phoneFileSessionNotOpen(status, inventory)) {
    return 'Not open; USB is visible';
  }
  if (status?.rawDevices[0]?.connectionMode === 'usb-only') {
    return 'Not open; phone is not in File Transfer mode';
  }
  return 'Not open';
}

function inventoryLooksLikeStorageFailure(inventory: InventoryResult | null): boolean {
  if (inventory?.ok !== false) {
    return false;
  }
  const text = `${inventory.message}\n${inventory.stderr ?? ''}`.toLowerCase();
  return text.includes('storage') || text.includes('get_storage') || text.includes('get storage');
}

function stageStateLabel(state: ConnectionStageState): string {
  if (state === 'done') {
    return 'Done';
  }
  if (state === 'current') {
    return 'Now';
  }
  if (state === 'blocked') {
    return 'Blocked';
  }
  return 'Waiting';
}

function FileIcon({ row }: { row: BrowserRow }): JSX.Element {
  if (row.kind === 'storage') {
    return <HardDrive size={16} strokeWidth={1.8} />;
  }
  if (row.kind === 'folder') {
    return <Folder size={16} strokeWidth={1.8} />;
  }

  const ext = extensionFor(row.name).toLowerCase();
  if (['mp4', 'mov', 'm4v', 'mkv', 'webm', '3gp'].includes(ext)) {
    return <FileVideo size={16} strokeWidth={1.8} />;
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'dng'].includes(ext)) {
    return <FileImage size={16} strokeWidth={1.8} />;
  }
  if (['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'].includes(ext)) {
    return <FileAudio size={16} strokeWidth={1.8} />;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return <FileArchive size={16} strokeWidth={1.8} />;
  }
  if (['txt', 'pdf', 'doc', 'docx', 'csv', 'json', 'xml'].includes(ext)) {
    return <FileText size={16} strokeWidth={1.8} />;
  }
  return <File size={16} strokeWidth={1.8} />;
}

function CommonMacFolderIcon({ folder }: { folder: CommonMacFolder }): JSX.Element {
  switch (folder.id) {
    case 'downloads':
      return <Download size={14} strokeWidth={1.9} />;
    case 'documents':
      return <FileText size={14} strokeWidth={1.9} />;
    case 'pictures':
      return <FileImage size={14} strokeWidth={1.9} />;
    case 'movies':
      return <FileVideo size={14} strokeWidth={1.9} />;
    case 'desktop':
      return <Monitor size={14} strokeWidth={1.9} />;
    case 'home':
    default:
      return <Folder size={14} strokeWidth={1.9} />;
  }
}

function stateLabel(status: DeviceStatus | null, inventory: InventoryResult | null): string {
  const state = inventory?.state ?? status?.state ?? 'checking';
  if (inventory?.protectedAccess && state === 'connected') {
    return 'Files open';
  }
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'no-device':
      return 'No device';
    case 'connect-error':
      if (phoneFileSessionNotOpen(status, inventory)) {
        return 'USB visible';
      }
      if (phoneNeedsUnlockOrAllow(status, inventory)) {
        return 'Unlock phone';
      }
      return 'Files not open';
    case 'bridge-missing':
      return 'Bridge missing';
    case 'checking':
      return 'Checking';
    case 'error':
    case 'memory-error':
      return 'Needs help';
    default:
      return 'Needs help';
  }
}

function stateTitle(status: DeviceStatus | null, inventory: InventoryResult | null): string {
  const state = inventory?.state ?? status?.state ?? 'checking';
  if (inventory?.protectedAccess && state === 'connected') {
    return 'Phone files are open through protected access.';
  }
  if (state === 'connect-error' && status?.rawDevices[0]?.connectionMode === 'mtp') {
    if (phoneNeedsProtectedUsbAccess(status)) {
      return 'The Mac can see this phone in File Transfer mode. The MTP file session is not open yet.';
    }
    return 'The phone is in File Transfer mode, but the MTP file session is not open yet.';
  }
  if (phoneNeedsUnlockOrAllow(status, inventory)) {
    return 'Unlock the phone and tap Allow if Android asks to open file access.';
  }
  switch (state) {
    case 'connected':
      return 'Phone files are open.';
    case 'no-device':
      return 'No phone file-transfer connection is visible to the Mac.';
    case 'connect-error':
      return 'The phone is connected, but its folders are not open to this app yet.';
    case 'bridge-missing':
      return 'The native phone-file helper is missing or not executable.';
    case 'checking':
      return 'Checking the phone connection.';
    default:
      return 'The phone connection needs attention.';
  }
}

function compareRows(a: BrowserRow, b: BrowserRow, key: SortKey, direction: SortDirection): number {
  if (a.kind !== 'file' && b.kind === 'file') {
    return -1;
  }
  if (a.kind === 'file' && b.kind !== 'file') {
    return 1;
  }

  let result = 0;
  if (key === 'name') {
    result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  } else if (key === 'size') {
    result = a.size - b.size;
  } else if (key === 'modified') {
    result = a.modified - b.modified;
  } else {
    result = a.type.localeCompare(b.type, undefined, { numeric: true, sensitivity: 'base' });
  }

  return direction === 'asc' ? result : -result;
}

function compareLocalEntries(a: LocalEntry, b: LocalEntry, key: SortKey, direction: SortDirection): number {
  if (a.kind !== b.kind) {
    return a.kind === 'folder' ? -1 : 1;
  }

  let result = 0;
  if (key === 'name') {
    result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  } else if (key === 'size') {
    result = a.size - b.size;
  } else if (key === 'modified') {
    result = a.modified - b.modified;
  } else {
    result = (a.type || extensionFor(a.name)).localeCompare(
      b.type || extensionFor(b.name),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
  }

  if (result === 0) {
    result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }

  return direction === 'asc' ? result : -result;
}

function makeRows(
  device: MtpDeviceInventory | null,
  location: BrowserLocation,
  folderObjects: MtpObject[]
): BrowserRow[] {
  if (!device) {
    return [];
  }

  if (location.storageId === null) {
    return device.storages.map((storage) => ({
      key: storageRowKey(device.connectionId, storage.id),
      name: storage.description || storage.volumeIdentifier || `Storage ${storage.id}`,
      kind: 'storage',
      size: storage.maxCapacity,
      modified: 0,
      type: 'Storage',
      storage
    }));
  }

  return folderObjects.map((object) => ({
      key: objectRowKey(device.connectionId, object.storageId, object.id),
      name: object.name,
      kind: object.kind,
      size: object.kind === 'file' ? object.size : 0,
      modified: object.modified,
      type: typeForObject(object),
      object
  }));
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [inventory, setInventory] = useState<InventoryResult | null>(null);
  const [selectedDeviceConnectionId, setSelectedDeviceConnectionId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [location, setLocation] = useState<BrowserLocation>(rootLocation);
  const [backStack, setBackStack] = useState<BrowserLocation[]>([]);
  const [forwardStack, setForwardStack] = useState<BrowserLocation[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [query, setQuery] = useState('');
  const [destination, setDestination] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [localParentPath, setLocalParentPath] = useState('');
  const [localBackStack, setLocalBackStack] = useState<string[]>([]);
  const [localForwardStack, setLocalForwardStack] = useState<string[]>([]);
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [commonMacFolders, setCommonMacFolders] = useState<CommonMacFolder[]>([]);
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<Set<string>>(new Set());
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSortKey, setLocalSortKey] = useState<SortKey>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [folderCache, setFolderCache] = useState<Record<string, MtpObject[]>>({});
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>({});
  const [loadingFolderKeys, setLoadingFolderKeys] = useState<Set<string>>(new Set());
  const [folderListProgress, setFolderListProgress] = useState<
    (FolderListProgress & { key: string }) | null
  >(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryResult, setRecoveryResult] = useState<AdminRecoveryResult | null>(null);
  const [loadingElapsedSeconds, setLoadingElapsedSeconds] = useState(0);
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback | null>(null);
  const [isDraggingTransfer, setIsDraggingTransfer] = useState(false);
  const [isDraggingMacFiles, setIsDraggingMacFiles] = useState(false);
  const [transferNotice, setTransferNotice] = useState<TransferNotice | null>(null);
  const [phoneDownloadPlanning, setPhoneDownloadPlanning] = useState<PhoneDownloadPlanningProgress | null>(null);
  const [transferClipboard, setTransferClipboard] = useState<TransferClipboard | null>(null);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [activePane, setActivePane] = useState<ActivePane>('phone');
  const [phoneTransferOperation, setPhoneTransferOperation] = useState<TransferOperation>('copy');
  const [macTransferOperation, setMacTransferOperation] = useState<TransferOperation>('copy');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => systemPrefersDarkTheme());
  const [phoneViewMode, setPhoneViewMode] = useState<PhoneViewMode>(() => readStoredPhoneViewMode());
  const [showHiddenFiles, setShowHiddenFiles] = useState(() => readStoredShowHiddenFiles());
  const [macPaneWidth, setMacPaneWidth] = useState(() => readStoredMacPaneWidth());
  const [isResizingPane, setIsResizingPane] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const queuePaneRef = useRef<HTMLElement>(null);
  const phoneBrowserRef = useRef<HTMLDivElement>(null);
  const phoneBreadcrumbsRef = useRef<HTMLDivElement>(null);
  const localListRef = useRef<HTMLDivElement>(null);
  const localBreadcrumbsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const phoneSelectionAnchorKey = useRef<string | null>(null);
  const localSelectionAnchorPath = useRef<string | null>(null);
  const paneResizeStart = useRef<{ startX: number; startWidth: number; workspaceWidth: number } | null>(null);
  const downloadFolderPlans = useRef<
    Record<string, { remainingJobIds: Set<string>; directories: PlannedLocalDirectory[]; failed: boolean }>
  >({});
  const phoneDownloadPlanningCancelRequested = useRef(false);
  const folderLoadTokens = useRef<Record<string, string>>({});
  const scanInFlight = useRef(false);
  const pollInFlight = useRef(false);
  const recoveryInFlight = useRef(false);
  const inventoryRef = useRef<InventoryResult | null>(null);
  const lastAutoRawKey = useRef<string | null>(null);
  const lastAutoDeviceIdentityKey = useRef<string | null>(null);
  const lastVisibleConnectionKey = useRef<string | null>(null);
  const blockedAutoDeviceKeys = useRef<Set<string>>(readBlockedAutoDeviceKeys());
  const protectedAccessRawKey = useRef<string | null>(null);
  const protectedAccessDeviceIdentityKey = useRef<string | null>(null);
  const protectedAccessConnectionId = useRef<string | null>(null);

  const inventoryDevices = inventory?.devices ?? [];
  const device =
    inventoryDevices.find((candidate) => candidate.connectionId === selectedDeviceConnectionId) ??
    inventoryDevices[0] ??
    null;
  const currentFolderKey =
    device && location.storageId !== null
      ? folderKey(device.connectionId, location.storageId, location.folderId)
      : null;
  const currentFolderObjects = currentFolderKey ? (folderCache[currentFolderKey] ?? []) : [];
  const currentFolderError = currentFolderKey ? folderErrors[currentFolderKey] : undefined;
  const folderLoading = currentFolderKey ? loadingFolderKeys.has(currentFolderKey) : false;
  const currentFolderProgress =
    folderLoading && folderListProgress?.key === currentFolderKey ? folderListProgress : null;
  const currentFolderProgressPercent =
    currentFolderProgress && currentFolderProgress.total > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((currentFolderProgress.sent / currentFolderProgress.total) * 100))
        )
      : null;
  const rawDevice =
    status?.rawDevices.find(
      (candidate) => rawDeviceConnectionKey(candidate) === device?.connectionId
    ) ??
    status?.rawDevices[0] ??
    null;
  const rawDeviceName = rawDevice?.vendor || rawDevice?.product || 'Android phone';
  const locationRows = useMemo(
    () => makeRows(device, location, currentFolderObjects),
    [currentFolderObjects, device, location]
  );
  const visibleLocationRows = useMemo(
    () =>
      locationRows.filter((row) => showHiddenFiles || row.kind === 'storage' || !isHiddenFileName(row.name)),
    [locationRows, showHiddenFiles]
  );
  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return visibleLocationRows
      .filter((row) => !normalizedQuery || row.name.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => compareRows(a, b, sortKey, sortDirection));
  }, [query, sortDirection, sortKey, visibleLocationRows]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedKeys.has(row.key)),
    [rows, selectedKeys]
  );

  const selectedTransferRows = selectedRows.filter(
    (row) => (row.kind === 'file' || row.kind === 'folder') && row.object
  );
  const sortedLocalEntries = useMemo(
    () => [...localEntries].sort((a, b) => compareLocalEntries(a, b, localSortKey, localSortDirection)),
    [localEntries, localSortDirection, localSortKey]
  );
  const selectedLocalEntries = useMemo(
    () => sortedLocalEntries.filter((entry) => selectedLocalPaths.has(entry.path)),
    [selectedLocalPaths, sortedLocalEntries]
  );
  const localCrumbs = useMemo(() => crumbsForMacPath(localPath || destination), [destination, localPath]);
  const visibleQueueJobs = jobs;
  const queueSummary = useMemo(() => {
    let active = 0;
    let queued = 0;
    let completed = 0;
    let failed = 0;
    let canceled = 0;
    let activeTransfers = 0;
    let queuedTransfers = 0;
    let transferredBytes = 0;
    let totalBytes = 0;
    let speedBytesPerSecond = 0;

    visibleQueueJobs.forEach((job) => {
      const jobTotal = Math.max(job.totalBytes || job.size || 0, 0);
      const jobTransferred =
        job.status === 'completed'
          ? jobTotal
          : Math.min(Math.max(job.bytesTransferred || 0, 0), jobTotal || Number.MAX_SAFE_INTEGER);

      totalBytes += jobTotal;
      transferredBytes += jobTransferred;

      if (job.status === 'active') {
        active += 1;
        activeTransfers += 1;
        speedBytesPerSecond += job.speedBytesPerSecond || 0;
      } else if (job.status === 'queued') {
        queued += 1;
        queuedTransfers += 1;
      } else if (job.status === 'completed') {
        completed += 1;
      } else if (job.status === 'failed') {
        failed += 1;
      } else if (job.status === 'canceled') {
        canceled += 1;
      }
    });

    const finished = completed + failed + canceled;
    const percent =
      totalBytes > 0
        ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
        : visibleQueueJobs.length > 0 && finished === visibleQueueJobs.length
          ? 100
          : 0;
    const remainingBytes = Math.max(totalBytes - transferredBytes, 0);
    const etaSeconds =
      speedBytesPerSecond > 0 && remainingBytes > 0 ? remainingBytes / speedBytesPerSecond : null;

    return {
      total: visibleQueueJobs.length,
      active,
      queued,
      completed,
      failed,
      canceled,
      activeTransfers,
      queuedTransfers,
      finished,
      cancellable: active + queued,
      transferredBytes,
      totalBytes,
      speedBytesPerSecond,
      etaSeconds,
      percent
    };
  }, [visibleQueueJobs]);
  const canUploadToCurrentFolder = !!device && location.storageId !== null;
  const rawMtpVisible = rawDevice?.connectionMode === 'mtp';
  const visibleMtpSessionNotOpen = phoneFileSessionNotOpen(status, inventory);
  const fileSessionStatus = phoneFileSessionText(status, inventory);
  const protectedUsbAccessRequired = rawDevice?.needsDeviceAccessEntitlement === true;
  const blockedAccessReason = protectedUsbAccessRequired
    ? 'macOS also says protected USB access is required before this app can open the MTP file session.'
    : 'The USB connection is visible, but the MTP OpenSession handshake did not complete.';
  const fileTransferInactive =
    !!rawDevice &&
    !device &&
    !isScanning &&
    (rawDevice.connectionMode === 'usb-only' ||
      status?.message.toLowerCase().includes('file transfer is not active'));
  const noPhoneConnection =
    !rawDevice &&
    !device &&
    !isScanning &&
    (inventory?.state === 'no-device' || status?.state === 'no-device');
  const cannotOpenPhone =
    !!rawDevice &&
    !device &&
    !isScanning &&
    !fileTransferInactive &&
    (inventory?.state === 'connect-error' ||
      inventory?.state === 'error' ||
      inventory?.ok === false ||
      !!recoveryResult);
  const diagnosticText = `${inventory?.stderr ?? ''}\n${status?.stderr ?? ''}`.toLowerCase();
  const usbAccessDenied =
    cannotOpenPhone &&
    (visibleMtpSessionNotOpen ||
      rawMtpVisible ||
      diagnosticText.includes('libusb_claim_interface') ||
      diagnosticText.includes('libusb_error_access') ||
      diagnosticText.includes('access denied'));
  const statusMessage = inventory?.message ?? status?.message ?? 'Checking MTP status...';
  const hasDevice = inventory?.state === 'connected' && !!device;
  const resolvedTheme = themeMode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeMode;
  const canCreatePhoneFolder = hasDevice && location.storageId !== null;
  const protectedAccessOpen = hasDevice && !!device?.protectedAccess;
  const fileSessionOpen = hasDevice || !!status?.sessionOpen;
  const storageFailure = fileSessionOpen && inventoryLooksLikeStorageFailure(inventory);
  const currentFolderName = location.crumbs[location.crumbs.length - 1]?.label ?? 'folder';
  const macDestinationLabel = folderLabelForPath(localPath || destination);
  const phoneDestinationLabel = location.storageId === null ? 'Phone folder' : currentFolderName;
  const phoneSelectionIsFilesOnly =
    selectedTransferRows.length > 0 && selectedTransferRows.every((row) => row.kind === 'file');
  const macSelectionIsFilesOnly =
    selectedLocalEntries.length > 0 && selectedLocalEntries.every((entry) => entry.kind === 'file');
  const canRunPhoneTransfer =
    selectedTransferRows.length > 0 &&
    hasDevice &&
    (phoneTransferOperation === 'copy' || phoneSelectionIsFilesOnly);
  const canRunMacTransfer =
    selectedLocalEntries.length > 0 &&
    canUploadToCurrentFolder &&
    (macTransferOperation === 'copy' || macSelectionIsFilesOnly);
  const browserLoading = isScanning || folderLoading;
  const browserLoadingTitle = folderLoading ? `Listing ${currentFolderName}` : 'Checking phone';
  const browserLoadingDetails = folderLoading
    ? 'Large photo or video folders can take 30 seconds or more. Keep the phone unlocked.'
    : 'This can take a moment. Keep the phone unlocked and set to File Transfer.';
  const currentLocationSummary = useMemo(() => {
    if (!hasDevice) {
      return '';
    }

    if (location.storageId === null) {
      const storages = device?.storages ?? [];
      const knownTotal = storages.reduce(
        (total, storage) => total + Math.max(storage.maxCapacity || 0, 0),
        0
      );
      const base = pluralize(visibleLocationRows.length, 'storage location');
      return knownTotal > 0 ? `${base} · ${formatBytes(knownTotal)} total` : base;
    }

    const visibleFolderObjects = visibleLocationRows.flatMap((row) => (row.object ? [row.object] : []));
    const baseSummary = summarizePhoneObjects(visibleFolderObjects);
    const normalizedQuery = query.trim();
    if (normalizedQuery && rows.length !== visibleLocationRows.length) {
      return `Showing ${pluralize(rows.length, 'item')} of ${baseSummary}`;
    }
    return baseSummary;
  }, [device?.storages, hasDevice, location.storageId, query, rows.length, visibleLocationRows]);
  const connectionStages = useMemo<ConnectionStageItem[]>(() => {
    const cableDone = !!rawDevice || hasDevice;
    const fileTransferDone = hasDevice || rawDevice?.connectionMode === 'mtp';
    const fileSessionDone = hasDevice || !!status?.sessionOpen;
    const storageDone = hasDevice && !!device?.storages.length;
    const folderDone = hasDevice && location.storageId !== null && !currentFolderError && !folderLoading;

    return [
      {
        key: 'cable',
        label: 'Cable',
        detail: cableDone
          ? `${rawDeviceName} is visible to this Mac.`
          : isScanning
            ? 'Checking the USB connection.'
            : 'Connect the phone with a data cable.',
        state: cableDone ? 'done' : isScanning ? 'current' : 'blocked'
      },
      {
        key: 'mode',
        label: 'File transfer',
        detail: fileTransferDone
          ? 'The phone is in File Transfer mode.'
          : fileTransferInactive
            ? 'Choose File transfer in the phone USB notification.'
            : 'Waiting for the phone to expose files.',
        state: fileTransferDone ? 'done' : fileTransferInactive ? 'blocked' : 'waiting'
      },
      {
        key: 'session',
        label: 'Open files',
        detail: fileSessionDone
          ? protectedAccessOpen
            ? 'The protected phone-file session is open.'
            : 'The phone-file session is open.'
          : isRecovering
            ? 'Opening the protected phone-file session.'
            : usbAccessDenied
              ? 'Press Open files, then enter your Mac login password.'
              : 'Waiting for Android to allow file access.',
        state: fileSessionDone ? 'done' : isRecovering || usbAccessDenied ? 'current' : 'waiting'
      },
      {
        key: 'storage',
        label: 'Storage',
        detail: storageDone
          ? `${pluralize(device?.storages.length ?? 0, 'storage location')} ready.`
          : storageFailure
            ? 'The file session opened, but the phone did not return storage information.'
            : 'Waiting for the storage list.',
        state: storageDone ? 'done' : storageFailure ? 'blocked' : fileSessionDone ? 'current' : 'waiting'
      },
      {
        key: 'folder',
        label: 'Folder list',
        detail: folderDone
          ? currentLocationSummary || 'Folder contents are ready.'
          : folderLoading
            ? 'Listing this folder. Large folders can take a while.'
            : currentFolderError
              ? currentFolderError
              : 'Open Internal storage to list folders.',
        state: folderDone ? 'done' : folderLoading ? 'current' : currentFolderError ? 'blocked' : 'waiting'
      }
    ];
  }, [
    currentFolderError,
    currentLocationSummary,
    device?.storages.length,
    fileTransferInactive,
    folderLoading,
    hasDevice,
    isRecovering,
    isScanning,
    location.storageId,
    protectedAccessOpen,
    rawDevice,
    rawDeviceName,
    status?.sessionOpen,
    storageFailure,
    usbAccessDenied
  ]);
  const phoneSelectionSummary = summarizePhoneSelection(selectedRows);
  const phoneSelectionGuidance = selectedRows.length
    ? selectedTransferRows.length
      ? 'Use Copy to Mac, Cmd+C then Cmd+V, or drag selected files directly to a destination.'
      : 'Double-click the selected storage to open it.'
    : 'Click to select. Double-click folders or storage to open them.';
  const localSelectionSummary = summarizeLocalSelection(selectedLocalEntries);
  const localSelectionGuidance = selectedLocalEntries.length
    ? canUploadToCurrentFolder
      ? 'Use Copy to Phone, Cmd+C then Cmd+V, right-click, or drag from the Mac pane.'
      : 'Open Internal storage or a phone folder before copying to the phone.'
    : canUploadToCurrentFolder
      ? 'Select Mac items or drag them to the phone pane.'
      : 'Open Internal storage or a phone folder before copying.';
  const localSelectionStatus = selectedLocalEntries.length
    ? `${localSelectionSummary}. ${localSelectionGuidance}`
    : localSelectionGuidance;
  const activePaneHasTransferSelection =
    activePane === 'mac' ? selectedLocalEntries.length > 0 : selectedTransferRows.length > 0;

  async function refreshStatus(): Promise<DeviceStatus> {
    const nextStatus = await window.mtp.getStatus();
    setStatus(nextStatus);
    return nextStatus;
  }

  function updateInventory(nextInventory: InventoryResult): void {
    inventoryRef.current = nextInventory;
    setInventory(nextInventory);
    setSelectedDeviceConnectionId((currentConnectionId) =>
      nextInventory.devices.some((candidate) => candidate.connectionId === currentConnectionId)
        ? currentConnectionId
        : nextInventory.devices[0]?.connectionId ?? null
    );
  }

  function inventoryFromStatus(nextStatus: DeviceStatus): InventoryResult {
    return {
      ok: false,
      state: nextStatus.state,
      message: nextStatus.message,
      devices: [],
      helperPath: nextStatus.helperPath,
      logPath: nextStatus.logPath,
      stderr: nextStatus.stderr
    };
  }

  function resetPhoneBrowserState(): void {
    setLocation(rootLocation);
    setSelectedKeys(new Set());
    phoneSelectionAnchorKey.current = null;
    setBackStack([]);
    setForwardStack([]);
    setFolderCache({});
    setFolderErrors({});
    setLoadingFolderKeys(new Set());
    folderLoadTokens.current = {};
    downloadFolderPlans.current = {};
    setPhoneDownloadPlanning(null);
    phoneDownloadPlanningCancelRequested.current = false;
  }

  function resetBrowserToInventory(nextInventory: InventoryResult): void {
    if (!nextInventory.protectedAccess) {
      protectedAccessRawKey.current = null;
      protectedAccessDeviceIdentityKey.current = null;
      protectedAccessConnectionId.current = null;
    }
    updateInventory(nextInventory);
    resetPhoneBrowserState();
  }

  function clearDeviceFromStatus(nextStatus: DeviceStatus): void {
    protectedAccessRawKey.current = null;
    protectedAccessDeviceIdentityKey.current = null;
    protectedAccessConnectionId.current = null;
    setSelectedDeviceConnectionId(null);
    updateInventory(inventoryFromStatus(nextStatus));
    resetPhoneBrowserState();
  }

  function clearStalePhoneStateForNewAttachment(nextStatus: DeviceStatus): void {
    protectedAccessRawKey.current = null;
    protectedAccessDeviceIdentityKey.current = null;
    protectedAccessConnectionId.current = null;
    lastAutoRawKey.current = null;
    setRecoveryResult(null);
    setTransferNotice(null);
    setPhoneDownloadPlanning(null);
    phoneDownloadPlanningCancelRequested.current = false;
    updateInventory(inventoryFromStatus(nextStatus));
    resetPhoneBrowserState();
  }

  function showBlockedAutoScanStatus(nextStatus: DeviceStatus): void {
    protectedAccessRawKey.current = null;
    protectedAccessDeviceIdentityKey.current = null;
    protectedAccessConnectionId.current = null;
    const nextInventory: InventoryResult = {
      ok: false,
      state: 'connect-error',
      message: NORMAL_ACCESS_BLOCKED_MESSAGE,
      devices: [],
      helperPath: nextStatus.helperPath,
      logPath: nextStatus.logPath,
      stderr: nextStatus.stderr
    };
    updateInventory(nextInventory);
    resetPhoneBrowserState();
  }

  function statusMatchesProtectedSession(nextStatus: DeviceStatus): boolean {
    const connectionId = protectedAccessConnectionId.current;
    const currentInventory = inventoryRef.current;
    const openConnections = statusSessionConnectionIds(nextStatus);
    const visibleConnections = nextStatus.rawDevices
      .filter((candidate) => candidate.connectionMode !== 'usb-only')
      .map(rawDeviceConnectionKey)
      .filter((candidate): candidate is string => !!candidate);
    const protectedSessionMatches =
      !!connectionId &&
      openConnections.has(connectionId);

    return (
      protectedSessionMatches &&
      !!nextStatus.protectedSessionOpen &&
      currentInventory?.state === 'connected' &&
      currentInventory.devices.some(
        (candidate) => candidate.connectionId === connectionId && candidate.protectedAccess
      ) &&
      visibleConnections.every((visibleConnection) =>
        currentInventory.devices.some((candidate) => candidate.connectionId === visibleConnection)
      )
    );
  }

  function statusMatchesOpenSession(nextStatus: DeviceStatus): boolean {
    const currentInventory = inventoryRef.current;
    const openConnections = statusSessionConnectionIds(nextStatus);
    const visibleConnections = nextStatus.rawDevices
      .filter((candidate) => candidate.connectionMode !== 'usb-only')
      .map(rawDeviceConnectionKey)
      .filter((candidate): candidate is string => !!candidate);
    return (
      !!nextStatus.sessionOpen &&
      openConnections.size > 0 &&
      currentInventory?.state === 'connected' &&
      currentInventory.devices.some((candidate) => openConnections.has(candidate.connectionId)) &&
      visibleConnections.every((visibleConnection) =>
        currentInventory.devices.some((candidate) => candidate.connectionId === visibleConnection)
      )
    );
  }

  function clearAutomaticScanFailures(): void {
    if (!blockedAutoDeviceKeys.current.size) {
      return;
    }
    blockedAutoDeviceKeys.current.clear();
    writeBlockedAutoDeviceKeys(blockedAutoDeviceKeys.current);
  }

  function rememberAutomaticScanFailure(nextStatus: DeviceStatus): void {
    nextStatus.rawDevices.forEach((candidate) => {
      const connectionKey = rawDeviceConnectionKey(candidate);
      if (connectionKey && candidate.usbSessionId) {
        blockedAutoDeviceKeys.current.add(`connection:${connectionKey}`);
      }
      rawDeviceAutomaticBlockKeys(candidate).forEach((key) => blockedAutoDeviceKeys.current.add(key));
    });
    writeBlockedAutoDeviceKeys(blockedAutoDeviceKeys.current);
  }

  function forgetAutomaticScanFailure(nextStatus: DeviceStatus): void {
    let changed = false;
    nextStatus.rawDevices.forEach((candidate) => {
      const connectionKey = rawDeviceConnectionKey(candidate);
      if (connectionKey && candidate.usbSessionId) {
        changed = blockedAutoDeviceKeys.current.delete(`connection:${connectionKey}`) || changed;
      }
      rawDeviceAutomaticBlockKeys(candidate).forEach((key) => {
        changed = blockedAutoDeviceKeys.current.delete(key) || changed;
      });
    });
    if (!changed) {
      return;
    }
    writeBlockedAutoDeviceKeys(blockedAutoDeviceKeys.current);
  }

  function trackVisibleDeviceIdentity(nextStatus: DeviceStatus): void {
    const visibleConnections = new Set(
      nextStatus.rawDevices
        .map(rawDeviceConnectionKey)
        .filter((connectionKey): connectionKey is string => !!connectionKey)
    );
    const trackedConnection =
      selectedDeviceConnectionId ?? protectedAccessConnectionId.current ?? lastVisibleConnectionKey.current;
    if (!visibleConnections.size) {
      lastAutoDeviceIdentityKey.current = null;
      lastVisibleConnectionKey.current = null;
      return;
    }

    if (trackedConnection && !visibleConnections.has(trackedConnection)) {
      clearAutomaticScanFailures();
      clearStalePhoneStateForNewAttachment(nextStatus);
    }
    const nextTrackedConnection =
      (selectedDeviceConnectionId && visibleConnections.has(selectedDeviceConnectionId)
        ? selectedDeviceConnectionId
        : null) ??
      Array.from(visibleConnections)[0];
    const trackedRawDevice = nextStatus.rawDevices.find(
      (candidate) => rawDeviceConnectionKey(candidate) === nextTrackedConnection
    );
    lastAutoDeviceIdentityKey.current = rawDeviceStableIdentityKey(trackedRawDevice);
    lastVisibleConnectionKey.current = nextTrackedConnection;
  }

  function automaticScanBlocked(nextStatus: DeviceStatus): boolean {
    const candidates = nextStatus.rawDevices.filter(
      (candidate) => candidate.connectionMode !== 'usb-only'
    );
    return (
      candidates.length > 0 &&
      candidates.every((candidate) => {
        const connectionKey = rawDeviceConnectionKey(candidate);
        if (
          connectionKey &&
          candidate.usbSessionId &&
          blockedAutoDeviceKeys.current.has(`connection:${connectionKey}`)
        ) {
          return true;
        }
        return rawDeviceAutomaticBlockKeys(candidate).some((key) =>
          blockedAutoDeviceKeys.current.has(key)
        );
      })
    );
  }

  async function scanDevice(options: { automatic?: boolean; manual?: boolean } = {}): Promise<void> {
    const manual = options.manual === true;
    if (recoveryInFlight.current) {
      if (manual) {
        setRefreshFeedback({
          phase: 'checking',
          message: 'Already opening phone files. Finish the Mac password prompt first.'
        });
      }
      return;
    }

    if (scanInFlight.current) {
      if (manual) {
        setRefreshFeedback({
          phase: 'checking',
          message: 'Already checking. Keep the phone unlocked.'
        });
      }
      return;
    }

    scanInFlight.current = true;
    setIsScanning(true);
    setRecoveryResult(null);
    let manualStatus: DeviceStatus | null = null;
    let manualInventory: InventoryResult | null = null;
    let openSessionKept = false;
    let manualFailed = false;
    if (manual) {
      setRefreshFeedback({
        phase: 'checking',
        message: 'Checking phone now...'
      });
    }
    try {
      const nextStatus = await refreshStatus();
      manualStatus = nextStatus;
      trackVisibleDeviceIdentity(nextStatus);
      if (statusMatchesProtectedSession(nextStatus) || statusMatchesOpenSession(nextStatus)) {
        openSessionKept = true;
        return;
      }

      if (nextStatus.state !== 'connected') {
        lastAutoRawKey.current = null;
        if (nextStatus.state === 'no-device') {
          clearAutomaticScanFailures();
        }
        clearDeviceFromStatus(nextStatus);
        return;
      }

      const rawKey = statusAttachmentSetKey(nextStatus);
      if (!options.automatic) {
        clearAutomaticScanFailures();
      } else if (automaticScanBlocked(nextStatus)) {
        lastAutoRawKey.current = rawKey;
        showBlockedAutoScanStatus(nextStatus);
        return;
      }

      const nextInventory = await window.mtp.scanInventory();
      manualInventory = nextInventory;
      if (!nextInventory.protectedAccess && statusMatchesOpenSession(nextStatus)) {
        openSessionKept = true;
        return;
      }

      lastAutoRawKey.current = rawKey;
      if (nextInventory.ok) {
        forgetAutomaticScanFailure(nextStatus);
      } else {
        rememberAutomaticScanFailure(nextStatus);
      }
      resetBrowserToInventory(nextInventory);
    } catch (error) {
      manualFailed = true;
      console.error(error);
      if (manual) {
        setRefreshFeedback({
          phase: 'failed',
          message: 'Check failed. Open the log for details.'
        });
      }
    } finally {
      scanInFlight.current = false;
      setIsScanning(false);
      if (manual && !manualFailed) {
        setRefreshFeedback({
          phase: 'done',
          message: refreshResultMessage(
            manualStatus,
            manualInventory ?? inventoryRef.current,
            openSessionKept
          )
        });
      }
    }
  }

  async function handleManualRefresh(): Promise<void> {
    await scanDevice({ manual: true });
  }

  async function pollForPhone(): Promise<void> {
    if (scanInFlight.current || pollInFlight.current) {
      return;
    }

    pollInFlight.current = true;
    try {
      const nextStatus = await refreshStatus();
      const rawKey = statusAttachmentSetKey(nextStatus);
      trackVisibleDeviceIdentity(nextStatus);
      if (statusMatchesOpenSession(nextStatus)) {
        return;
      }
      if (nextStatus.state !== 'connected') {
        if (statusMatchesProtectedSession(nextStatus)) {
          return;
        }
        lastAutoRawKey.current = null;
        if (nextStatus.state === 'no-device') {
          clearAutomaticScanFailures();
        }
        const currentInventory = inventoryRef.current;
        const hasStaleInventory =
          !currentInventory ||
          currentInventory.state !== nextStatus.state ||
          currentInventory.message !== nextStatus.message ||
          currentInventory.devices.length > 0 ||
          currentInventory.stderr !== nextStatus.stderr;
        if (hasStaleInventory) {
          clearDeviceFromStatus(nextStatus);
        }
        return;
      }

      const currentInventory = inventoryRef.current;
      if (automaticScanBlocked(nextStatus)) {
        const blockedInventoryIsVisible =
          currentInventory?.state === 'connect-error' &&
          currentInventory.message === NORMAL_ACCESS_BLOCKED_MESSAGE;
        if (!blockedInventoryIsVisible) {
          showBlockedAutoScanStatus(nextStatus);
        }
        return;
      }

      const needsInventory =
        !!rawKey &&
        (rawKey !== lastAutoRawKey.current ||
          currentInventory?.state !== 'connected' ||
          !currentInventory.devices.length);

      if (needsInventory) {
        lastAutoRawKey.current = rawKey;
        await scanDevice({ automatic: true });
      }
    } catch (error) {
      console.error(error);
    } finally {
      pollInFlight.current = false;
    }
  }

  async function loadFolder(storageId: number, parentId: number, force = false): Promise<void> {
    if (!device) {
      return;
    }

    const key = folderKey(device.connectionId, storageId, parentId);
    if (!force && folderCache[key]) {
      return;
    }

    const requestToken = `${Date.now()}:${Math.random()}`;
    folderLoadTokens.current[key] = requestToken;
    setFolderListProgress((current) => (current?.key === key ? null : current));
    setLoadingFolderKeys((current) => new Set(current).add(key));
    setFolderErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    try {
      const result = await window.mtp.listFolder(
        device.index,
        device.connectionId,
        storageId,
        parentId
      );
      if (folderLoadTokens.current[key] !== requestToken) {
        return;
      }
      if (result.ok) {
        setFolderCache((current) => ({ ...current, [key]: result.objects }));
      } else {
        setFolderErrors((current) => ({ ...current, [key]: result.message }));
        setFolderCache((current) => ({ ...current, [key]: [] }));
      }
    } catch (error) {
      if (folderLoadTokens.current[key] !== requestToken) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Unable to list this folder.';
      setFolderErrors((current) => ({ ...current, [key]: message }));
      setFolderCache((current) => ({ ...current, [key]: [] }));
    } finally {
      if (folderLoadTokens.current[key] !== requestToken) {
        return;
      }
      delete folderLoadTokens.current[key];
      setLoadingFolderKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setFolderListProgress((current) => (current?.key === key ? null : current));
    }
  }

  async function stopFolderListing(): Promise<void> {
    if (!currentFolderKey || !folderLoading) {
      return;
    }

    delete folderLoadTokens.current[currentFolderKey];
    setLoadingFolderKeys((current) => {
      const next = new Set(current);
      next.delete(currentFolderKey);
      return next;
    });
    setFolderErrors((current) => ({
      ...current,
      [currentFolderKey]: 'Folder listing stopped. Open another folder, press Retry, or check the phone again.'
    }));

    try {
      await window.mtp.cancelFolderListing();
    } catch (error) {
      setFolderErrors((current) => ({
        ...current,
        [currentFolderKey]: error instanceof Error ? error.message : 'Unable to stop folder listing.'
      }));
    }
  }

  async function stopPhoneDownloadPlanning(): Promise<void> {
    if (!phoneDownloadPlanning) {
      return;
    }

    phoneDownloadPlanningCancelRequested.current = true;
    setPhoneDownloadPlanning(null);
    setTransferNotice({
      phase: 'failed',
      message: folderCopyPlanningStoppedMessage()
    });

    try {
      await window.mtp.cancelFolderListing();
    } catch (error) {
      setTransferNotice({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Unable to stop folder copy preparation.'
      });
    }
  }

  async function loadLocalDirectory(
    directoryPath?: string,
    options: { showHidden?: boolean } = {}
  ): Promise<LocalDirectoryResult | null> {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const result = await window.mtp.listLocalDirectory(
        directoryPath,
        options.showHidden ?? showHiddenFiles
      );
      setLocalPath(result.path);
      setLocalParentPath(result.parentPath);
      setLocalEntries(result.entries);
      setSelectedLocalPaths(new Set());
      localSelectionAnchorPath.current = null;
      if (result.ok) {
        setDestination(result.path);
      } else {
        setLocalError(result.message);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to list this Mac folder.';
      setLocalError(message);
      setLocalEntries([]);
      setSelectedLocalPaths(new Set());
      localSelectionAnchorPath.current = null;
      return null;
    } finally {
      setLocalLoading(false);
    }
  }

  async function navigateLocalDirectory(directoryPath: string): Promise<void> {
    if (!directoryPath || directoryPath === localPath) {
      return;
    }
    const previousPath = localPath;
    const result = await loadLocalDirectory(directoryPath);
    if (result?.ok && previousPath && previousPath !== result.path) {
      setLocalBackStack((stack) => [...stack, previousPath]);
      setLocalForwardStack([]);
    }
  }

  async function goBackLocalDirectory(): Promise<void> {
    const previousPath = localBackStack[localBackStack.length - 1];
    if (!previousPath) {
      return;
    }
    const currentPath = localPath;
    const result = await loadLocalDirectory(previousPath);
    if (result?.ok) {
      setLocalBackStack((stack) => stack.slice(0, -1));
      if (currentPath) {
        setLocalForwardStack((stack) => [currentPath, ...stack]);
      }
    }
  }

  async function goForwardLocalDirectory(): Promise<void> {
    const nextPath = localForwardStack[0];
    if (!nextPath) {
      return;
    }
    const currentPath = localPath;
    const result = await loadLocalDirectory(nextPath);
    if (result?.ok) {
      setLocalForwardStack((stack) => stack.slice(1));
      if (currentPath) {
        setLocalBackStack((stack) => [...stack, currentPath]);
      }
    }
  }

  async function goUpLocalDirectory(): Promise<void> {
    if (localParentPath && localParentPath !== localPath) {
      await navigateLocalDirectory(localParentPath);
    }
  }

  async function chooseMacFolder(): Promise<void> {
    const result = await window.mtp.chooseDestination();
    if (result.canceled || !result.path) {
      return;
    }
    await navigateLocalDirectory(result.path);
    setTransferNotice({
      phase: 'ready',
      message: 'Mac folder selected. Phone files copied to Mac will use this folder.'
    });
  }

  async function planLocalEntriesForUpload(
    entries: LocalEntry[],
    storageId: number,
    parentId: number,
    operation: TransferOperation = 'copy'
  ): Promise<PhoneUploadPlan> {
    if (!device) {
      return { requests: [], folderCount: 0, conflictCount: 0 };
    }

    const activeDevice = device;
    const requests: UploadRequest[] = [];
    const visitedFolders = new Set<string>();
    const phoneFolderObjects = new Map<number, MtpObject[]>();
    let folderCount = 0;
    let conflictCount = 0;

    async function listPhoneFolderObjects(destinationParentId: number): Promise<MtpObject[]> {
      const cached = phoneFolderObjects.get(destinationParentId);
      if (cached) {
        return cached;
      }

      if (destinationParentId === location.folderId && currentFolderKey && folderCache[currentFolderKey]) {
        const currentObjects = folderCache[currentFolderKey];
        phoneFolderObjects.set(destinationParentId, currentObjects);
        return currentObjects;
      }

      const result = await window.mtp.listFolder(
        activeDevice.index,
        activeDevice.connectionId,
        storageId,
        destinationParentId
      );
      if (!result.ok) {
        throw new Error(result.message || 'Could not check the destination phone folder for name conflicts.');
      }
      const objects = result.objects;
      phoneFolderObjects.set(destinationParentId, objects);
      return objects;
    }

    async function ensurePhoneFolder(entry: LocalEntry, destinationParentId: number): Promise<number | null> {
      const existingObjects = await listPhoneFolderObjects(destinationParentId);
      const existing = existingObjects.find((object) => object.name === entry.name);
      if (existing?.kind === 'folder') {
        folderCount += 1;
        return existing.id;
      }
      if (existing?.kind === 'file') {
        conflictCount += 1;
        return null;
      }

      const created = await window.mtp.createFolder({
        deviceIndex: activeDevice.index,
        deviceConnectionId: activeDevice.connectionId,
        storageId,
        parentId: destinationParentId,
        name: entry.name
      });
      if (!created.ok || !created.folderId) {
        throw new Error(created.message || `Could not create ${entry.name} on the phone.`);
      }
      folderCount += 1;
      phoneFolderObjects.set(destinationParentId, [
        ...existingObjects,
        {
          id: created.folderId,
          parentId: destinationParentId,
          storageId,
          name: entry.name,
          kind: 'folder',
          size: 0,
          modified: 0,
          filetype: 'Folder'
        }
      ]);
      return created.folderId;
    }

    async function collect(entry: LocalEntry, destinationParentId: number, depth = 0): Promise<void> {
      if (requests.length >= MAX_PLANNED_MAC_FILES) {
        throw new Error(`Selection is too large to plan at once. Try fewer than ${MAX_PLANNED_MAC_FILES} files.`);
      }
      if (depth > MAX_PLANNED_MAC_DEPTH) {
        throw new Error(`A selected Mac folder is nested more than ${MAX_PLANNED_MAC_DEPTH} levels deep.`);
      }

      if (entry.kind === 'file') {
        const existingObjects = await listPhoneFolderObjects(destinationParentId);
        const existing = existingObjects.find((object) => object.name === entry.name);
        if (existing) {
          conflictCount += 1;
          return;
        }

        requests.push({
          deviceIndex: activeDevice.index,
          deviceConnectionId: activeDevice.connectionId,
          storageId,
          parentId: destinationParentId,
          sourcePath: entry.path,
          name: entry.name,
          size: entry.size,
          operation
        });
        return;
      }

      if (visitedFolders.has(entry.path)) {
        return;
      }
      if (visitedFolders.size >= MAX_PLANNED_MAC_FOLDERS) {
        throw new Error(`Selection contains more than ${MAX_PLANNED_MAC_FOLDERS} folders. Choose a smaller set.`);
      }
      visitedFolders.add(entry.path);

      const folderId = await ensurePhoneFolder(entry, destinationParentId);
      if (folderId === null) {
        return;
      }
      const localFolder = await window.mtp.listLocalDirectory(entry.path, showHiddenFiles);
      if (!localFolder.ok) {
        throw new Error(localFolder.message || `Could not read ${entry.name} on the Mac.`);
      }

      for (const child of localFolder.entries) {
        await collect(child, folderId, depth + 1);
      }
    }

    for (const entry of entries) {
      await collect(entry, parentId);
    }

    return { requests, folderCount, conflictCount };
  }

  async function copyLocalFilesToPhone(
    fileEntries = selectedLocalEntries,
    operation: TransferOperation = 'copy'
  ): Promise<void> {
    if (!canUploadToCurrentFolder || !device) {
      setTransferNotice({
        phase: 'failed',
        message: 'Open Internal storage or a phone folder before copying Mac files or folders to the phone.'
      });
      return;
    }

    if (!fileEntries.length) {
      return;
    }

    if (operation === 'move' && fileEntries.some((entry) => entry.kind !== 'file')) {
      setTransferNotice({
        phase: 'failed',
        message: 'Move works with files only. Choose Copy for folders.'
      });
      return;
    }

    const storageId = location.storageId;
    if (storageId === null) {
      return;
    }

    const includesFolder = fileEntries.some((entry) => entry.kind === 'folder');
    if (includesFolder) {
      setTransferNotice({
        phase: 'queued',
        message: 'Preparing phone folders. Large folders can take a moment before file progress starts.'
      });
    }

    try {
      const { requests, folderCount, conflictCount } = await planLocalEntriesForUpload(
        fileEntries,
        storageId,
        location.folderId,
        operation
      );
      if (folderCount > 0) {
        void loadFolder(storageId, location.folderId, true);
      }

      if (!requests.length) {
        const skipSummary = uploadSkipSummary(conflictCount);
        setTransferNotice({
          phase: conflictCount > 0 ? 'failed' : folderCount > 0 ? 'ready' : 'failed',
          message:
            skipSummary
              ? skipSummary
              : folderCount > 0
                ? 'Folder created on the phone. It did not contain files to upload.'
                : 'No Mac files were queued.'
        });
        return;
      }

      const moveResult =
        operation === 'move' ? await window.mtp.startMoveUploads(requests) : null;
      if (moveResult && !moveResult.confirmed) {
        setTransferNotice({
          phase: 'ready',
          message: 'Move canceled. Nothing was deleted.'
        });
        return;
      }
      const queued = moveResult?.jobs ?? (await window.mtp.startUploads(requests));
      const skipSummary = uploadSkipSummary(conflictCount);
      setJobs((currentJobs) => mergeTransferJobs(currentJobs, queued));
      setTransferNotice({
        phase: queued.length ? 'queued' : 'failed',
        message: queued.length
          ? `${queued.length} ${queued.length === 1 ? 'file' : 'files'} will be ${operation === 'move' ? 'moved' : 'copied'} to this phone folder.${skipSummary ? ` ${skipSummary}` : ''}`
          : 'No Mac files were queued.'
      });
    } catch (error) {
      setTransferNotice({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Unable to prepare that Mac folder.'
      });
    }
  }

  function toggleLocalSelection(entry: LocalEntry, additive: boolean, range: boolean): void {
    if (range && localSelectionAnchorPath.current) {
      const anchorIndex = sortedLocalEntries.findIndex((candidate) => candidate.path === localSelectionAnchorPath.current);
      const nextIndex = sortedLocalEntries.findIndex((candidate) => candidate.path === entry.path);
      if (anchorIndex >= 0 && nextIndex >= 0) {
        const [start, end] = anchorIndex <= nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
        const rangePaths = sortedLocalEntries.slice(start, end + 1).map((candidate) => candidate.path);
        setSelectedLocalPaths((current) => {
          const next = additive ? new Set(current) : new Set<string>();
          rangePaths.forEach((path) => next.add(path));
          return next;
        });
        setActivePane('mac');
        return;
      }
    }

    localSelectionAnchorPath.current = entry.path;
    setSelectedLocalPaths((current) => {
      if (!additive) {
        return new Set([entry.path]);
      }
      const next = new Set(current);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      return next;
    });
  }

  function selectAllLocalEntries(): void {
    setSelectedLocalPaths(new Set(sortedLocalEntries.map((entry) => entry.path)));
    localSelectionAnchorPath.current = sortedLocalEntries[0]?.path ?? null;
    setActivePane('mac');
  }

  function moveLocalSelection(delta: number, extend: boolean): void {
    if (!sortedLocalEntries.length) {
      return;
    }

    const selectedIndices = sortedLocalEntries
      .map((entry, index) => (selectedLocalPaths.has(entry.path) ? index : -1))
      .filter((index) => index >= 0);
    const currentIndex =
      selectedIndices.length > 0
        ? delta >= 0
          ? selectedIndices[selectedIndices.length - 1]
          : selectedIndices[0]
        : delta >= 0
          ? -1
          : sortedLocalEntries.length;
    const nextIndex = Math.min(sortedLocalEntries.length - 1, Math.max(0, currentIndex + delta));
    const nextPaths = extend ? new Set(selectedLocalPaths) : new Set<string>();
    nextPaths.add(sortedLocalEntries[nextIndex].path);
    setSelectedLocalPaths(nextPaths);
    if (!extend || !localSelectionAnchorPath.current) {
      localSelectionAnchorPath.current = sortedLocalEntries[nextIndex].path;
    }
    setActivePane('mac');
  }

  function openSelectedLocalEntry(): void {
    const entry =
      selectedLocalEntries.length === 1
        ? selectedLocalEntries[0]
        : sortedLocalEntries.find((candidate) => selectedLocalPaths.has(candidate.path));
    if (entry) {
      openLocalEntry(entry);
    } else if (sortedLocalEntries[0]) {
      setSelectedLocalPaths(new Set([sortedLocalEntries[0].path]));
      localSelectionAnchorPath.current = sortedLocalEntries[0].path;
    }
  }

  function goUpActivePane(): void {
    if (activePane === 'mac') {
      void goUpLocalDirectory();
      return;
    }

    goUp();
  }

  function copyActivePaneSelectionToQueue(): void {
    if (activePane === 'mac') {
      if (!selectedLocalEntries.length) {
        return;
      }
      void copyLocalFilesToPhone();
      return;
    }

    if (!selectedTransferRows.length) {
      return;
    }
    void copySelectedToMac();
  }

  function copyActivePaneSelectionToClipboard(): void {
    if (activePane === 'mac') {
      if (!selectedLocalEntries.length) {
        return;
      }

      const entries = selectedLocalEntries.map((entry) => ({ ...entry }));
      setTransferClipboard({
        source: 'mac',
        entries,
        label: summarizeLocalSelection(entries)
      });
      setTransferNotice({
        phase: 'ready',
        message: `${pluralize(entries.length, 'Mac item')} copied. Open a phone folder, then press Cmd+V to queue it.`
      });
      return;
    }

    if (!selectedTransferRows.length) {
      return;
    }

    if (!device) {
      setTransferNotice({
        phase: 'failed',
        message: 'The phone disconnected before those files could be copied.'
      });
      return;
    }

    const rowsToCopy = selectedTransferRows.map((row) => ({
      ...row,
      object: row.object ? { ...row.object } : undefined,
      storage: row.storage ? { ...row.storage } : undefined
    }));
    setTransferClipboard({
      source: 'phone',
      deviceIndex: device.index,
      deviceConnectionId: device.connectionId,
      rows: rowsToCopy,
      label: summarizePhoneSelection(rowsToCopy)
    });
    setTransferNotice({
      phase: 'ready',
      message: `${pluralize(rowsToCopy.length, 'phone item')} copied. Press Cmd+V to queue it to the Mac pane.`
    });
  }

  async function pasteTransferClipboard(): Promise<void> {
    if (!transferClipboard) {
      setTransferNotice({
        phase: 'failed',
        message: 'Copy phone or Mac files first, then paste.'
      });
      return;
    }

    if (transferClipboard.source === 'mac') {
      if (!canUploadToCurrentFolder || !device) {
        setTransferNotice({
          phase: 'failed',
          message: 'Open Internal storage or a phone folder before pasting Mac files to the phone.'
        });
        return;
      }
      await copyLocalFilesToPhone(transferClipboard.entries);
      return;
    }

    const sourceStillVisible = inventoryDevices.some(
      (candidate) => candidate.connectionId === transferClipboard.deviceConnectionId
    );
    if (!sourceStillVisible) {
      setTransferNotice({
        phase: 'failed',
        message: 'The phone used for that copied selection is no longer connected. Copy the files again.'
      });
      return;
    }

    await copyRowsToMac(
      transferClipboard.rows,
      transferClipboard.deviceIndex,
      transferClipboard.deviceConnectionId
    );
  }

  function focusPhonePane(): void {
    setActivePane('phone');
    phoneBrowserRef.current?.focus();
  }

  function focusMacPane(): void {
    setActivePane('mac');
    localListRef.current?.focus();
  }

  function toggleHiddenFiles(): void {
    const nextValue = !showHiddenFiles;
    setShowHiddenFiles(nextValue);
    void loadLocalDirectory(localPath || undefined, { showHidden: nextValue });
    setTransferNotice({
      phase: 'ready',
      message: nextValue ? 'Hidden files are visible.' : 'Hidden files are hidden.'
    });
  }

  async function copyDiagnosticReport(): Promise<void> {
    if (diagnosticsBusy) {
      return;
    }

    setDiagnosticsBusy(true);
    try {
      const result = await window.mtp.copyDiagnostics();
      setTransferNotice({
        phase: result.copied ? 'ready' : 'failed',
        message: result.message
      });
    } catch (error) {
      setTransferNotice({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Could not copy the connection report.'
      });
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  function getPhoneGridColumnCount(): number {
    const grid = phoneBrowserRef.current?.querySelector('.file-grid');
    if (!(grid instanceof HTMLElement)) {
      return 1;
    }
    const template = window.getComputedStyle(grid).gridTemplateColumns;
    const columns = template.split(' ').filter(Boolean).length;
    return Math.max(1, columns);
  }

  function selectAllActiveContext(): void {
    const activeElement = document.activeElement;
    if (isEditableElement(activeElement)) {
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        activeElement.select();
      } else {
        document.execCommand('selectAll');
      }
      return;
    }

    if (activePane === 'mac') {
      selectAllLocalEntries();
    } else {
      selectAllPhoneRows();
    }
  }

  function handleAppMenuCommand(command: AppMenuCommand): void {
    switch (command) {
      case 'new-folder':
        setActivePane('phone');
        openNewFolderDialog();
        break;
      case 'copy-to-queue':
        copyActivePaneSelectionToQueue();
        break;
      case 'copy-selection':
        copyActivePaneSelectionToClipboard();
        break;
      case 'paste-selection':
        void pasteTransferClipboard();
        break;
      case 'folder-up':
        goUpActivePane();
        break;
      case 'focus-phone':
        focusPhonePane();
        break;
      case 'focus-mac':
        focusMacPane();
        break;
      case 'refresh':
        void handleManualRefresh();
        break;
      case 'select-all':
        selectAllActiveContext();
        break;
      case 'open-files':
        if (canAdminRecover) {
          void recoverWithAdmin();
        } else {
          setTransferNotice({
            phase: hasDevice ? 'ready' : 'failed',
            message: hasDevice
              ? 'Phone files are already open.'
              : 'Open files is available after the Mac can see a phone that normal access cannot open.'
          });
        }
        break;
      case 'open-log':
        void window.mtp.openLog();
        break;
      case 'view-list':
        setPhoneViewMode('list');
        break;
      case 'view-grid':
        setPhoneViewMode('grid');
        break;
      case 'toggle-hidden-files':
        toggleHiddenFiles();
        break;
      case 'theme-system':
        setThemeMode('system');
        break;
      case 'theme-light':
        setThemeMode('light');
        break;
      case 'theme-dark':
        setThemeMode('dark');
        break;
    }
  }

  function handleLocalPaneKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (isInteractiveElement(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'a') {
      event.preventDefault();
      selectAllLocalEntries();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 'enter') {
      event.preventDefault();
      copyActivePaneSelectionToQueue();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 'arrowup') {
      event.preventDefault();
      void goUpLocalDirectory();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveLocalSelection(1, event.shiftKey);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveLocalSelection(-1, event.shiftKey);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void goUpLocalDirectory();
    } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      openSelectedLocalEntry();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSelectedLocalPaths(new Set());
    }
  }

  function startPaneResize(event: ReactPointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    paneResizeStart.current = {
      startX: event.clientX,
      startWidth: macPaneWidth,
      workspaceWidth
    };
    setIsResizingPane(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePaneResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width;
    const step = event.shiftKey ? 72 : 24;
    setMacPaneWidth((current) => {
      if (event.key === 'Home') {
        return clampMacPaneWidth(MIN_MAC_PANE_WIDTH, workspaceWidth);
      }
      if (event.key === 'End') {
        return clampMacPaneWidth(MAX_MAC_PANE_WIDTH, workspaceWidth);
      }
      return clampMacPaneWidth(
        event.key === 'ArrowLeft' ? current + step : current - step,
        workspaceWidth
      );
    });
  }

  function toggleLocalSort(key: SortKey): void {
    if (key === localSortKey) {
      setLocalSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setLocalSortKey(key);
      setLocalSortDirection('asc');
    }
  }

  function localSortTitle(key: SortKey, label: string): string {
    if (key !== localSortKey) {
      return `Sort Mac files by ${label}`;
    }
    return `Mac files sorted by ${label}, ${localSortDirection === 'asc' ? 'ascending' : 'descending'}`;
  }

  function localAriaSort(key: SortKey): 'none' | 'ascending' | 'descending' {
    if (key !== localSortKey) {
      return 'none';
    }
    return localSortDirection === 'asc' ? 'ascending' : 'descending';
  }

  function focusPhonePaneFromPointer(event: ReactMouseEvent<HTMLElement>): void {
    if (isInteractiveElement(event.target)) {
      return;
    }
    setActivePane('phone');
    phoneBrowserRef.current?.focus();
  }

  function openLocalEntry(entry: LocalEntry): void {
    if (entry.kind === 'folder') {
      void navigateLocalDirectory(entry.path);
    }
  }

  function startLocalEntryDrag(entry: LocalEntry, event: DragEvent<HTMLButtonElement>): void {
    const selectedPaths = selectedLocalPaths.has(entry.path) ? Array.from(selectedLocalPaths) : [entry.path];
    const draggedEntries = sortedLocalEntries.filter((candidate) => selectedPaths.includes(candidate.path));
    const dragPaths = draggedEntries.length ? draggedEntries.map((candidate) => candidate.path) : [entry.path];
    event.preventDefault();
    setSelectedLocalPaths(new Set(dragPaths));
    window.mtp.startLocalFileDrag(dragPaths);
    setTransferNotice({
      phase: 'ready',
      message: `Dragging ${dragPaths.length === 1 ? 'a Mac item' : `${dragPaths.length} Mac items`}. Drop anywhere Finder accepts files.`
    });
  }

  function openNewFolderDialog(): void {
    if (!canCreatePhoneFolder) {
      setTransferNotice({
        phase: 'failed',
        message: 'Open Internal storage or a phone folder before creating a folder on the phone.'
      });
      return;
    }
    setNewFolderName('');
    setNewFolderError(null);
    setNewFolderDialogOpen(true);
  }

  function closeNewFolderDialog(): void {
    if (newFolderBusy) {
      return;
    }
    setNewFolderDialogOpen(false);
    setNewFolderName('');
    setNewFolderError(null);
  }

  async function createPhoneFolderFromDialog(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!device || location.storageId === null) {
      setNewFolderError('Open Internal storage or a phone folder first.');
      return;
    }

    const folderName = cleanPhoneFolderName(newFolderName);
    if (!folderName) {
      setNewFolderError('Enter a folder name.');
      return;
    }
    if (/[/:]/.test(folderName)) {
      setNewFolderError('Folder names cannot contain / or :');
      return;
    }
    const duplicate = currentFolderObjects.some(
      (object) => object.kind === 'folder' && object.name.toLowerCase() === folderName.toLowerCase()
    );
    if (duplicate) {
      setNewFolderError('A folder with that name is already here.');
      return;
    }

    setNewFolderBusy(true);
    setNewFolderError(null);
    try {
      const result = await window.mtp.createFolder({
        deviceIndex: device.index,
        deviceConnectionId: device.connectionId,
        storageId: location.storageId,
        parentId: location.folderId,
        name: folderName
      });
      if (!result.ok || !result.folderId) {
        setNewFolderError(result.message || 'Could not create that folder on the phone.');
        return;
      }

      setNewFolderDialogOpen(false);
      setNewFolderName('');
      setSelectedKeys(new Set([objectRowKey(device.connectionId, location.storageId, result.folderId)]));
      await loadFolder(location.storageId, location.folderId, true);
      setTransferNotice({
        phase: 'ready',
        message: `${folderName} was created on the phone.`
      });
    } catch (error) {
      setNewFolderError(error instanceof Error ? error.message : 'Could not create that folder on the phone.');
    } finally {
      setNewFolderBusy(false);
    }
  }

  useEffect(() => {
    void scanDevice({ automatic: true });
    void loadLocalDirectory();
    void window.mtp.getCommonMacFolders().then(setCommonMacFolders).catch(() => setCommonMacFolders([]));
    const interval = window.setInterval(() => {
      void pollForPhone();
    }, AUTO_PHONE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    inventoryRef.current = inventory;
  }, [inventory]);

  useEffect(
    () =>
      window.mtp.onFolderListProgress((progress) => {
        const key = folderKey(
          progress.deviceConnectionId,
          progress.storageId,
          progress.parentId
        );
        if (!folderLoadTokens.current[key]) {
          return;
        }
        setFolderListProgress({ ...progress, key });
      }),
    []
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage failures; the selected theme still applies for this session.
    }
  }, [themeMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, phoneViewMode);
    } catch {
      // Ignore storage failures; the selected view still applies for this session.
    }
  }, [phoneViewMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, String(showHiddenFiles));
    } catch {
      // Ignore storage failures; the selected visibility still applies for this session.
    }
  }, [showHiddenFiles]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MAC_PANE_WIDTH_STORAGE_KEY, String(macPaneWidth));
    } catch {
      // Ignore storage failures; the selected pane width still applies for this session.
    }
  }, [macPaneWidth]);

  useEffect(() => {
    const handleWindowResize = (): void => {
      const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width;
      setMacPaneWidth((current) => clampMacPaneWidth(current, workspaceWidth));
    };

    handleWindowResize();
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  useEffect(() => {
    if (!isResizingPane) {
      return;
    }

    const handlePaneResizeMove = (event: PointerEvent): void => {
      const start = paneResizeStart.current;
      if (!start) {
        return;
      }
      event.preventDefault();
      setMacPaneWidth(clampMacPaneWidth(start.startWidth - (event.clientX - start.startX), start.workspaceWidth));
    };

    const stopPaneResize = (): void => {
      paneResizeStart.current = null;
      setIsResizingPane(false);
    };

    window.addEventListener('pointermove', handlePaneResizeMove);
    window.addEventListener('pointerup', stopPaneResize);
    window.addEventListener('pointercancel', stopPaneResize);
    return () => {
      window.removeEventListener('pointermove', handlePaneResizeMove);
      window.removeEventListener('pointerup', stopPaneResize);
      window.removeEventListener('pointercancel', stopPaneResize);
    };
  }, [isResizingPane]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) {
      return;
    }

    const updateSystemTheme = (): void => setSystemPrefersDark(media.matches);
    updateSystemTheme();
    media.addEventListener('change', updateSystemTheme);
    return () => media.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    const breadcrumbs = phoneBreadcrumbsRef.current;
    if (breadcrumbs) {
      breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
    }
  }, [location.folderId, location.storageId]);

  useEffect(() => {
    const breadcrumbs = localBreadcrumbsRef.current;
    if (breadcrumbs) {
      breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
    }
  }, [localPath]);

  useEffect(() => {
    if (device && location.storageId !== null) {
      void loadFolder(location.storageId, location.folderId);
    }
  }, [device?.connectionId, location.folderId, location.storageId]);

  useEffect(() => {
    if (!browserLoading) {
      setLoadingElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setLoadingElapsedSeconds(0);
    const interval = window.setInterval(() => {
      setLoadingElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [browserLoading, currentFolderKey]);

  useEffect(() => {
    return window.mtp.onTransferEvent((event) => {
      setJobs((currentJobs) => mergeTransferJobs(currentJobs, [event.job]));
      if (
        event.type === 'completed' &&
        event.job.direction === 'upload' &&
        device &&
        event.job.deviceIndex === device.index &&
        location.storageId !== null &&
        event.job.storageId === location.storageId &&
        event.job.parentId === location.folderId
      ) {
        void loadFolder(location.storageId, location.folderId, true);
      }
      if (
        event.type === 'completed' &&
        event.job.operation === 'move' &&
        event.job.sourceRemovalStatus === 'removed' &&
        event.job.direction === 'upload' &&
        localPath
      ) {
        void loadLocalDirectory(localPath);
      }
      if (
        event.type === 'completed' &&
        event.job.operation === 'move' &&
        event.job.sourceRemovalStatus === 'removed' &&
        event.job.direction === 'download' &&
        device &&
        event.job.deviceConnectionId === device.connectionId &&
        location.storageId !== null &&
        event.job.storageId === location.storageId &&
        event.job.parentId === location.folderId
      ) {
        void loadFolder(location.storageId, location.folderId, true);
      }
      if (
        event.job.direction === 'download' &&
        (event.type === 'completed' || event.type === 'failed' || event.type === 'canceled')
      ) {
        Object.entries(downloadFolderPlans.current).forEach(([planKey, plan]) => {
          if (!plan.remainingJobIds.has(event.job.id)) {
            return;
          }
          plan.remainingJobIds.delete(event.job.id);
          if (event.type !== 'completed') {
            plan.failed = true;
          }
          if (plan.remainingJobIds.size === 0) {
            delete downloadFolderPlans.current[planKey];
            if (!plan.failed) {
              void preservePlannedLocalDirectories(plan.directories);
            }
          }
        });
      }
    });
  }, [device?.connectionId, localPath, location.folderId, location.storageId]);

  useEffect(() => {
    return window.mtp.onPhoneFilePromiseDragEvent((event) => {
      if (event.type === 'internal-hover') {
        setIsDraggingTransfer(event.active);
        return;
      }
      if (event.type === 'planning') {
        setPhoneDownloadPlanning({
          files: event.files,
          folders: event.folders,
          currentName: event.currentName
        });
        return;
      }
      if (event.type === 'started') {
        setTransferNotice({ phase: 'ready', message: event.message });
        return;
      }
      setIsDraggingTransfer(false);
      setPhoneDownloadPlanning(null);
      setTransferNotice({
        phase: event.type === 'failed' ? 'failed' : 'ready',
        message: event.message
      });
    });
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  function contextMenuCoordinates(event: ReactMouseEvent<HTMLElement>): { x: number; y: number } {
    const menuWidth = 236;
    const menuHeight = 280;
    return {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    };
  }

  function openPhoneContextMenu(event: ReactMouseEvent<HTMLElement>, row?: BrowserRow): void {
    event.preventDefault();
    event.stopPropagation();
    setActivePane('phone');
    if (row && !selectedKeys.has(row.key)) {
      setSelectedKeys(new Set([row.key]));
      phoneSelectionAnchorKey.current = row.key;
    }
    setContextMenu({
      pane: 'phone',
      ...contextMenuCoordinates(event),
      rowKey: row?.key
    });
  }

  function openMacContextMenu(event: ReactMouseEvent<HTMLElement>, entry?: LocalEntry): void {
    event.preventDefault();
    event.stopPropagation();
    setActivePane('mac');
    if (entry && !selectedLocalPaths.has(entry.path)) {
      setSelectedLocalPaths(new Set([entry.path]));
      localSelectionAnchorPath.current = entry.path;
    }
    setContextMenu({
      pane: 'mac',
      ...contextMenuCoordinates(event),
      localPath: entry?.path
    });
  }

  function runContextMenuAction(action: () => void): void {
    setContextMenu(null);
    action();
  }

  function navigate(next: BrowserLocation): void {
    setBackStack((stack) => [...stack, location]);
    setForwardStack([]);
    setLocation(next);
    setSelectedKeys(new Set());
    phoneSelectionAnchorKey.current = null;
  }

  function selectDevice(nextDevice: MtpDeviceInventory): void {
    if (device?.connectionId === nextDevice.connectionId) {
      return;
    }

    setSelectedDeviceConnectionId(nextDevice.connectionId);
    resetPhoneBrowserState();
    setTransferNotice({
      phase: 'ready',
      message: `${deviceDisplayName(nextDevice)} selected. Open a storage location to browse files.`
    });
  }

  function openRow(row: BrowserRow): void {
    if (row.kind === 'storage' && row.storage) {
      navigate({
        storageId: row.storage.id,
        folderId: ROOT_PARENT_ID,
        crumbs: [{ label: row.name, folderId: ROOT_PARENT_ID }]
      });
      return;
    }

    if (row.kind === 'folder' && row.object) {
      navigate({
        storageId: location.storageId,
        folderId: row.object.id,
        crumbs: [...location.crumbs, { label: row.name, folderId: row.object.id }]
      });
    }
  }

  function goBack(): void {
    const previous = backStack[backStack.length - 1];
    if (!previous) {
      return;
    }
    setBackStack((stack) => stack.slice(0, -1));
    setForwardStack((stack) => [location, ...stack]);
    setLocation(previous);
    setSelectedKeys(new Set());
    phoneSelectionAnchorKey.current = null;
  }

  function goForward(): void {
    const next = forwardStack[0];
    if (!next) {
      return;
    }
    setForwardStack((stack) => stack.slice(1));
    setBackStack((stack) => [...stack, location]);
    setLocation(next);
    setSelectedKeys(new Set());
    phoneSelectionAnchorKey.current = null;
  }

  function goUp(): void {
    if (location.storageId === null) {
      return;
    }

    if (location.crumbs.length <= 1) {
      navigate(rootLocation);
      return;
    }

    const nextCrumbs = location.crumbs.slice(0, -1);
    navigate({
      storageId: location.storageId,
      folderId: nextCrumbs[nextCrumbs.length - 1].folderId,
      crumbs: nextCrumbs
    });
  }

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  }

  function toggleRowSelection(row: BrowserRow, additive: boolean, range: boolean): void {
    if (range && phoneSelectionAnchorKey.current) {
      const anchorIndex = rows.findIndex((candidate) => candidate.key === phoneSelectionAnchorKey.current);
      const nextIndex = rows.findIndex((candidate) => candidate.key === row.key);
      if (anchorIndex >= 0 && nextIndex >= 0) {
        const [start, end] = anchorIndex <= nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
        const rangeKeys = rows.slice(start, end + 1).map((candidate) => candidate.key);
        setSelectedKeys((current) => {
          const next = additive ? new Set(current) : new Set<string>();
          rangeKeys.forEach((key) => next.add(key));
          return next;
        });
        setActivePane('phone');
        return;
      }
    }

    phoneSelectionAnchorKey.current = row.key;
    setSelectedKeys((current) => {
      if (!additive) {
        return new Set([row.key]);
      }
      const next = new Set(current);
      if (next.has(row.key)) {
        next.delete(row.key);
      } else {
        next.add(row.key);
      }
      return next;
    });
  }

  function selectAllPhoneRows(): void {
    setSelectedKeys(new Set(rows.map((row) => row.key)));
    phoneSelectionAnchorKey.current = rows[0]?.key ?? null;
    setActivePane('phone');
  }

  function movePhoneSelection(delta: number, extend: boolean): void {
    if (!rows.length) {
      return;
    }

    const selectedIndices = rows
      .map((row, index) => (selectedKeys.has(row.key) ? index : -1))
      .filter((index) => index >= 0);
    const currentIndex =
      selectedIndices.length > 0
        ? delta >= 0
          ? selectedIndices[selectedIndices.length - 1]
          : selectedIndices[0]
        : delta >= 0
          ? -1
          : rows.length;
    const nextIndex = Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
    const nextKeys = extend ? new Set(selectedKeys) : new Set<string>();
    nextKeys.add(rows[nextIndex].key);
    setSelectedKeys(nextKeys);
    if (!extend || !phoneSelectionAnchorKey.current) {
      phoneSelectionAnchorKey.current = rows[nextIndex].key;
    }
    setActivePane('phone');
  }

  function openSelectedPhoneRow(): void {
    const row = selectedRows.length === 1 ? selectedRows[0] : rows.find((candidate) => selectedKeys.has(candidate.key));
    if (row) {
      openRow(row);
    } else if (rows[0]) {
      setSelectedKeys(new Set([rows[0].key]));
      phoneSelectionAnchorKey.current = rows[0].key;
    }
  }

  function clearPhoneSelectionOrFilter(): void {
    if (query) {
      setQuery('');
      return;
    }
    setSelectedKeys(new Set());
    phoneSelectionAnchorKey.current = null;
  }

  function handlePhonePaneKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (isInteractiveElement(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'a') {
      event.preventDefault();
      selectAllPhoneRows();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 'enter') {
      event.preventDefault();
      copyActivePaneSelectionToQueue();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 'arrowup') {
      event.preventDefault();
      goUp();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === 'arrowdown') {
      event.preventDefault();
      openSelectedPhoneRow();
      return;
    }

    if (phoneViewMode === 'grid') {
      const columnCount = getPhoneGridColumnCount();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        movePhoneSelection(columnCount, event.shiftKey);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        movePhoneSelection(-columnCount, event.shiftKey);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        movePhoneSelection(-1, event.shiftKey);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        movePhoneSelection(1, event.shiftKey);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        openSelectedPhoneRow();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearPhoneSelectionOrFilter();
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePhoneSelection(1, event.shiftKey);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePhoneSelection(-1, event.shiftKey);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goUp();
    } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      openSelectedPhoneRow();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clearPhoneSelectionOrFilter();
    }
  }

  async function chooseDestination(): Promise<string | null> {
    if (destination) {
      return destination;
    }
    const result = await window.mtp.chooseDestination();
    if (result.canceled || !result.path) {
      return null;
    }
    await navigateLocalDirectory(result.path);
    return result.path;
  }

  async function useDesktopDestination(): Promise<void> {
    const desktopPath = await window.mtp.getDesktopDestination();
    await navigateLocalDirectory(desktopPath);
    setTransferNotice({
      phase: 'ready',
      message: 'Desktop is selected. Copies will show progress in this queue.'
    });
  }

  async function copyRowsToMac(
    fileRows: BrowserRow[],
    sourceDeviceIndex = device?.index,
    sourceDeviceConnectionId = device?.connectionId,
    operation: TransferOperation = 'copy'
  ): Promise<void> {
    const validRows = fileRows.filter((row) => (row.kind === 'file' || row.kind === 'folder') && row.object);
    if (
      validRows.length === 0 ||
      typeof sourceDeviceIndex !== 'number' ||
      !sourceDeviceConnectionId
    ) {
      return;
    }

    if (operation === 'move' && validRows.some((row) => row.kind !== 'file')) {
      setTransferNotice({
        phase: 'failed',
        message: 'Move works with files only. Choose Copy for folders.'
      });
      return;
    }

    const destinationDirectory = await chooseDestination();
    if (!destinationDirectory) {
      return;
    }

    let plan: PhoneDownloadPlan = { requests: [], directories: [] };
    const includesFolder = validRows.some((row) => row.kind === 'folder');
    phoneDownloadPlanningCancelRequested.current = false;
    if (includesFolder) {
      setPhoneDownloadPlanning({
        files: 0,
        folders: 0,
        currentName: 'selected folders'
      });
    }
    try {
      plan = await planPhoneRowsForDownload(
        validRows,
        destinationDirectory,
        sourceDeviceIndex,
        {
          onProgress: includesFolder
            ? (progress) => setPhoneDownloadPlanning(progress)
            : undefined,
          shouldCancel: () => phoneDownloadPlanningCancelRequested.current
        },
        sourceDeviceConnectionId,
        operation
      );
      await ensurePlannedLocalDirectories(plan.directories);
      if (phoneDownloadPlanningCancelRequested.current) {
        throw new Error(folderCopyPlanningStoppedMessage());
      }
      if (!plan.requests.length) {
        if (plan.directories.length) {
          void preservePlannedLocalDirectories(plan.directories);
        }
        setPhoneDownloadPlanning(null);
        phoneDownloadPlanningCancelRequested.current = false;
        setTransferNotice({
          phase: plan.directories.length ? 'ready' : 'failed',
          message: plan.directories.length
            ? 'Folder created on the Mac. It did not contain files to copy.'
            : 'No files were found in that selection.'
        });
        return;
      }
    } catch (error) {
      const stopped = phoneDownloadPlanningCancelRequested.current;
      setPhoneDownloadPlanning(null);
      phoneDownloadPlanningCancelRequested.current = false;
      setTransferNotice({
        phase: 'failed',
        message: stopped
          ? folderCopyPlanningStoppedMessage()
          : error instanceof Error
            ? error.message
            : 'Unable to plan that folder transfer.'
      });
      return;
    }
    setPhoneDownloadPlanning(null);
    phoneDownloadPlanningCancelRequested.current = false;

    const moveResult =
      operation === 'move' ? await window.mtp.startMoveDownloads(plan.requests) : null;
    if (moveResult && !moveResult.confirmed) {
      setTransferNotice({
        phase: 'ready',
        message: 'Move canceled. Nothing was deleted.'
      });
      return;
    }
    const queued = moveResult?.jobs ?? (await window.mtp.startDownloads(plan.requests));
    if (plan.directories.length) {
      const failedBeforeTracking = queued.some(
        (job) => job.status === 'failed' || job.status === 'canceled'
      );
      const remainingJobIds = new Set(
        queued
          .filter((job) => job.status !== 'completed' && job.status !== 'failed' && job.status !== 'canceled')
          .map((job) => job.id)
      );
      if (remainingJobIds.size === 0) {
        if (!failedBeforeTracking) {
          void preservePlannedLocalDirectories(plan.directories);
        }
      } else {
        downloadFolderPlans.current[plannedDirectoryKey('download-folder')] = {
          remainingJobIds,
          directories: plan.directories,
          failed: failedBeforeTracking
        };
      }
    }
    const renameSummary = downloadRenameSummary(
      queued.filter((job) => job.status !== 'failed' && job.status !== 'canceled')
    );
    const failedCount = queued.filter((job) => job.status === 'failed').length;
    const queuedCount = queued.filter((job) => job.status === 'queued' || job.status === 'active').length;
    setJobs((currentJobs) => mergeTransferJobs(currentJobs, queued));
    setTransferNotice({
      phase: failedCount && !queuedCount ? 'failed' : 'queued',
      message:
        failedCount && !queuedCount
          ? `${failedCount} ${failedCount === 1 ? 'file needs' : 'files need'} attention before copying. Check the queue for the reason.`
          : `${queuedCount} ${queuedCount === 1 ? 'file' : 'files'} will be ${operation === 'move' ? 'moved' : 'copied'} to ${destinationDirectory}${
              failedCount ? ` · ${failedCount} need attention` : ''
            }.${renameSummary ? ` ${renameSummary}` : ''}`
    });
  }

  async function copySelectedToMac(operation: TransferOperation = 'copy'): Promise<void> {
    await copyRowsToMac(
      selectedTransferRows,
      device?.index,
      device?.connectionId,
      operation
    );
  }

  async function planPhoneRowsForDownload(
    sourceRows: BrowserRow[],
    destinationRoot: string,
    sourceDeviceIndex = device?.index,
    options: PhoneDownloadPlanOptions = {},
    sourceDeviceConnectionId = device?.connectionId,
    operation: TransferOperation = 'copy'
  ): Promise<PhoneDownloadPlan> {
    if (typeof sourceDeviceIndex !== 'number' || !sourceDeviceConnectionId) {
      return { requests: [], directories: [] };
    }

    const deviceIndex = sourceDeviceIndex;
    const planned: TransferRequest[] = [];
    const directoryMap = new Map<string, number>();
    let plannedFiles = 0;
    let plannedFolders = 0;

    function reportProgress(currentName: string): void {
      options.onProgress?.({
        files: plannedFiles,
        folders: plannedFolders,
        currentName
      });
    }

    function throwIfCanceled(): void {
      if (options.shouldCancel?.()) {
        throw new Error(folderCopyPlanningStoppedMessage());
      }
    }

    async function collectObject(object: MtpObject, destinationDirectory: string): Promise<void> {
      throwIfCanceled();
      if (planned.length > MAX_PLANNED_PHONE_FILES) {
        throw new Error(`Selection is too large to plan at once. Try fewer than ${MAX_PLANNED_PHONE_FILES} files.`);
      }

      if (object.kind === 'file') {
        plannedFiles += 1;
        reportProgress(object.name);
        planned.push({
          deviceIndex,
          deviceConnectionId: sourceDeviceConnectionId,
          storageId: object.storageId,
          objectId: object.id,
          parentId: object.parentId,
          name: object.name,
          size: object.size,
          modified: object.modified,
          destinationDirectory,
          operation
        });
        return;
      }

      const folderDirectory = joinMacPath(destinationDirectory, sanitizePathPart(object.name));
      plannedFolders += 1;
      reportProgress(object.name);
      directoryMap.set(folderDirectory, object.modified);
      const result = await window.mtp.listFolder(
        deviceIndex,
        sourceDeviceConnectionId,
        object.storageId,
        object.id
      );
      throwIfCanceled();
      if (!result.ok) {
        throw new Error(result.message || `Unable to list ${object.name}.`);
      }

      for (const child of result.objects) {
        throwIfCanceled();
        await collectObject(child, folderDirectory);
      }
    }

    for (const row of sourceRows) {
      if (row.kind === 'file' && row.object) {
        await collectObject(row.object, destinationRoot);
      } else if (row.kind === 'folder' && row.object) {
        await collectObject(row.object, destinationRoot);
      }
    }

    return {
      requests: planned,
      directories: Array.from(directoryMap, ([path, modified]) => ({ path, modified }))
    };
  }

  async function ensurePlannedLocalDirectories(directories: PlannedLocalDirectory[]): Promise<void> {
    for (const directory of directories) {
      const result = await window.mtp.ensureLocalDirectory(directory.path);
      if (!result.ok) {
        throw new Error(result.message || `Unable to create ${directory.path}.`);
      }
    }
  }

  async function recoverWithAdmin(): Promise<void> {
    recoveryInFlight.current = true;
    setIsRecovering(true);
    setRecoveryResult(null);
    setRefreshFeedback({
      phase: 'checking',
      message: 'Opening phone files. Keep the phone unlocked; this can take a few minutes if macOS resets USB.'
    });
    let scanAfterRecovery = false;
    try {
      const result = await window.mtp.recoverWithAdmin();
      setRecoveryResult(result);
      if (result.ok && result.inventory) {
        const rawKey = rawDeviceKey(result.rawDevice) ?? statusRawKey(status);
        const identityKey = rawDeviceIdentityKey(result.rawDevice) ?? statusDeviceIdentityKey(status);
        if (rawKey) {
          protectedAccessRawKey.current = rawKey;
          lastAutoRawKey.current = rawKey;
        }
        if (identityKey) {
          protectedAccessDeviceIdentityKey.current = identityKey;
        }
        const connectionId =
          result.rawDevice?.connectionId ?? result.inventory.devices[0]?.connectionId ?? null;
        if (connectionId) {
          protectedAccessConnectionId.current = connectionId;
        }
        clearAutomaticScanFailures();
        resetBrowserToInventory(result.inventory);
        setRefreshFeedback({
          phase: 'done',
          message: 'Phone files are open.'
        });
      } else if (result.ok) {
        scanAfterRecovery = true;
      } else {
        setRefreshFeedback({
          phase: 'failed',
          message: result.message
        });
      }
    } finally {
      recoveryInFlight.current = false;
      setIsRecovering(false);
    }
    if (scanAfterRecovery) {
      await scanDevice();
    }
  }

  function rowsFromKeys(keys: string[]): BrowserRow[] {
    const wanted = new Set(keys);
    return rows.filter((row) => wanted.has(row.key));
  }

  function startFileDrag(row: BrowserRow, event: DragEvent<HTMLElement>): void {
    if ((row.kind !== 'file' && row.kind !== 'folder') || !device) {
      event.preventDefault();
      return;
    }

    const keys = selectedKeys.has(row.key) ? Array.from(selectedKeys) : [row.key];
    const fileRows = rowsFromKeys(keys).filter(
      (candidate) => (candidate.kind === 'file' || candidate.kind === 'folder') && candidate.object
    );
    const fileKeys = fileRows.map((candidate) => candidate.key);
    if (!fileKeys.length) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    setSelectedKeys(new Set(fileKeys));
    setIsDraggingTransfer(false);
    event.dataTransfer.effectAllowed = 'copy';
    const queueBounds = queuePaneRef.current?.getBoundingClientRect();
    window.mtp.startPhoneFilePromiseDrag({
      items: fileRows.flatMap((candidate) => {
        const object = candidate.object;
        if (!object || (candidate.kind !== 'file' && candidate.kind !== 'folder')) {
          return [];
        }
        return [
          {
            deviceIndex: device.index,
            deviceConnectionId: device.connectionId,
            storageId: object.storageId,
            objectId: object.id,
            parentId: object.parentId,
            name: object.name,
            kind: candidate.kind,
            size: object.size,
            modified: object.modified
          }
        ];
      }),
      internalDestination:
        queueBounds && (localPath || destination)
          ? {
              path: localPath || destination,
              rect: {
                x: queueBounds.x,
                y: queueBounds.y,
                width: queueBounds.width,
                height: queueBounds.height
              }
            }
          : undefined
    });
  }

  function dragHasMacFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function pathForDroppedFile(file: File): string {
    try {
      return window.mtp.getPathForFile(file);
    } catch {
      return (file as File & { path?: string }).path ?? '';
    }
  }

  async function entriesFromDroppedMacFiles(fileList: FileList): Promise<LocalEntry[]> {
    const entries: LocalEntry[] = [];
    for (const file of Array.from(fileList)) {
      const sourcePath = pathForDroppedFile(file);
      if (!sourcePath) {
        continue;
      }
      const entry = await window.mtp.inspectLocalPath(sourcePath);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }

  async function uploadDroppedMacFiles(fileList: FileList): Promise<void> {
    if (!device || location.storageId === null) {
      setTransferNotice({
        phase: 'failed',
        message: 'Open Internal storage or a phone folder first, then drop Mac files or folders there.'
      });
      return;
    }

    const entries = await entriesFromDroppedMacFiles(fileList);

    if (!entries.length) {
      setTransferNotice({
        phase: 'failed',
        message: 'That drop did not include readable Mac file or folder paths. Drag from Finder.'
      });
      return;
    }

    await copyLocalFilesToPhone(entries);
  }

  function clearFinishedTransfers(): void {
    setJobs((currentJobs) =>
      currentJobs.filter((job) => job.status !== 'completed' && job.status !== 'failed' && job.status !== 'canceled')
    );
  }

  async function cancelAllTransfers(): Promise<void> {
    const cancellableJobs = jobs.filter((job) => job.status === 'active' || job.status === 'queued');
    if (!cancellableJobs.length) {
      return;
    }

    setTransferNotice({
      phase: 'queued',
      message: `Canceling ${cancellableJobs.length} ${cancellableJobs.length === 1 ? 'transfer' : 'transfers'}...`
    });
    await Promise.allSettled(cancellableJobs.map((job) => window.mtp.cancelTransfer(job.id)));
  }

  function browserDragEnter(event: DragEvent<HTMLElement>): void {
    if (!dragHasMacFiles(event)) {
      return;
    }
    event.preventDefault();
    setIsDraggingMacFiles(true);
  }

  function browserDragOver(event: DragEvent<HTMLElement>): void {
    if (!dragHasMacFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = canUploadToCurrentFolder ? 'copy' : 'none';
    setIsDraggingMacFiles(true);
  }

  function browserDragLeave(event: DragEvent<HTMLElement>): void {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDraggingMacFiles(false);
  }

  function browserDrop(event: DragEvent<HTMLElement>): void {
    if (!dragHasMacFiles(event)) {
      return;
    }
    event.preventDefault();
    setIsDraggingMacFiles(false);
    void uploadDroppedMacFiles(event.dataTransfer.files);
  }

  function refreshButtonLabel(): string {
    return isScanning ? 'Checking...' : 'Check now';
  }

  function renderRefreshFeedback(): JSX.Element | null {
    if (!refreshFeedback) {
      return null;
    }

    const icon =
      refreshFeedback.phase === 'checking' ? (
        <Loader2 size={14} className="spin" />
      ) : refreshFeedback.phase === 'failed' ? (
        <AlertTriangle size={14} />
      ) : (
        <CheckCircle2 size={14} />
      );

    return (
      <div
        className={`refresh-feedback ${refreshFeedback.phase} sidebar`}
        role="status"
        aria-live="polite"
      >
        {icon}
        <span>{refreshFeedback.message}</span>
      </div>
    );
  }

  function renderContextMenu(): JSX.Element | null {
    if (!contextMenu) {
      return null;
    }

    const menuStyle = {
      left: contextMenu.x,
      top: contextMenu.y
    } as CSSProperties;
    const phoneContextRow = contextMenu.rowKey ? rows.find((row) => row.key === contextMenu.rowKey) : undefined;
    const phoneContextTransferRow =
      phoneContextRow && (phoneContextRow.kind === 'file' || phoneContextRow.kind === 'folder') && phoneContextRow.object
        ? phoneContextRow
        : undefined;
    const phoneActionRows =
      contextMenu.pane === 'phone'
        ? phoneContextTransferRow && !selectedKeys.has(phoneContextTransferRow.key)
          ? [phoneContextTransferRow]
          : selectedTransferRows.length
            ? selectedTransferRows
            : phoneContextTransferRow
              ? [phoneContextTransferRow]
              : []
        : [];
    const localContextEntry = contextMenu.localPath
      ? sortedLocalEntries.find((entry) => entry.path === contextMenu.localPath)
      : undefined;
    const localActionEntries =
      contextMenu.pane === 'mac'
        ? localContextEntry && !selectedLocalPaths.has(localContextEntry.path)
          ? [localContextEntry]
          : selectedLocalEntries.length
            ? selectedLocalEntries
            : localContextEntry
              ? [localContextEntry]
              : []
        : [];
    const phoneActionCount = phoneActionRows.length;
    const localActionCount = localActionEntries.length;
    const phoneActionFilesOnly = phoneActionRows.length > 0 && phoneActionRows.every((row) => row.kind === 'file');
    const localActionFilesOnly = localActionEntries.length > 0 && localActionEntries.every((entry) => entry.kind === 'file');

    if (contextMenu.pane === 'phone') {
      return (
        <div
          className="context-menu"
          role="menu"
          aria-label="Phone file actions"
          style={menuStyle}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {phoneContextRow && phoneContextRow.kind !== 'file' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runContextMenuAction(() => openRow(phoneContextRow))}
            >
              <Folder size={15} />
              <span>{phoneContextRow.kind === 'storage' ? 'Open Storage' : 'Open Folder'}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={!phoneActionCount || !hasDevice}
            onClick={() => runContextMenuAction(() => void copyRowsToMac(phoneActionRows))}
          >
            <Download size={15} />
            <span>{phoneActionCount > 1 ? `Copy ${phoneActionCount} Items to Mac` : 'Copy to Mac'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!phoneActionFilesOnly || !hasDevice}
            title={phoneActionCount > 0 && !phoneActionFilesOnly ? 'Move works with files only.' : undefined}
            onClick={() =>
              runContextMenuAction(() =>
                void copyRowsToMac(
                  phoneActionRows,
                  device?.index,
                  device?.connectionId,
                  'move'
                )
              )
            }
          >
            <ArrowRight size={15} />
            <span>Move to {macDestinationLabel}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="separated"
            disabled={!folderLoading}
            onClick={() => runContextMenuAction(() => void stopFolderListing())}
          >
            <X size={15} />
            <span>Stop Listing</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={location.storageId === null}
            onClick={() => runContextMenuAction(goUp)}
          >
            <ArrowUp size={15} />
            <span>Parent Folder</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canCreatePhoneFolder || newFolderBusy}
            onClick={() => runContextMenuAction(openNewFolderDialog)}
          >
            <FolderPlus size={15} />
            <span>New Phone Folder</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => runContextMenuAction(() => void handleManualRefresh())}
          >
            <RefreshCcw size={15} />
            <span>Check Phone Now</span>
          </button>
        </div>
      );
    }

    return (
      <div
        className="context-menu"
        role="menu"
        aria-label="Mac file actions"
        style={menuStyle}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {localContextEntry?.kind === 'folder' && (
          <button
            type="button"
            role="menuitem"
            onClick={() => runContextMenuAction(() => void openLocalEntry(localContextEntry))}
          >
            <Folder size={15} />
            <span>Open Folder</span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          disabled={!localActionCount || !canUploadToCurrentFolder}
          onClick={() => runContextMenuAction(() => void copyLocalFilesToPhone(localActionEntries))}
        >
          <Upload size={15} />
          <span>{localActionCount > 1 ? `Copy ${localActionCount} Items to Phone` : 'Copy to Phone'}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!localActionFilesOnly || !canUploadToCurrentFolder}
          title={localActionCount > 0 && !localActionFilesOnly ? 'Move works with files only.' : undefined}
          onClick={() =>
            runContextMenuAction(() => void copyLocalFilesToPhone(localActionEntries, 'move'))
          }
        >
          <ArrowLeft size={15} />
          <span>Move to {phoneDestinationLabel}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!localContextEntry}
          onClick={() =>
            localContextEntry &&
            runContextMenuAction(() => void window.mtp.revealInFinder(localContextEntry.path))
          }
        >
          <ExternalLink size={15} />
          <span>Reveal in Finder</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="separated"
          disabled={!localParentPath || localParentPath === localPath}
          onClick={() => runContextMenuAction(() => void goUpLocalDirectory())}
        >
          <ArrowUp size={15} />
          <span>Parent Folder</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!localPath}
          onClick={() => runContextMenuAction(() => void loadLocalDirectory(localPath))}
        >
          <RefreshCcw size={15} />
          <span>Refresh Mac Folder</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextMenuAction(() => void chooseMacFolder())}
        >
          <Folder size={15} />
          <span>Choose Mac Folder</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextMenuAction(() => void useDesktopDestination())}
        >
          <Download size={15} />
          <span>Use Desktop</span>
        </button>
      </div>
    );
  }

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        setActivePane('phone');
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (key === 'r') {
        event.preventDefault();
        void handleManualRefresh();
        return;
      }

      if (key === '1' && !isEditableElement(event.target)) {
        event.preventDefault();
        focusPhonePane();
        return;
      }

      if (key === '2' && !isEditableElement(event.target)) {
        event.preventDefault();
        focusMacPane();
        return;
      }

      if (key === 'n' && !isEditableElement(event.target)) {
        event.preventDefault();
        focusPhonePane();
        openNewFolderDialog();
        return;
      }

      if (key === 'b' && !isEditableElement(event.target)) {
        event.preventDefault();
        goUpActivePane();
        return;
      }

      if (key === 'c' && !isEditableElement(event.target)) {
        if (!activePaneHasTransferSelection) {
          return;
        }
        event.preventDefault();
        if (event.shiftKey) {
          copyActivePaneSelectionToQueue();
        } else {
          copyActivePaneSelectionToClipboard();
        }
        return;
      }

      if (key === 'v' && !isEditableElement(event.target)) {
        event.preventDefault();
        void pasteTransferClipboard();
        return;
      }

      if (key === 'a' && !isEditableElement(event.target)) {
        event.preventDefault();
        selectAllActiveContext();
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  });

  useEffect(() => window.mtp.onAppMenuCommand(handleAppMenuCommand));

  const queueActive = jobs.some((job) => job.status === 'active' || job.status === 'queued');
  const connectionStateClass =
    phoneDownloadPlanning
      ? 'preparing'
      : queueSummary.activeTransfers || queueSummary.queuedTransfers
      ? 'transfer-active'
      : inventory?.state ?? status?.state ?? 'checking';
  const connectionLabel = phoneDownloadPlanning
    ? 'Preparing'
    : queueSummary.activeTransfers
    ? 'Transferring'
    : queueSummary.queuedTransfers
      ? 'Transfer queued'
      : stateLabel(status, inventory);
  const connectionTitle = phoneDownloadPlanning
    ? 'Listing phone folders before the copy starts. Keep the phone unlocked and connected.'
    : queueSummary.activeTransfers
    ? 'Copying files. Keep the phone unlocked and the cable connected.'
    : queueSummary.queuedTransfers
      ? 'Files are queued and will copy when the current phone operation finishes.'
      : stateTitle(status, inventory);
  const shouldShowRecover = usbAccessDenied && !!rawDevice && !fileTransferInactive;
  const canAdminRecover = shouldShowRecover && !isRecovering;
  const workspaceStyle = {
    '--mac-pane-width': `${macPaneWidth}px`
  } as CSSProperties;

  return (
    <main className="app-shell" data-theme={resolvedTheme}>
      <section className="topbar">
        <div className="traffic-space" />
        <div className="brand">
          <Smartphone size={18} strokeWidth={2} />
          <span>Android File Transfer for macOS</span>
        </div>
        <div className="topbar-actions">
          <div className="theme-switch" role="group" aria-label="Theme">
            <button
              type="button"
              className={themeMode === 'light' ? 'active' : ''}
              aria-label="Use light mode"
              aria-pressed={themeMode === 'light'}
              title="Light mode"
              onClick={() => setThemeMode('light')}
            >
              <Sun size={13} />
            </button>
            <button
              type="button"
              className={themeMode === 'system' ? 'active' : ''}
              aria-label="Follow system appearance"
              aria-pressed={themeMode === 'system'}
              title="Follow system"
              onClick={() => setThemeMode('system')}
            >
              <Monitor size={13} />
            </button>
            <button
              type="button"
              className={themeMode === 'dark' ? 'active' : ''}
              aria-label="Use dark mode"
              aria-pressed={themeMode === 'dark'}
              title="Dark mode"
              onClick={() => setThemeMode('dark')}
            >
              <Moon size={13} />
            </button>
          </div>
          <div
            className={`connection-pill state-${connectionStateClass}`}
            title={connectionTitle}
            role="status"
            aria-live="polite"
          >
            {isScanning || queueActive ? <Loader2 size={14} className="spin" /> : <Circle size={10} fill="currentColor" />}
            <span>{connectionLabel}</span>
          </div>
        </div>
      </section>

      <section
        className={`workspace ${isResizingPane ? 'resizing-pane' : ''}`}
        ref={workspaceRef}
        style={workspaceStyle}
      >
        <aside className="sidebar">
          <div className="device-block">
            <div className="device-title">
              <Smartphone size={17} />
              <span>{device?.name || rawDeviceName}</span>
            </div>
            <p className="device-subtitle">
              {fileTransferInactive
                ? 'The cable works. On the phone, choose File transfer; this app will detect it automatically.'
                : protectedAccessOpen
                ? 'Phone files are open through protected access. You can browse and copy now.'
                : usbAccessDenied
                ? 'USB is visible in File Transfer mode. The phone file session is not open yet.'
                : cannotOpenPhone
                ? 'Phone detected, but files are not open yet. Follow the steps in the main panel.'
                : statusMessage}
            </p>
            <ol className="connection-stages" aria-label="Phone connection progress">
              {connectionStages.map((stage) => (
                <li className={`connection-stage ${stage.state}`} key={stage.key}>
                  <span className="connection-stage-dot" aria-hidden="true" />
                  <div>
                    <span className="connection-stage-title">
                      {stage.label}
                      <small>{stageStateLabel(stage.state)}</small>
                    </span>
                    <p>{stage.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="device-actions">
              {shouldShowRecover && (
                <button
                  className="primary-button sidebar-protected-action"
                  title="Open one protected phone-file session. The app explains the Mac password prompt before it appears."
                  aria-label="Open phone files"
                  disabled={!canAdminRecover}
                  onClick={() => void recoverWithAdmin()}
                >
                  {isRecovering ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  <span>{isRecovering ? 'Opening...' : 'Open files'}</span>
                </button>
              )}
              <button
                className="icon-button"
                title={
                  isScanning
                    ? 'Checking the phone now.'
                    : 'Optional: check now instead of waiting for the next automatic check.'
                }
                aria-label={isScanning ? 'Checking the phone now' : 'Check phone connection now'}
                onClick={() => void handleManualRefresh()}
              >
                {isScanning ? <Loader2 size={16} className="spin" /> : <RefreshCcw size={16} />}
              </button>
              <button className="text-button" onClick={() => void window.mtp.openLog()}>
                Log
              </button>
              <button
                className={`text-button details-button ${showDiagnostics ? 'active' : ''}`}
                type="button"
                aria-expanded={showDiagnostics}
                onClick={() => setShowDiagnostics((visible) => !visible)}
              >
                Details
              </button>
            </div>
            {renderRefreshFeedback()}
            {recoveryResult && !isRecovering && (
              <div className={`recovery-message ${recoveryResult.ok ? 'ok' : 'failed'}`}>
                <ShieldCheck size={14} />
                <span>{recoveryResult.message}</span>
              </div>
            )}
          </div>

          {inventoryDevices.length > 1 && (
            <div className="device-selector" aria-label="Connected phones">
              <div className="section-label">Phones</div>
              {inventoryDevices.map((candidate) => (
                <button
                  type="button"
                  className={`device-choice ${device?.connectionId === candidate.connectionId ? 'active' : ''}`}
                  key={candidate.index}
                  title={`${deviceDisplayName(candidate)}. ${pluralize(candidate.storages.length, 'storage location')}.`}
                  onClick={() => selectDevice(candidate)}
                >
                  <Smartphone size={14} />
                  <span>{deviceDisplayName(candidate)}</span>
                  <small>{pluralize(candidate.storages.length, 'storage location')}</small>
                </button>
              ))}
            </div>
          )}

          <div className="storage-list">
            <div className="section-label">Storage</div>
            {device?.storages.map((storage) => {
              const storageName = storage.description || storage.volumeIdentifier || `Storage ${storage.id}`;
              const usagePercent = storageUsagePercent(storage);
              return (
                <button
                  className={`storage-item ${location.storageId === storage.id ? 'active' : ''}`}
                  key={storage.id}
                  title={`${storageName}. ${formatStorageUsage(storage)}. ${formatStorageFree(storage)}.`}
                  onClick={() =>
                    navigate({
                      storageId: storage.id,
                      folderId: ROOT_PARENT_ID,
                      crumbs: [
                        {
                          label: storageName,
                          folderId: ROOT_PARENT_ID
                        }
                      ]
                    })
                  }
                >
                  <HardDrive size={15} />
                  <span className="storage-name">{storageName}</span>
                  <small className="storage-usage">{formatStorageUsage(storage)}</small>
                  {usagePercent !== null && (
                    <span
                      className="storage-meter"
                      role="meter"
                      aria-label={`${storageName} storage used`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={usagePercent}
                    >
                      <span style={{ width: `${usagePercent}%` }} />
                    </span>
                  )}
                  <small className="storage-free">{formatStorageFree(storage)}</small>
                </button>
              );
            })}
            {!device?.storages.length && (
              <div className="empty-note">
                {usbAccessDenied
                  ? 'Phone USB is visible. Files appear after the MTP file session opens.'
                  : 'No mounted MTP storage.'}
              </div>
            )}
          </div>

          {showDiagnostics && (
            <div className="diagnostics">
              <div className="diagnostics-header">
                <div className="section-label">Technical Details</div>
                <button
                  type="button"
                  className="text-button diagnostic-copy-button"
                  disabled={diagnosticsBusy}
                  onClick={() => void copyDiagnosticReport()}
                >
                  {diagnosticsBusy ? <Loader2 size={13} className="spin" /> : <ClipboardList size={13} />}
                  <span>Copy Report</span>
                </button>
              </div>
              <div className="diagnostic-line">
                <span>Helper</span>
                <code>{inventory?.helperPath ?? status?.helperPath ?? '—'}</code>
              </div>
              <div className="diagnostic-line">
                <span>Log</span>
                <code>{inventory?.logPath ?? status?.logPath ?? '—'}</code>
              </div>
              {rawDevice && (
                <div className="diagnostic-line">
                  <span>Raw USB</span>
                  <code>
                    {rawDevice.vendorId.toString(16)}:{rawDevice.productId.toString(16)}@
                    {rawDevice.bus}:{rawDevice.device} · {rawDevice.connectionMode ?? 'unknown'}
                  </code>
                </div>
              )}
              {rawDevice?.usbSessionId && (
                <div className="diagnostic-line">
                  <span>USB session</span>
                  <code>{rawDevice.usbSessionId}</code>
                </div>
              )}
              <div className="diagnostic-line">
                <span>File session</span>
                <code>{fileSessionStatus}</code>
              </div>
              {rawDevice?.serial && (
                <div className="diagnostic-line">
                  <span>Phone serial</span>
                  <code>{rawDevice.serial}</code>
                </div>
              )}
              {rawDevice?.needsDeviceAccessEntitlement !== undefined && (
                <div className="diagnostic-line">
                  <span>Mac USB protection</span>
                  <code>{rawDevice.needsDeviceAccessEntitlement ? 'Required' : 'Not reported'}</code>
                </div>
              )}
              {(inventory?.stderr || status?.stderr) && (
                <div className="stderr">
                  <AlertTriangle size={14} />
                  <span>{inventory?.stderr || status?.stderr}</span>
                </div>
              )}
            </div>
          )}
        </aside>

        <section
          className={`browser-pane ${isDraggingMacFiles ? 'upload-hover' : ''}`}
          ref={phoneBrowserRef}
          tabIndex={0}
          onFocus={() => setActivePane('phone')}
          onKeyDown={handlePhonePaneKeyDown}
          onMouseDown={focusPhonePaneFromPointer}
          onDragEnter={browserDragEnter}
          onDragOver={browserDragOver}
          onDragLeave={browserDragLeave}
          onDrop={browserDrop}
          onContextMenu={(event) => openPhoneContextMenu(event)}
        >
          <div className="browser-toolbar">
            <div className="nav-buttons">
              <button className="icon-button" title="Back" disabled={!backStack.length} onClick={goBack}>
                <ChevronLeft size={17} />
              </button>
              <button
                className="icon-button"
                title="Forward"
                disabled={!forwardStack.length}
                onClick={goForward}
              >
                <ChevronRight size={17} />
              </button>
              <button
                className="icon-button"
                title="Up"
                disabled={location.storageId === null}
                onClick={goUp}
              >
                <ArrowUp size={16} />
              </button>
            </div>

            <div className="toolbar-spacer" aria-hidden="true" />

            <label className="search-box">
              <Search size={15} />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter"
              />
            </label>

            <div className="view-switch" role="group" aria-label="Phone file view">
              <button
                type="button"
                className={phoneViewMode === 'list' ? 'active' : ''}
                aria-label="Show phone files as a list"
                aria-pressed={phoneViewMode === 'list'}
                title="List view"
                onClick={() => setPhoneViewMode('list')}
              >
                <LayoutList size={14} />
              </button>
              <button
                type="button"
                className={phoneViewMode === 'grid' ? 'active' : ''}
                aria-label="Show phone files as a grid"
                aria-pressed={phoneViewMode === 'grid'}
                title="Grid view"
                onClick={() => setPhoneViewMode('grid')}
              >
                <LayoutGrid size={14} />
              </button>
            </div>

            <button
              type="button"
              className={`icon-button hidden-files-toggle ${showHiddenFiles ? 'active' : ''}`}
              aria-label={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
              aria-pressed={showHiddenFiles}
              title={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
              onClick={toggleHiddenFiles}
            >
              {showHiddenFiles ? <Eye size={15} /> : <EyeOff size={15} />}
            </button>

            <button
              className="text-button toolbar-action"
              title="Create a folder in the current phone folder"
              disabled={!canCreatePhoneFolder || newFolderBusy}
              onClick={openNewFolderDialog}
            >
              <FolderPlus size={15} />
              <span>New Folder</span>
            </button>

          </div>

          <div className="phone-path-bar">
            <div className="breadcrumbs" ref={phoneBreadcrumbsRef} aria-label="Phone folder path">
              <button
                title="Device"
                aria-current={location.crumbs.length === 0 ? 'page' : undefined}
                onClick={() => navigate(rootLocation)}
              >
                Device
              </button>
              {location.crumbs.map((crumb, index) => (
                <button
                  key={`${crumb.folderId}-${index}`}
                  title={crumb.label}
                  aria-current={index === location.crumbs.length - 1 ? 'page' : undefined}
                  onClick={() => {
                    const nextCrumbs = location.crumbs.slice(0, index + 1);
                    navigate({
                      storageId: location.storageId,
                      folderId: crumb.folderId,
                      crumbs: nextCrumbs
                    });
                  }}
                >
                  {crumb.label}
                </button>
              ))}
            </div>
          </div>

          <div className="pane-transfer-bar phone-transfer-bar">
            <div className="transfer-mode-switch" role="group" aria-label="Phone file transfer action">
              <button
                type="button"
                className={phoneTransferOperation === 'copy' ? 'active' : ''}
                aria-pressed={phoneTransferOperation === 'copy'}
                onClick={() => setPhoneTransferOperation('copy')}
              >
                Copy
              </button>
              <button
                type="button"
                className={phoneTransferOperation === 'move' ? 'active' : ''}
                aria-pressed={phoneTransferOperation === 'move'}
                title="Move files only. The source is deleted after the destination copy is verified."
                onClick={() => setPhoneTransferOperation('move')}
              >
                Move
              </button>
            </div>
            <button
              type="button"
              className="primary-button transfer-destination-button"
              disabled={!canRunPhoneTransfer}
              title={
                phoneTransferOperation === 'move' && selectedTransferRows.length > 0 && !phoneSelectionIsFilesOnly
                  ? 'Move works with files only. Choose Copy for folders.'
                  : `${phoneTransferOperation === 'move' ? 'Move' : 'Copy'} selected phone files to ${localPath || destination || 'a Mac folder'}`
              }
              aria-label={`${phoneTransferOperation === 'move' ? 'Move' : 'Copy'} selected phone files to Mac folder ${macDestinationLabel}`}
              onClick={() => void copySelectedToMac(phoneTransferOperation)}
            >
              <ArrowRight size={15} aria-hidden="true" />
              <Folder size={15} aria-hidden="true" />
              <span>{macDestinationLabel}</span>
            </button>
            <span className="transfer-bar-status" title={`${phoneSelectionSummary}. ${phoneSelectionGuidance}`}>
              {phoneTransferOperation === 'move' && selectedTransferRows.length > 0 && !phoneSelectionIsFilesOnly
                ? 'Move supports files only; folders can still be copied.'
                : selectedRows.length
                  ? phoneSelectionSummary
                  : 'Select phone files or folders'}
            </span>
          </div>

          <div className="table-wrap">
            {isDraggingMacFiles && (
              <div
                className={`upload-drop-banner ${canUploadToCurrentFolder ? 'ready' : 'blocked'}`}
                role="status"
                aria-live="polite"
              >
                {canUploadToCurrentFolder ? <Upload size={15} /> : <AlertTriangle size={15} />}
                <span>
                  {canUploadToCurrentFolder
                    ? 'Drop Mac files or folders here to copy them to this phone folder.'
                    : 'Open Internal storage or a phone folder before dropping Mac files or folders.'}
                </span>
              </div>
            )}
            {browserLoading && (
              <div className="folder-loading-banner" role="status" aria-live="polite">
                <div className="folder-loading-copy">
                  <Loader2 size={15} className="spin" />
                  <strong>{browserLoadingTitle}</strong>
                  <span>{browserLoadingDetails}</span>
                  <small>
                    {currentFolderProgressPercent !== null
                      ? `${currentFolderProgressPercent}% · `
                      : ''}
                    {formatElapsed(loadingElapsedSeconds)}
                  </small>
                  {folderLoading && (
                    <button
                      type="button"
                      className="folder-stop-button"
                      onClick={() => void stopFolderListing()}
                    >
                      <X size={13} />
                      <span>Stop</span>
                    </button>
                  )}
                </div>
                <div
                  className="folder-progress-track"
                  role="progressbar"
                  aria-valuetext={
                    currentFolderProgressPercent !== null
                      ? `Listing files: ${currentFolderProgressPercent}%`
                      : folderLoading
                        ? 'Listing files. Waiting for the phone to report progress.'
                      : 'Checking the phone connection.'
                  }
                  aria-valuemin={currentFolderProgressPercent !== null ? 0 : undefined}
                  aria-valuemax={currentFolderProgressPercent !== null ? 100 : undefined}
                  aria-valuenow={currentFolderProgressPercent ?? undefined}
                >
                  <div
                    className={`folder-progress-fill ${
                      currentFolderProgressPercent !== null ? 'determinate' : ''
                    }`}
                    style={
                      currentFolderProgressPercent !== null
                        ? { width: `${currentFolderProgressPercent}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            )}
            {hasDevice && !browserLoading && currentFolderError && !isDraggingMacFiles && (
              <div className="folder-error-banner" role="status" aria-live="polite">
                <AlertTriangle size={14} />
                <span>{currentFolderError}</span>
                {location.storageId !== null && (
                  <button
                    type="button"
                    className="folder-retry-button"
                    onClick={() => void loadFolder(location.storageId as number, location.folderId, true)}
                  >
                    <RotateCcw size={13} />
                    <span>Retry</span>
                  </button>
                )}
              </div>
            )}
            {hasDevice && !browserLoading && !currentFolderError && !isDraggingMacFiles && (
              <div className="folder-summary-bar" role="status" aria-live="polite">
                <strong>{currentLocationSummary}</strong>
                <span title={phoneSelectionSummary || phoneSelectionGuidance}>
                  {phoneSelectionSummary ? `${phoneSelectionSummary}. ${phoneSelectionGuidance}` : phoneSelectionGuidance}
                </span>
              </div>
            )}
            {noPhoneConnection ? (
              <div className="connection-help" role="status" aria-live="polite">
                <div className="connection-help-header">
                  <Smartphone size={22} />
                  <div>
                    <h2>Phone is not ready yet.</h2>
                    <p>
                      Connect the phone with USB, unlock it, then choose File transfer or
                      Transferring files on the phone.
                    </p>
                  </div>
                </div>

                <ol className="help-steps">
                  <li>Use a USB cable that supports data, not charge-only.</li>
                  <li>Unlock the phone and keep the screen awake.</li>
                  <li>
                    On the phone, open the USB notification and choose File transfer or Transferring
                    files.
                  </li>
                  <li>{usbModeHelpText}</li>
                  <li>If Android asks whether to allow access, tap Allow.</li>
                  <li>This app checks again automatically every 3 seconds.</li>
                </ol>

                <p className="auto-check-note">No need to refresh. The app checks again every 3 seconds.</p>
              </div>
            ) : fileTransferInactive ? (
              <div className="connection-help" role="status" aria-live="polite">
                <div className="connection-help-header">
                  <Smartphone size={22} />
                  <div>
                    <h2>USB connected. Choose File transfer on your phone.</h2>
                    <p>
                      The Mac sees {rawDeviceName}, so the cable and USB port are working. The phone
                      is still not allowing this app to see files.
                    </p>
                  </div>
                </div>

                <ol className="help-steps">
                  <li>Unlock the phone and keep the screen awake.</li>
                  <li>Swipe down from the top of the phone to open notifications. On Samsung, swipe down twice if needed.</li>
                  <li>
                    Tap the Android System or USB notification.
                  </li>
                  <li>Choose File transfer, Transferring files, or Android Auto.</li>
                  <li>{usbModeHelpText}</li>
                  <li>If Android asks whether to allow access, tap Allow.</li>
                  <li>Wait a few seconds. This app checks again automatically every 3 seconds.</li>
                </ol>

                <p className="auto-check-note">No need to refresh. The app checks again every 3 seconds.</p>
              </div>
            ) : cannotOpenPhone ? (
              <div className="connection-help" role="status" aria-live="polite">
                <div className="connection-help-header">
                  <AlertTriangle size={22} />
                  <div>
                    {usbAccessDenied ? (
                      <>
                        <h2>Phone is connected. Files are not open yet.</h2>
                        <p>
                          {rawDeviceName} is visible over USB in File Transfer mode, but the
                          MTP file session is not open. {blockedAccessReason}
                        </p>
                      </>
                    ) : (
                      <>
                        <h2>Unlock the phone and allow file access.</h2>
                        <p>
                          Your Mac sees {rawDeviceName}, but Android has not opened its files to this
                          Mac yet.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <ol className="connection-stages main" aria-label="Phone connection progress">
                  {connectionStages.map((stage) => (
                    <li className={`connection-stage ${stage.state}`} key={stage.key}>
                      <span className="connection-stage-dot" aria-hidden="true" />
                      <div>
                        <span className="connection-stage-title">
                          {stage.label}
                          <small>{stageStateLabel(stage.state)}</small>
                        </span>
                        <p>{stage.detail}</p>
                      </div>
                    </li>
                  ))}
                </ol>

                {usbAccessDenied ? (
                  <ol className="help-steps">
                    <li>Keep the phone unlocked and leave it in File Transfer mode.</li>
                    <li>If the phone asks to allow access, tap Allow.</li>
                    <li>If the same Allow question keeps coming back, stop there; the session is not staying open.</li>
                    <li>Close Photos, Image Capture, Android File Transfer, OpenMTP, or any other phone-transfer app.</li>
                    <li>Press Open files below.</li>
                    <li>Choose Continue in the explanation window.</li>
                    <li>
                      If the Mac password window says osascript wants to make changes, enter the password
                      you use to unlock this Mac.
                    </li>
                    <li>If you canceled or waited too long, press Open files again.</li>
                    <li>Only unplug the cable if the phone disappears from the left side.</li>
                  </ol>
                ) : (
                  <ol className="help-steps">
                    <li>Unlock the phone and keep the screen awake.</li>
                    <li>If Android asks to allow access to phone data, tap Allow.</li>
                    <li>
                      On the phone, open the USB notification and choose File transfer or Transferring
                      files.
                    </li>
                    <li>
                      Close Photos, Image Capture, Android File Transfer, OpenMTP, or any other
                      phone-transfer app.
                    </li>
                    <li>Wait a few seconds. This app checks again automatically every 3 seconds.</li>
                  </ol>
                )}

                <div className="help-actions">
                  {shouldShowRecover && (
                    <button
                      className="primary-button protected-action"
                      disabled={!canAdminRecover}
                      onClick={() => void recoverWithAdmin()}
                    >
                      {isRecovering ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <ShieldCheck size={15} />
                      )}
                      <span>{isRecovering ? 'Opening files...' : 'Open files'}</span>
                    </button>
                  )}
                  <button
                    className={shouldShowRecover ? 'text-button' : 'primary-button'}
                    onClick={() => void handleManualRefresh()}
                  >
                    {isScanning ? <Loader2 size={15} className="spin" /> : <RefreshCcw size={15} />}
                    <span>{refreshButtonLabel()}</span>
                  </button>
                </div>

                {shouldShowRecover && (
                  <p className="recovery-explain">
                    Check now repeats the automatic check. Open files asks macOS to open one protected phone-file
                    session. If the Mac password window says osascript, that is the system prompt for
                    this step; use your normal Mac login password or choose Cancel. If Open files fails,
                    the phone can still be visible over USB while its MTP file session stays closed.
                  </p>
                )}
              </div>
            ) : phoneViewMode === 'grid' && rows.length > 0 ? (
              <div className="file-grid" role="grid" aria-label="Phone files">
                {rows.map((row) => (
                  <div
                    key={row.key}
                    role="gridcell"
                    className={`file-tile ${row.kind} ${selectedKeys.has(row.key) ? 'selected' : ''}`}
                    draggable={row.kind === 'file' || row.kind === 'folder'}
                    onDragStart={(event) => startFileDrag(row, event)}
                    onContextMenu={(event) => openPhoneContextMenu(event, row)}
                    onClick={(event) =>
                      toggleRowSelection(row, event.metaKey || event.ctrlKey, event.shiftKey)
                    }
                    onDoubleClick={() => openRow(row)}
                    title={row.name}
                  >
                    <span className={`file-tile-icon ${row.kind}`}>
                      <FileIcon row={row} />
                    </span>
                    <span className="file-tile-name">{row.name}</span>
                    <span className="file-tile-meta">
                      {row.kind === 'folder'
                        ? 'Folder'
                        : row.kind === 'storage'
                          ? formatStorageTotal(row.storage)
                          : `${formatBytes(row.size)} · ${row.type}`}
                    </span>
                    <span className="file-tile-date">{formatDate(row.modified)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <table className="file-table">
                <colgroup>
                  <col className="select-column" />
                  <col className="name-column" />
                  <col className="size-column" />
                  <col className="modified-column" />
                  <col className="type-column" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="select-col" />
                    <th>
                      <button onClick={() => toggleSort('name')}>Name</button>
                    </th>
                    <th>
                      <button onClick={() => toggleSort('size')}>Size</button>
                    </th>
                    <th>
                      <button onClick={() => toggleSort('modified')}>Modified</button>
                    </th>
                    <th>
                      <button onClick={() => toggleSort('type')}>Type</button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.key}
                      className={selectedKeys.has(row.key) ? 'selected' : ''}
                      draggable={row.kind === 'file' || row.kind === 'folder'}
                      onDragStart={(event) => startFileDrag(row, event)}
                      onContextMenu={(event) => openPhoneContextMenu(event, row)}
                      onClick={(event) =>
                        toggleRowSelection(row, event.metaKey || event.ctrlKey, event.shiftKey)
                      }
                      onDoubleClick={() => openRow(row)}
                    >
                      <td className="select-col">
                        {selectedKeys.has(row.key) ? <CheckCircle2 size={14} /> : <Circle size={12} />}
                      </td>
                      <td className="name-cell" title={row.name}>
                        <div className="name-cell-content">
                          <span className={`file-icon ${row.kind}`}>
                            <FileIcon row={row} />
                          </span>
                          <span className="file-name">{row.name}</span>
                        </div>
                      </td>
                      <td>{formatBrowserRowSize(row)}</td>
                      <td>{formatDate(row.modified)}</td>
                      <td>{row.type}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={5} className="empty-table">
                        {isScanning
                          ? 'Scanning device...'
                          : folderLoading
                            ? 'Listing folder. Large photo or video folders can take a while.'
                            : currentFolderError || 'No items in this location.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <button
          type="button"
          className={`pane-resizer ${isResizingPane ? 'dragging' : ''}`}
          aria-label="Resize Mac pane"
          title="Drag to resize the Mac pane. Use arrow keys when focused."
          onPointerDown={startPaneResize}
          onKeyDown={handlePaneResizeKeyDown}
        >
          <span />
        </button>

        <aside
          ref={queuePaneRef}
          className={`queue-pane ${queueActive ? 'working' : ''} ${isDraggingTransfer ? 'dragging-files' : ''}`}
        >
          <div className="queue-header">
            <div className="local-pane">
              <div className="local-title-row">
                <div>
                  <div className="section-label">Mac</div>
                  <strong>{folderLabelForPath(localPath || destination)}</strong>
                </div>
                <div className="local-title-actions">
                  <span className="local-count">
                    {localLoading
                      ? 'Loading'
                      : `${localEntries.length} ${localEntries.length === 1 ? 'item' : 'items'}`}
                  </span>
                  <div className="nav-buttons local-nav-buttons">
                    <button
                      className="icon-button"
                      title="Back"
                      aria-label="Back in Mac folder history"
                      disabled={!localBackStack.length}
                      onClick={() => void goBackLocalDirectory()}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      className="icon-button"
                      title="Forward"
                      aria-label="Forward in Mac folder history"
                      disabled={!localForwardStack.length}
                      onClick={() => void goForwardLocalDirectory()}
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      className="icon-button"
                      title="Up"
                      aria-label="Parent Mac folder"
                      disabled={!localParentPath || localParentPath === localPath}
                      onClick={() => void goUpLocalDirectory()}
                    >
                      <ArrowUp size={14} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="destination-actions">
                <button className="destination-button" onClick={() => void chooseMacFolder()}>
                  <Folder size={15} />
                  <span title={localPath || destination}>{localPath || destination}</span>
                </button>
              </div>
              {commonMacFolders.length > 0 && (
                <div className="common-folder-shortcuts" aria-label="Common Mac folders">
                  {commonMacFolders.map((folder) => (
                    <button
                      type="button"
                      key={folder.id}
                      className={localPath === folder.path ? 'active' : ''}
                      title={folder.path}
                      onClick={() => void navigateLocalDirectory(folder.path)}
                    >
                      <CommonMacFolderIcon folder={folder} />
                      <span>{folder.label}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="local-breadcrumbs" ref={localBreadcrumbsRef} aria-label="Mac folder path">
                {localCrumbs.map((crumb, index) => (
                  <button
                    type="button"
                    key={`${crumb.path}-${index}`}
                    title={crumb.path}
                    aria-current={index === localCrumbs.length - 1 ? 'page' : undefined}
                    onClick={() => void navigateLocalDirectory(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                ))}
              </div>

              <div className="local-actions pane-transfer-bar local-transfer-bar">
                <div className="transfer-mode-switch" role="group" aria-label="Mac file transfer action">
                  <button
                    type="button"
                    className={macTransferOperation === 'copy' ? 'active' : ''}
                    aria-pressed={macTransferOperation === 'copy'}
                    onClick={() => setMacTransferOperation('copy')}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className={macTransferOperation === 'move' ? 'active' : ''}
                    aria-pressed={macTransferOperation === 'move'}
                    title="Move files only. The Mac source is deleted after the phone copy is verified."
                    onClick={() => setMacTransferOperation('move')}
                  >
                    Move
                  </button>
                </div>
                <button
                  className="primary-button local-copy-button transfer-destination-button"
                  disabled={!canRunMacTransfer}
                  title={
                    macTransferOperation === 'move' && selectedLocalEntries.length > 0 && !macSelectionIsFilesOnly
                      ? 'Move works with files only. Choose Copy for folders.'
                      : `${macTransferOperation === 'move' ? 'Move' : 'Copy'} selected Mac files to ${phoneDestinationLabel}`
                  }
                  aria-label={`${macTransferOperation === 'move' ? 'Move' : 'Copy'} selected Mac files to phone folder ${phoneDestinationLabel}`}
                  onClick={() => void copyLocalFilesToPhone(selectedLocalEntries, macTransferOperation)}
                >
                  <Folder size={14} aria-hidden="true" />
                  <span>{phoneDestinationLabel}</span>
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                <span className="transfer-bar-status" title={localSelectionStatus}>
                  {macTransferOperation === 'move' && selectedLocalEntries.length > 0 && !macSelectionIsFilesOnly
                    ? 'Move supports files only; folders can still be copied.'
                    : selectedLocalEntries.length
                      ? localSelectionSummary
                      : 'Select Mac files or folders'}
                </span>
              </div>

              <div
                className="local-list"
                role="list"
                aria-label="Mac files"
                ref={localListRef}
                tabIndex={0}
                onFocus={() => setActivePane('mac')}
                onKeyDown={handleLocalPaneKeyDown}
                onContextMenu={(event) => openMacContextMenu(event)}
              >
                {localLoading && (
                  <div className="local-empty">
                    <Loader2 size={14} className="spin" />
                    <span>Loading Mac folder...</span>
                  </div>
                )}
                {!localLoading && localEntries.length > 0 && (
                  <div className="local-column-header">
                    <span />
                    <button
                      type="button"
                      className={localSortKey === 'name' ? 'active' : ''}
                      title={localSortTitle('name', 'name')}
                      aria-sort={localAriaSort('name')}
                      onClick={() => toggleLocalSort('name')}
                    >
                      Name
                    </button>
                    <button
                      type="button"
                      className={localSortKey === 'modified' ? 'active' : ''}
                      title={localSortTitle('modified', 'modified date')}
                      aria-sort={localAriaSort('modified')}
                      onClick={() => toggleLocalSort('modified')}
                    >
                      Modified
                    </button>
                    <button
                      type="button"
                      className={localSortKey === 'type' ? 'active' : ''}
                      title={localSortTitle('type', 'kind')}
                      aria-sort={localAriaSort('type')}
                      onClick={() => toggleLocalSort('type')}
                    >
                      Kind
                    </button>
                    <button
                      type="button"
                      className={localSortKey === 'size' ? 'active' : ''}
                      title={localSortTitle('size', 'size')}
                      aria-sort={localAriaSort('size')}
                      onClick={() => toggleLocalSort('size')}
                    >
                      Size
                    </button>
                  </div>
                )}
                {!localLoading &&
                  sortedLocalEntries.map((entry) => (
                    <button
                      type="button"
                      role="listitem"
                      key={entry.path}
                      draggable
                      className={`local-row ${selectedLocalPaths.has(entry.path) ? 'selected' : ''}`}
                      onClick={(event) =>
                        toggleLocalSelection(entry, event.metaKey || event.ctrlKey, event.shiftKey)
                      }
                      onContextMenu={(event) => openMacContextMenu(event, entry)}
                      onDoubleClick={() => openLocalEntry(entry)}
                      onDragStart={(event) => startLocalEntryDrag(entry, event)}
                      title={entry.path}
                    >
                      <FileIcon
                        row={{
                          key: entry.path,
                          kind: entry.kind,
                          name: entry.name,
                          size: entry.size,
                          modified: entry.modified,
                          type: entry.type
                        }}
                      />
                      <span className="local-name">{entry.name}</span>
                      <span className="local-modified">{formatDate(entry.modified)}</span>
                      <span className="local-kind">
                        {entry.kind === 'folder' ? 'Folder' : entry.type || extensionFor(entry.name)}
                      </span>
                      <span className="local-size">{entry.kind === 'folder' ? '—' : formatBytes(entry.size)}</span>
                    </button>
                  ))}
                {!localLoading && !localEntries.length && (
                  <div className="local-empty">
                    <span>{localError || 'No Mac files in this folder.'}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="drop-zone">
            <Download size={18} />
            <span>
              {isDraggingTransfer
                ? `Drop here to copy into ${folderLabelForPath(localPath || destination)}`
                : 'Drag phone files directly to Finder, Desktop, another app, or this Mac folder.'}
            </span>
          </div>

          {phoneDownloadPlanning && (
            <div className="transfer-planning-notice" role="status" aria-live="polite">
              <div className="transfer-planning-copy">
                <Loader2 size={14} className="spin" />
                <div>
                  <strong>Preparing folder copy</strong>
                  <span>
                    {phoneDownloadPlanning.files} {phoneDownloadPlanning.files === 1 ? 'file' : 'files'} found in{' '}
                    {phoneDownloadPlanning.folders} {phoneDownloadPlanning.folders === 1 ? 'folder' : 'folders'}.
                    Keep the phone unlocked.
                  </span>
                  <small>Listing {phoneDownloadPlanning.currentName}</small>
                </div>
                <button
                  type="button"
                  className="transfer-planning-stop-button"
                  onClick={() => void stopPhoneDownloadPlanning()}
                >
                  <X size={12} />
                  <span>Stop</span>
                </button>
              </div>
              <div
                className="transfer-planning-track"
                role="progressbar"
                aria-label="Preparing folder copy"
              >
                <div className="transfer-planning-fill" />
              </div>
            </div>
          )}

          {transferNotice && (
            <div className={`transfer-notice ${transferNotice.phase}`} role="status" aria-live="polite">
              {transferNotice.phase === 'failed' ? <AlertTriangle size={14} /> : <Download size={14} />}
              <span>{transferNotice.message}</span>
            </div>
          )}

          {visibleQueueJobs.length > 0 && (
            <div className="queue-summary" role="status" aria-live="polite">
              <div className="queue-summary-top">
                <div className="queue-summary-title">
                  <strong>
                    {queueSummary.activeTransfers
                      ? 'Transferring'
                      : queueSummary.queuedTransfers
                        ? 'Queued'
                        : queueSummary.failed
                          ? 'Needs attention'
                          : queueSummary.canceled && !queueSummary.completed
                            ? 'Canceled'
                            : queueSummary.completed
                              ? 'Completed'
                              : 'Transfer queue'}
                  </strong>
                  <span>
                    {queueSummary.completed} done
                    {' · '}
                    {queueSummary.failed} failed · {queueSummary.canceled} canceled
                  </span>
                </div>
                <span className="queue-summary-percent">{queueSummary.percent}%</span>
              </div>
              <div
                className="progress-track queue-total-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={queueSummary.percent}
                aria-label="Overall transfer progress"
              >
                <div className="progress-fill" style={{ width: `${queueSummary.percent}%` }} />
              </div>
              <div className="queue-summary-meta">
                <span>
                  {formatBytes(queueSummary.transferredBytes)} copied of {formatBytes(queueSummary.totalBytes)}
                </span>
                <span>{formatBytes(queueSummary.speedBytesPerSecond)}/s</span>
                <span>ETA {formatDuration(queueSummary.etaSeconds)}</span>
              </div>
              <div className="queue-summary-actions">
                <button
                  className="text-button"
                  disabled={!queueSummary.finished}
                  onClick={clearFinishedTransfers}
                >
                  <CheckCircle2 size={13} />
                  <span>Clear Finished</span>
                </button>
                <button
                  className="text-button danger-button"
                  disabled={!queueSummary.cancellable}
                  onClick={() => void cancelAllTransfers()}
                >
                  <X size={13} />
                  <span>Cancel All</span>
                </button>
              </div>
            </div>
          )}

          <div className={`queue-list ${visibleQueueJobs.length ? 'has-jobs' : 'empty'}`}>
            {visibleQueueJobs.map((job) => (
              <div
                className={`queue-item ${job.status} ${job.sourceRemovalStatus === 'kept' ? 'source-kept' : ''}`}
                key={job.id}
              >
                <div className="queue-row">
                  <FileIcon
                    row={{
                      key: job.id,
                      kind: 'file',
                      name: job.name,
                      size: job.size,
                      modified: 0,
                      type: extensionFor(job.name)
                    }}
                  />
                  <div className="queue-main">
                    <strong>{job.name}</strong>
                    <span>
                      {job.operation === 'move' && job.sourceRemovalStatus === 'removed'
                        ? 'moved'
                        : job.operation === 'move' && job.sourceRemovalStatus === 'kept'
                          ? 'copied; source kept'
                          : job.status}{' '}
                      ·{' '}
                      {job.direction === 'upload'
                        ? 'to phone'
                        : 'to Mac'}{' '}
                      ·{' '}
                      {formatBytes(job.bytesTransferred)} / {formatBytes(job.totalBytes || job.size)}
                    </span>
                    {job.direction === 'download' && job.renamedDestination && (
                      <span className="queue-rename-note">
                        Saved as {fileNameFromPath(job.destinationPath)} so nothing is overwritten.
                      </span>
                    )}
                  </div>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        ((job.bytesTransferred || 0) / Math.max(job.totalBytes || job.size || 1, 1)) * 100
                      )}%`
                    }}
                  />
                </div>
                <div className="queue-meta">
                  {job.status === 'completed' ? (
                    <span>Finished</span>
                  ) : job.status === 'failed' ? (
                    <span>Failed</span>
                  ) : job.status === 'canceled' ? (
                    <span>Canceled</span>
                  ) : (
                    <>
                      <span>{formatBytes(job.speedBytesPerSecond)}/s</span>
                      <span>ETA {formatDuration(job.etaSeconds)}</span>
                    </>
                  )}
                </div>
                {job.error && (
                  <div className="job-error">
                    {job.error}{job.promiseId ? ' Drag again.' : ''}
                  </div>
                )}
                {job.status === 'completed' && job.resultMessage && (
                  <div className={`job-result ${job.sourceRemovalStatus === 'kept' ? 'warning' : ''}`}>
                    {job.resultMessage}
                  </div>
                )}
                <div className="job-actions">
                  {(job.status === 'queued' || job.status === 'active') && (
                    <button className="icon-button" title="Cancel" onClick={() => void window.mtp.cancelTransfer(job.id)}>
                      <X size={14} />
                    </button>
                  )}
                  {!job.promiseId && (job.status === 'failed' || job.status === 'canceled') && (
                    <button
                      className="icon-button"
                      title="Retry"
                      onClick={() => void window.mtp.retryTransfer(job.id)}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                  {job.status === 'completed' && job.direction === 'download' && (
                    <button
                      className="icon-button"
                      title="Reveal in Finder"
                      onClick={() => void window.mtp.revealInFinder(job.destinationPath)}
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!visibleQueueJobs.length && <div className="empty-note">Transfer queue is empty.</div>}
          </div>
        </aside>
      </section>

      {renderContextMenu()}

      {newFolderDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="folder-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-folder-title"
            onSubmit={(event) => void createPhoneFolderFromDialog(event)}
          >
            <div className="folder-dialog-header">
              <FolderPlus size={18} />
              <h2 id="new-folder-title">New phone folder</h2>
            </div>
            <label className="folder-name-field">
              <span>Name</span>
              <input
                autoFocus
                value={newFolderName}
                onChange={(event) => {
                  setNewFolderName(event.target.value);
                  setNewFolderError(null);
                }}
                placeholder="Folder name"
                disabled={newFolderBusy}
              />
            </label>
            {newFolderError && (
              <div className="folder-dialog-error" role="alert">
                <AlertTriangle size={14} />
                <span>{newFolderError}</span>
              </div>
            )}
            <div className="folder-dialog-actions">
              <button type="button" className="text-button" disabled={newFolderBusy} onClick={closeNewFolderDialog}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={newFolderBusy}>
                {newFolderBusy ? <Loader2 size={14} className="spin" /> : <FolderPlus size={14} />}
                <span>{newFolderBusy ? 'Creating...' : 'Create'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
