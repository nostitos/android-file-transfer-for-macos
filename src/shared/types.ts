export type DeviceState =
  | 'checking'
  | 'bridge-missing'
  | 'no-device'
  | 'connect-error'
  | 'memory-error'
  | 'connected'
  | 'error';

export interface RawDevice {
  index: number;
  vendorId: number;
  productId: number;
  bus: number;
  device: number;
  serial?: string;
  usbSessionId?: string;
  vendor: string;
  product: string;
  connectionMode?: 'mtp' | 'usb-only';
  usbCurrentConfiguration?: number;
  usbPreferredConfiguration?: number;
  needsDeviceAccessEntitlement?: boolean;
  connectionId?: string;
}

export interface DeviceStatus {
  ok: boolean;
  state: DeviceState;
  message: string;
  deviceCount: number;
  rawDevices: RawDevice[];
  helperPath: string;
  logPath: string;
  sessionOpen?: boolean;
  protectedSessionOpen?: boolean;
  sessionConnectionId?: string;
  sessionConnectionIds?: string[];
  stderr?: string;
}

export interface MtpStorage {
  id: number;
  description: string;
  volumeIdentifier: string;
  maxCapacity: number;
  freeSpace: number;
  inferred?: boolean;
}

export type MtpObjectKind = 'folder' | 'file';

export interface MtpObject {
  id: number;
  parentId: number;
  storageId: number;
  name: string;
  kind: MtpObjectKind;
  size: number;
  modified: number;
  filetype: string;
}

export interface MtpDeviceInventory {
  index: number;
  name: string;
  serial: string;
  vendorId: number;
  productId: number;
  vendor: string;
  product: string;
  connectionId: string;
  protectedAccess?: boolean;
  storages: MtpStorage[];
  objects: MtpObject[];
}

export interface InventoryResult {
  ok: boolean;
  state: DeviceState;
  message: string;
  devices: MtpDeviceInventory[];
  helperPath: string;
  logPath: string;
  protectedAccess?: boolean;
  stderr?: string;
}

export interface FolderListResult {
  ok: boolean;
  state: DeviceState;
  message: string;
  deviceIndex: number;
  storageId: number;
  parentId: number;
  objects: MtpObject[];
  helperPath: string;
  logPath: string;
  stderr?: string;
}

export interface FolderListProgress {
  deviceConnectionId: string;
  storageId: number;
  parentId: number;
  sent: number;
  total: number;
}

export type LocalEntryKind = 'folder' | 'file';

export interface LocalEntry {
  path: string;
  name: string;
  kind: LocalEntryKind;
  size: number;
  modified: number;
  type: string;
}

export interface LocalDirectoryResult {
  ok: boolean;
  path: string;
  parentPath: string;
  message: string;
  entries: LocalEntry[];
}

export interface LocalModifiedTimeResult {
  ok: boolean;
  path: string;
  message: string;
  modified?: number;
}

export interface TransferRequest {
  deviceIndex: number;
  deviceConnectionId: string;
  storageId?: number;
  parentId?: number;
  objectId: number;
  name: string;
  size: number;
  modified?: number;
  destinationDirectory: string;
  operation?: TransferOperation;
}

export interface UploadRequest {
  deviceIndex: number;
  deviceConnectionId: string;
  storageId: number;
  parentId: number;
  sourcePath: string;
  name: string;
  size: number;
  operation?: TransferOperation;
}

export interface CreateFolderRequest {
  deviceIndex: number;
  deviceConnectionId: string;
  storageId: number;
  parentId: number;
  name: string;
}

export interface CreateFolderResult {
  ok: boolean;
  state: DeviceState;
  message: string;
  deviceIndex: number;
  storageId: number;
  parentId: number;
  folderId: number;
  name: string;
  helperPath: string;
  logPath: string;
  stderr?: string;
}

export type TransferDirection = 'download' | 'upload';

export type TransferOperation = 'copy' | 'move';

export type SourceRemovalStatus = 'pending' | 'removed' | 'kept';

export interface LocalSourceIdentity {
  device: number;
  inode: number;
  size: number;
  modifiedMs: number;
  changedMs: number;
}

export type TransferStatus = 'queued' | 'active' | 'completed' | 'failed' | 'canceled';

