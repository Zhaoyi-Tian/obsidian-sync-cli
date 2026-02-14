/* Sync types - copied from plugin for CLI usage */

export interface SnapFile {
  path: string;
  pathHash: string;
  contentHash: string;
  mtime: number;
  size: number;
  baseHash?: string | null;
  ctime?: number;
}

export interface SnapFolder {
  path: string;
  pathHash: string;
}

export interface PathHashFile {
  path: string;
  pathHash: string;
}

export interface ReceiveMessage {
  vault: string;
  path: string;
  pathHash: string;
  action: string;
  content: string;
  contentHash: string;
  ctime: number;
  mtime: number;
  lastTime: number;
}

export interface SyncMessage {
  action: string;
  data: any;
}

export interface ReceiveFileSyncUpdateMessage {
  path: string;
  vault: string;
  pathHash: string;
  contentHash: string;
  size: number;
  mtime: number;
  ctime: number;
  lastTime: number;
}

export interface FileUploadMessage {
  path: string;
  ctime: number;
  mtime: number;
  sessionId: string;
  chunkSize: number;
}

export interface FileSyncChunkDownloadMessage {
  path: string;
  ctime: number;
  mtime: number;
  sessionId: string;
  chunkSize: number;
  totalChunks: number;
  size: number;
  contentHash?: string;
}

export interface FileDownloadSession {
  path: string;
  ctime: number;
  mtime: number;
  lastTime: number;
  sessionId: string;
  totalChunks: number;
  size: number;
  chunks: Map<number, ArrayBuffer>;
  contentHash?: string;
}

export interface ReceiveMtimeMessage {
  path: string;
  ctime: number;
  mtime: number;
}

export interface ReceivePathMessage {
  path: string;
}

export interface SyncEndData {
  lastTime: number;
  messages: SyncMessage[];
  needUploadCount?: number;
  needModifyCount?: number;
  needSyncMtimeCount?: number;
  needDeleteCount?: number;
}

export interface NoteSyncData {
  lastTime: number;
  notes: SnapFile[];
  delNotes: PathHashFile[];
  missingNotes: PathHashFile[];
}

export interface FileSyncData {
  lastTime: number;
  files: SnapFile[];
  delFiles: PathHashFile[];
  missingFiles: PathHashFile[];
}

export interface ConfigSyncData {
  lastTime: number;
  configs: SnapFile[];
  delConfigs: PathHashFile[];
  missingConfigs: PathHashFile[];
}

export interface FolderSyncRequest {
  vault: string;
  lastTime: number;
  folders: SnapFolder[];
  delFolders?: PathHashFile[];
  missingFolders?: PathHashFile[];
}

export interface FolderSyncRenameMessage {
  path: string;
  pathHash: string;
  ctime: number;
  mtime: number;
  oldPath: string;
  oldPathHash: string;
  contentHash?: string;
  size?: number;
}

export interface FolderSyncData {
  lastTime: number;
  folders: SnapFolder[];
  delFolders: PathHashFile[];
  missingFolders: PathHashFile[];
}

/* CLI-specific types */

export interface FileStat {
  ctime: number;
  mtime: number;
  size: number;
}

export interface TFile {
  path: string;
  name: string;
  extension: string;
  stat: FileStat;
}

export interface TFolder {
  path: string;
  name: string;
}

export type TAbstractFile = TFile | TFolder;

export interface CLIConfig {
  // Original plugin format (also supported)
  vault?: string;
  api?: string;
  apiToken?: string;
  vault_dir?: string;
  vault_name?: string;
  api_url?: string;
  api_token?: string;
  enable_local_push?: boolean;
}
