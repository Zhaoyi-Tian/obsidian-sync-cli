import { Vault } from './vault';
import { SyncClient } from './websocket';
import { TFile, FileDownloadSession } from './types';
import { hashContent, hashArrayBuffer, getSafeCtime, normalizePath, log, msToSeconds, sleep } from './helps';

const BINARY_PREFIX_FILE_SYNC = '00';

// Upload concurrency
const MAX_CONCURRENT_UPLOADS = 20;
let activeUploads = 0;
const uploadQueue: (() => Promise<void>)[] = [];

// Download buffer control
let currentDownloadBufferBytes = 0;
const MAX_DOWNLOAD_BUFFER_BYTES = 20 * 1024 * 1024;

// Active uploads tracking (for cancellation)
const activeUploadsMap = new Map<string, { cancelled: boolean }>();

/**
 * File operations - adapted from plugin for CLI usage
 */
export class FileOperator {
  private vault: Vault;
  private client: SyncClient;
  private enableLocalPush: boolean;

  constructor(vault: Vault, client: SyncClient, enableLocalPush: boolean = true) {
    this.vault = vault;
    this.client = client;
    this.enableLocalPush = enableLocalPush;
  }

  /**
   * File modify event handler
   */
  async fileModify(file: TFile): Promise<void> {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping file modify for', file.path);
      return;
    }

    if (file.path.endsWith('.md')) return;
    if (!this.client.getWatchEnabled()) return;
    if (this.client.isIgnoredFile(file.path)) return;

    this.client.addIgnoredFile(file.path);

