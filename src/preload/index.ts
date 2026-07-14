import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AppMenuCommand,
  CreateFolderRequest,
  FolderListProgress,
  MtpApi,
  PhoneFilePromiseDragEvent,
  PhoneFilePromiseDragRequest,
  TransferEvent,
  TransferRequest,
  UploadRequest
} from '../shared/types';

const api: MtpApi = {
  getStatus: () => ipcRenderer.invoke('mtp:getStatus'),
  scanInventory: () => ipcRenderer.invoke('mtp:scanInventory'),
  listFolder: (deviceIndex: number, deviceConnectionId: string, storageId: number, parentId: number) =>
    ipcRenderer.invoke('mtp:listFolder', deviceIndex, deviceConnectionId, storageId, parentId),
  cancelFolderListing: () => ipcRenderer.invoke('mtp:cancelFolderListing'),
  onFolderListProgress: (callback: (progress: FolderListProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: FolderListProgress) =>
      callback(progress);
    ipcRenderer.on('folder-list:progress', listener);
    return () => ipcRenderer.off('folder-list:progress', listener);
  },
  listLocalDirectory: (directoryPath?: string, showHiddenFiles?: boolean) =>
    ipcRenderer.invoke('local:listDirectory', directoryPath, showHiddenFiles),
  inspectLocalPath: (path: string) => ipcRenderer.invoke('local:inspectPath', path),
  ensureLocalDirectory: (directoryPath: string) => ipcRenderer.invoke('local:ensureDirectory', directoryPath),
  setLocalModifiedTime: (path: string, modified: number) =>
    ipcRenderer.invoke('local:setModifiedTime', path, modified),
  getCommonMacFolders: () => ipcRenderer.invoke('local:getCommonFolders'),
  chooseDestination: () => ipcRenderer.invoke('mtp:chooseDestination'),
  getDesktopDestination: () => ipcRenderer.invoke('mtp:getDesktopDestination'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  startDownloads: (requests: TransferRequest[]) => ipcRenderer.invoke('mtp:startDownloads', requests),
  startUploads: (requests: UploadRequest[]) => ipcRenderer.invoke('mtp:startUploads', requests),
  startMoveDownloads: (requests: TransferRequest[]) => ipcRenderer.invoke('mtp:startMoveDownloads', requests),
  startMoveUploads: (requests: UploadRequest[]) => ipcRenderer.invoke('mtp:startMoveUploads', requests),
  createFolder: (request: CreateFolderRequest) => ipcRenderer.invoke('mtp:createFolder', request),
  startPhoneFilePromiseDrag: (request: PhoneFilePromiseDragRequest) =>
    ipcRenderer.send('mtp:startPhoneFilePromiseDrag', request),
  startLocalFileDrag: (filePaths: string[]) => ipcRenderer.send('mtp:startLocalFileDrag', filePaths),
  cancelTransfer: (jobId: string) => ipcRenderer.invoke('mtp:cancelTransfer', jobId),
  retryTransfer: (jobId: string) => ipcRenderer.invoke('mtp:retryTransfer', jobId),
  revealInFinder: (path: string) => ipcRenderer.invoke('mtp:revealInFinder', path),
  recoverWithAdmin: () => ipcRenderer.invoke('mtp:recoverWithAdmin'),
  openLog: () => ipcRenderer.invoke('mtp:openLog'),
  copyDiagnostics: () => ipcRenderer.invoke('mtp:copyDiagnostics'),
  onTransferEvent: (callback: (event: TransferEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TransferEvent) => callback(payload);
    ipcRenderer.on('transfer:event', listener);
    return () => ipcRenderer.off('transfer:event', listener);
  },
  onPhoneFilePromiseDragEvent: (callback: (event: PhoneFilePromiseDragEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PhoneFilePromiseDragEvent) => callback(payload);
    ipcRenderer.on('phone-file-promise:event', listener);
    return () => ipcRenderer.off('phone-file-promise:event', listener);
  },
  onAppMenuCommand: (callback: (command: AppMenuCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: AppMenuCommand) => callback(command);
    ipcRenderer.on('app-menu:command', listener);
    return () => ipcRenderer.off('app-menu:command', listener);
  }
};

contextBridge.exposeInMainWorld('mtp', api);