export interface TransferJob {
  id: string;
  direction: TransferDirection;
  operation: TransferOperation;
  deviceIndex: number;
  deviceConnectionId: string;
  objectId?: number;
  storageId?: number;
  parentId?: number;
  promiseId?: string;
  sourcePath?: string;
  sourceIdentity?: LocalSourceIdentity;
  sourceRemovalStatus?: SourceRemovalStatus;
  sourceRemovalError?: string;
  name: string;
  size: number;
  modified?: number;
  destinationDirectory: string;
  destinationPath: string;
  temporaryPath?: string;
  originalDestinationPath?: string;
  renamedDestination?: boolean;
  status: TransferStatus;
  bytesTransferred: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  error?: string;
  resultMessage?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type TransferEventType = 'queued' | 'started' | 'progress' | 'completed' | 'failed' | 'canceled';

export interface TransferEvent {
  type: TransferEventType;
  job: TransferJob;
}

export interface PhoneFilePromiseDragItem {
  deviceIndex: number;
  deviceConnectionId: string;
  storageId: number;
  objectId: number;
  parentId: number;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  modified: number;
}

export interface PhoneFilePromiseDragRequest {
  items: PhoneFilePromiseDragItem[];
  internalDestination?: {
    path: string;
    rect: { x: number; y: number; width: number; height: number };
  };
}

export type PhoneFilePromiseDragEvent =
  | { type: 'started' | 'canceled' | 'accepted'; message: string }
  | { type: 'internal-hover'; active: boolean }
  | { type: 'planning'; promiseId: string; files: number; folders: number; currentName: string }
  | { type: 'failed'; message: string; promiseId?: string };

export interface MoveQueueResult {
  confirmed: boolean;
  jobs: TransferJob[];
}

export interface DestinationResult {
  canceled: boolean;
  path?: string;
}

export type CommonMacFolderId = 'home' | 'downloads' | 'documents' | 'pictures' | 'movies' | 'desktop';

export interface CommonMacFolder {
  id: CommonMacFolderId;
  label: string;
  path: string;
}

export interface AdminRecoveryResult {
  ok: boolean;
  state: DeviceState;
  message: string;
  helperPath: string;
  logPath: string;
  inventory?: InventoryResult;
  stderr?: string;
  rawDevice?: RawDevice;
}

export interface DiagnosticsCopyResult {
  ok: boolean;
  copied: boolean;
  message: string;
  generatedAt: string;
  text: string;
}

export type AppMenuCommand =
  | 'new-folder'
  | 'copy-to-queue'
  | 'copy-selection'
  | 'paste-selection'
  | 'folder-up'
  | 'refresh'
  | 'select-all'
  | 'open-files'
  | 'open-log'
  | 'focus-phone'
  | 'focus-mac'
  | 'view-list'
  | 'view-grid'
  | 'toggle-hidden-files'
  | 'theme-system'
  | 'theme-light'
  | 'theme-dark';

export interface MtpApi {
  getStatus: () => Promise<DeviceStatus>;
  scanInventory: () => Promise<InventoryResult>;
  listFolder: (
    deviceIndex: number,
    deviceConnectionId: string,
    storageId: number,
    parentId: number
  ) => Promise<FolderListResult>;
  cancelFolderListing: () => Promise<boolean>;
  onFolderListProgress: (listener: (progress: FolderListProgress) => void) => () => void;
  listLocalDirectory: (directoryPath?: string, showHiddenFiles?: boolean) => Promise<LocalDirectoryResult>;
  inspectLocalPath: (path: string) => Promise<LocalEntry | null>;
  ensureLocalDirectory: (directoryPath: string) => Promise<LocalDirectoryResult>;
  setLocalModifiedTime: (path: string, modified: number) => Promise<LocalModifiedTimeResult>;
  getCommonMacFolders: () => Promise<CommonMacFolder[]>;
  chooseDestination: () => Promise<DestinationResult>;
  getDesktopDestination: () => Promise<string>;
  getPathForFile: (file: File) => string;
  startDownloads: (requests: TransferRequest[]) => Promise<TransferJob[]>;
  startUploads: (requests: UploadRequest[]) => Promise<TransferJob[]>;
  startMoveDownloads: (requests: TransferRequest[]) => Promise<MoveQueueResult>;
  startMoveUploads: (requests: UploadRequest[]) => Promise<MoveQueueResult>;
  createFolder: (request: CreateFolderRequest) => Promise<CreateFolderResult>;
  startPhoneFilePromiseDrag: (request: PhoneFilePromiseDragRequest) => void;
  startLocalFileDrag: (filePaths: string[]) => void;
  cancelTransfer: (jobId: string) => Promise<TransferJob | null>;
  retryTransfer: (jobId: string) => Promise<TransferJob | null>;
  revealInFinder: (path: string) => Promise<void>;
  recoverWithAdmin: () => Promise<AdminRecoveryResult>;
  openLog: () => Promise<void>;
  copyDiagnostics: () => Promise<DiagnosticsCopyResult>;
  onTransferEvent: (callback: (event: TransferEvent) => void) => () => void;
  onPhoneFilePromiseDragEvent: (callback: (event: PhoneFilePromiseDragEvent) => void) => () => void;
  onAppMenuCommand: (callback: (command: AppMenuCommand) => void) => () => void;
}