    try {
      const content = await this.vault.readBinary(file.path);
      const contentHash = hashArrayBuffer(content.buffer as ArrayBuffer);
      const baseHash = this.client.getFileHash(file.path);

      const data = {
        vault: this.vault.getName(),
        path: file.path,
        pathHash: hashContent(file.path),
        contentHash: contentHash,
        mtime: file.stat.mtime,
        ctime: getSafeCtime(file.stat),
        size: file.stat.size,
        ...(baseHash !== null ? { baseHash } : { baseHashMissing: true }),
      };

      this.client.Send('FileUploadCheck', data);
      log('[SEND] File upload check:', file.path, contentHash);

      this.client.setFileHash(file.path, contentHash);
    } catch (e) {
      log('[ERROR] File modify error:', e);
    } finally {
      this.client.removeIgnoredFile(file.path);
    }
  }

  /**
   * File delete event handler
   */
  fileDelete(file: TFile): void {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping file delete for', file.path);
      return;
    }

    if (file.path.endsWith('.md')) return;
    if (!this.client.getWatchEnabled()) return;
    if (this.client.isIgnoredFile(file.path)) return;

    // Check if file is being uploaded
    if (activeUploadsMap.has(file.path)) {
      activeUploadsMap.get(file.path)!.cancelled = true;
      log('[INFO] Upload cancelled due to file deletion:', file.path);
      this.client.removeFileHash(file.path);
      return;
    }

    this.client.addIgnoredFile(file.path);

    const data = {
      vault: this.vault.getName(),
      path: file.path,
      pathHash: hashContent(file.path),
    };

    this.client.Send('FileDelete', data);
    log('[SEND] File delete:', file.path);

    this.client.removeFileHash(file.path);
    this.client.removeIgnoredFile(file.path);
  }

  /**
   * File rename event handler
   */
  async fileRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping file rename for', file.path);
      return;
    }

    if (file.path.endsWith('.md')) return;
    if (!this.client.getWatchEnabled()) return;
    if (this.client.isIgnoredFile(file.path)) return;

    this.client.addIgnoredFile(file.path);

    log('[INFO] File rename:', oldPath, '->', file.path);

    // Check if old file is being uploaded
    if (activeUploadsMap.has(oldPath)) {
      activeUploadsMap.get(oldPath)!.cancelled = true;
      // Re-upload
      this.fileModify(file);
    } else {
      let contentHash = this.client.getFileHash(oldPath);
      if (contentHash == null) {
        const content = await this.vault.readBinary(file.path);
        contentHash = hashArrayBuffer(content.buffer as ArrayBuffer);
      }

      const data = {
        vault: this.vault.getName(),
        oldPath: oldPath,
        oldPathHash: hashContent(oldPath),
        path: file.path,
        pathHash: hashContent(file.path),
      };

      this.client.Send('FileRename', data);
      this.client.setFileHash(file.path, contentHash);
    }

    this.client.removeFileHash(oldPath);
    this.client.removeIgnoredFile(file.path);
  }

  /**
   * Receive file upload request from server
   */
  async receiveFileUpload(data: any): Promise<void> {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping file upload for', data.path);
      return;
    }

    const path = data.path;
    const sessionId = data.sessionId;
    const chunkSize = data.chunkSize || 1024 * 1024;

    log('[RECEIVE] File upload request:', path, sessionId);

    const file = this.vault.getFileByPath(normalizePath(path));
    if (!file) {
      log('[ERROR] File not found for upload:', path);
      return;
    }

    const runUpload = async () => {
      activeUploadsMap.set(path, { cancelled: false });

      try {
        let content = await this.vault.readBinary(path);
        if (!content) return;

        const actualTotalChunks = Math.ceil(content.length / chunkSize);

        if (this.client.getWatchEnabled()) {
          this.client.totalChunksToUpload += actualTotalChunks;
        }

        log('[INFO] Uploading file:', path, 'size:', content.length, 'chunks:', actualTotalChunks);

        for (let i = 0; i < actualTotalChunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, content.length);
          const length = end - start;

          const chunk = new Uint8Array(content.slice(start, end));

          // Create frame: 36 bytes sessionId + 4 bytes chunk index + data
          const sessionIdBytes = new TextEncoder().encode(sessionId);
          const chunkIndexBytes = new Uint8Array(4);
          const view = new DataView(chunkIndexBytes.buffer);
          view.setUint32(0, i, false);

          const frame = new Uint8Array(36 + 4 + chunk.length);
          frame.set(sessionIdBytes, 0);
          frame.set(chunkIndexBytes, 36);
          frame.set(chunk, 40);

          // Check if cancelled
          if (activeUploadsMap.get(path)?.cancelled) {
            log('[INFO] Upload aborted for', path);
            return;
          }

          await this.client.SendBinary(frame, BINARY_PREFIX_FILE_SYNC);

          this.client.uploadedChunksCount++;

          // Small delay to prevent overwhelming
          await sleep(2);
        }

        log('[INFO] Upload complete for:', path);
      } catch (e) {
        log('[ERROR] File upload error:', e);
      } finally {
        activeUploadsMap.delete(path);
      }
    };

    // Process queue with concurrency control
    const processQueue = async () => {
      while (activeUploads < MAX_CONCURRENT_UPLOADS && uploadQueue.length > 0) {
        activeUploads++;
        const task = uploadQueue.shift();
        if (task) {
          (async () => {
            try {
              await task();
            } finally {
              activeUploads--;
              processQueue();
            }
          })();
        } else {
          activeUploads--;
        }
      }
    };

    uploadQueue.push(runUpload);
    processQueue();
  }

  /**
   * Receive file sync update from server
   */
  async receiveFileSyncUpdate(data: any): Promise<void> {
    const path = data.path;
    const contentHash = data.contentHash;
    const size = data.size;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);
    const lastTime = data.lastTime;

    log('[RECEIVE] File sync update:', path);

    // Wait for download buffer space
    while (currentDownloadBufferBytes > MAX_DOWNLOAD_BUFFER_BYTES) {
      await sleep(200);
    }

    const tempKey = `temp_${path}`;
    this.client.fileDownloadSessions.set(tempKey, {
      path: path,
      ctime: ctime,
      mtime: mtime,
      lastTime: lastTime,
      sessionId: '',
      totalChunks: 0,
      size: size,
      chunks: new Map(),
      contentHash: contentHash,
    });

    // Request chunk download
    const requestData = {
      vault: this.vault.getName(),
      path: path,
      pathHash: hashContent(path),
    };
    this.client.Send('FileChunkDownload', requestData);
    this.client.totalFilesToDownload++;

    this.client.setFileHash(path, contentHash);
    this.client.fileSyncTasks.completed++;
  }

  /**
   * Receive file delete from server
   */
  async receiveFileSyncDelete(data: any): Promise<void> {
    const path = data.path;
    log('[RECEIVE] File delete:', path);

    const normalizedPath = normalizePath(path);
    const file = this.vault.getFileByPath(normalizedPath);

    if (file) {
      this.client.addIgnoredFile(normalizedPath);
      try {
        await this.vault.delete(normalizedPath);
      } catch (e) {
        log('[ERROR] File delete error:', e);
      } finally {
        this.client.removeIgnoredFile(normalizedPath);
      }
      this.client.removeFileHash(normalizedPath);
    }

    this.client.fileSyncTasks.completed++;
  }

  /**
   * Receive file mtime update from server
   */
  async receiveFileSyncMtime(data: any): Promise<void> {
    const path = data.path;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);

    log('[RECEIVE] File mtime update:', path, mtime);

    const normalizedPath = normalizePath(path);
    const file = this.vault.getFileByPath(normalizedPath);

    if (file) {
      // Compare mtime
      if (file.stat.mtime === mtime) {
        return;
      }

      this.client.addIgnoredFile(normalizedPath);
      try {
        const content = await this.vault.readBinary(normalizedPath);
        await this.vault.modifyBinary(normalizedPath, content, { ctime, mtime });
      } catch (e) {
        log('[ERROR] File mtime update error:', e);
      } finally {
        this.client.removeIgnoredFile(normalizedPath);
      }
    }

    this.client.fileSyncTasks.completed++;
  }

  /**
   * Receive file chunk download start from server
   */
  async receiveFileSyncChunkDownload(data: any): Promise<void> {
    const path = data.path;
    const sessionId = data.sessionId;
    const chunkSize = data.chunkSize;
    const totalChunks = data.totalChunks;
    const size = data.size;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);
    const contentHash = data.contentHash;

    log('[RECEIVE] File chunk download start:', path, 'totalChunks:', totalChunks);

    const tempKey = `temp_${path}`;
    const tempSession = this.client.fileDownloadSessions.get(tempKey);

    if (tempSession) {
      const session: FileDownloadSession = {
        path: path,
        ctime: ctime,
        mtime: mtime,
        lastTime: tempSession.lastTime,
        sessionId: sessionId,
        totalChunks: totalChunks,
        size: size,
        chunks: new Map(),
        contentHash: contentHash,
      };
      this.client.fileDownloadSessions.set(sessionId, session);
      this.client.fileDownloadSessions.delete(tempKey);
    } else {
      const session: FileDownloadSession = {
        path: path,
        ctime: ctime,
        mtime: mtime,
        lastTime: 0,
        sessionId: sessionId,
        totalChunks: totalChunks,
        size: size,
        chunks: new Map(),
        contentHash: contentHash,
      };
      this.client.fileDownloadSessions.set(sessionId, session);
    }

    if (this.client.getWatchEnabled()) {
      this.client.totalChunksToDownload += totalChunks;
    }
  }

  /**
   * Handle file chunk download (binary)
   */
  handleFileChunkDownload(buf: ArrayBuffer): void {
    if (buf.byteLength < 40) return;

    const sessionIdBytes = new Uint8Array(buf, 0, 36);
    const sessionId = new TextDecoder().decode(sessionIdBytes);
    const chunkIndexBytes = new Uint8Array(buf, 36, 4);
    const view = new DataView(chunkIndexBytes.buffer, chunkIndexBytes.byteOffset, 4);
    const chunkIndex = view.getUint32(0, false);
    const chunkData = buf.slice(40);

    const session = this.client.fileDownloadSessions.get(sessionId);
    if (!session) return;

    session.chunks.set(chunkIndex, chunkData);
    currentDownloadBufferBytes += chunkData.byteLength;
    this.client.downloadedChunksCount++;

    if (session.chunks.size === session.totalChunks) {
      this.handleFileChunkDownloadComplete(session);
    }
  }

  /**
   * Complete file download
   */
  private async handleFileChunkDownloadComplete(session: FileDownloadSession): Promise<void> {
    try {
      const chunks: ArrayBuffer[] = [];
      for (let i = 0; i < session.totalChunks; i++) {
        const chunk = session.chunks.get(i);
        if (!chunk) {
          this.client.fileDownloadSessions.delete(session.sessionId);
          return;
        }
        chunks.push(chunk);
      }

      // Combine chunks
      const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const completeFile = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        completeFile.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }

      if (completeFile.length !== session.size) {
        this.client.fileDownloadSessions.delete(session.sessionId);
        return;
      }

      const normalizedPath = normalizePath(session.path);
      this.client.addIgnoredFile(normalizedPath);

      try {
        const file = this.vault.getFileByPath(normalizedPath);
        if (file) {
          await this.vault.modifyBinary(normalizedPath, Buffer.from(completeFile.buffer), { ctime: session.ctime, mtime: session.mtime });
        } else {
          const folder = normalizedPath.split('/').slice(0, -1).join('/');
          if (folder) {
            const dirExists = this.vault.getFolderByPath(folder);
            if (!dirExists) {
              await this.vault.createFolder(folder);
            }
          }
          await this.vault.createBinary(normalizedPath, Buffer.from(completeFile.buffer), { ctime: session.ctime, mtime: session.mtime });
        }

        const lastTime = this.client.getMetadata('lastFileSyncTime') || 0;
        if (lastTime < session.lastTime) {
          this.client.setMetadata('lastFileSyncTime', session.lastTime);
        }
      } finally {
        this.client.removeIgnoredFile(normalizedPath);
      }

      // Update hash
      const contentHash = hashArrayBuffer(completeFile.buffer);
      this.client.setFileHash(session.path, contentHash);
      log('[INFO] Download complete:', session.path, contentHash);

      // Free memory
      const sessionSize = Array.from(session.chunks.values()).reduce((sum, c) => sum + c.byteLength, 0);
      currentDownloadBufferBytes -= sessionSize;

      this.client.fileDownloadSessions.delete(session.sessionId);
      this.client.downloadedFilesCount++;
    } catch (e) {
      log('[ERROR] Download complete error:', e);
      const sessionSize = Array.from(session.chunks.values()).reduce((sum, c) => sum + c.byteLength, 0);
      currentDownloadBufferBytes -= sessionSize;
      this.client.fileDownloadSessions.delete(session.sessionId);
    }
  }

  /**
   * Receive file sync end
   */
  async receiveFileSyncEnd(data: any): Promise<void> {
    log('[RECEIVE] File sync end, needModifyCount:', data.needModifyCount || 0);
    this.client.setMetadata('lastFileSyncTime', data.lastTime);

    // Process embedded messages
    if (data.messages && data.messages.length > 0) {
      log('[INFO] Processing', data.messages.length, 'file sync messages...');
      for (const msg of data.messages) {
        const handler = this.client.messageHandlers.get(msg.action);
        if (handler) {
          await handler(msg.data, this.client);
        } else {
          log('[WARN] No handler for file action:', msg.action);
        }
        await sleep(2);
      }
    }

    this.client.syncTypeCompleteCount++;
  }

  /**
   * Receive file rename from server
   */
  async receiveFileSyncRename(data: any): Promise<void> {
    const oldPath = data.oldPath;
    const newPath = data.path;
    const contentHash = data.contentHash;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);

    log('[RECEIVE] File rename:', oldPath, '->', newPath);

    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    const file = this.vault.getFileByPath(normalizedOldPath);

    if (file) {
      this.client.addIgnoredFile(normalizedNewPath);
      this.client.addIgnoredFile(normalizedOldPath);

      try {
        const targetFile = this.vault.getFileByPath(normalizedNewPath);
        if (targetFile) {
          await this.vault.delete(normalizedNewPath);
        }

        await this.vault.rename(normalizedOldPath, normalizedNewPath);

        if (mtime) {
          const renamedFile = this.vault.getFileByPath(normalizedNewPath);
          if (renamedFile) {
            const content = await this.vault.readBinary(normalizedNewPath);
            await this.vault.modifyBinary(normalizedNewPath, content, { ctime, mtime });
          }
        }
      } catch (e) {
        log('[ERROR] File rename error:', e);
      } finally {
        this.client.removeIgnoredFile(normalizedNewPath);
        this.client.removeIgnoredFile(normalizedOldPath);
      }

      this.client.removeFileHash(oldPath);
      this.client.setFileHash(newPath, contentHash);
    } else {
      // Request re-push
      log('[INFO] Local file not found, requesting re-push:', oldPath);
      const rePushData = {
        vault: this.vault.getName(),
        path: newPath,
        pathHash: hashContent(newPath),
      };
      this.client.Send('FileRePush', rePushData);
      if (contentHash) {
        this.client.setFileHash(newPath, contentHash);
      }
    }

    this.client.fileSyncTasks.completed++;
  }

  /**
   * Register handlers
   */
  registerHandlers(): void {
    this.client.registerHandler('FileUpload', this.receiveFileUpload.bind(this));
    this.client.registerHandler('FileSyncUpdate', this.receiveFileSyncUpdate.bind(this));
    this.client.registerHandler('FileSyncModify', this.receiveFileSyncUpdate.bind(this));
    this.client.registerHandler('FileSyncNeedPush', this.receiveFileUpload.bind(this));
    this.client.registerHandler('FileSyncMtime', this.receiveFileSyncMtime.bind(this));
    this.client.registerHandler('FileSyncDelete', this.receiveFileSyncDelete.bind(this));
    this.client.registerHandler('FileSyncChunkDownload', this.receiveFileSyncChunkDownload.bind(this));
    this.client.registerHandler('FileSyncEnd', this.receiveFileSyncEnd.bind(this));
    this.client.registerHandler('FileSyncRename', this.receiveFileSyncRename.bind(this));

    // Register binary handler
    this.client.registerBinaryHandler(BINARY_PREFIX_FILE_SYNC, (data, client) => {
      this.handleFileChunkDownload(data);
    });
  }
}
