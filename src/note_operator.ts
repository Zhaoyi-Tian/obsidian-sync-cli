import { Vault } from './vault';
import { SyncClient } from './websocket';
import { TFile } from './types';
import { hashContent, getSafeCtime, normalizePath, log, msToSeconds, sleep } from './helps';

/**
 * Note operations - adapted from plugin for CLI usage
 */
export class NoteOperator {
  private vault: Vault;
  private client: SyncClient;
  private enableLocalPush: boolean;

  constructor(vault: Vault, client: SyncClient, enableLocalPush: boolean = true) {
    this.vault = vault;
    this.client = client;
    this.enableLocalPush = enableLocalPush;
  }

  /**
   * Note modify event handler
   */
  async noteModify(file: TFile): Promise<void> {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping note modify for', file.path);
      return;
    }

    if (!file.path.endsWith('.md')) return;
    if (!this.client.getWatchEnabled()) return;
    if (this.client.isIgnoredFile(file.path)) return;

    this.client.addIgnoredFile(file.path);

    try {
      const content = await this.vault.read(file.path);
      const contentHash = hashContent(content);
      const baseHash = this.client.getFileHash(file.path);

      const data = {
        vault: this.vault.getName(),
        ctime: getSafeCtime(file.stat),
        mtime: file.stat.mtime,
        path: file.path,
        pathHash: hashContent(file.path),
        content: content,
        contentHash: contentHash,
        ...(baseHash !== null ? { baseHash } : { baseHashMissing: true }),
      };

      this.client.Send('NoteModify', data);

      // Update hash after send
      if (contentHash !== baseHash) {
        this.client.setFileHash(file.path, contentHash);
      }
    } catch (e) {
      log('[ERROR]', e);
    } finally {
      this.client.removeIgnoredFile(file.path);
    }
  }

  /**
   * Note delete event handler
   */
  noteDelete(file: TFile): void {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping note delete for', file.path);
      return;
    }

    if (!file.path.endsWith('.md')) return;
    if (!this.client.getWatchEnabled()) return;
    if (this.client.isIgnoredFile(file.path)) return;

    this.client.addIgnoredFile(file.path);

    const data = {
      vault: this.vault.getName(),
      path: file.path,
      pathHash: hashContent(file.path),
    };

    this.client.Send('NoteDelete', data);

    this.client.removeFileHash(file.path);
    this.client.removeIgnoredFile(file.path);
  }

  /**
   * Note rename event handler
   */
  async noteRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping note rename for', file.path);
      return;
    }

    if (!file.path.endsWith('.md')) return;
    if (!this.client.getWatchEnabled()) return;
    if (this.client.isIgnoredFile(file.path)) return;

    this.client.addIgnoredFile(file.path);

    let contentHash = this.client.getFileHash(oldPath);
    if (contentHash == null) {
      const content = await this.vault.read(file.path);
      contentHash = hashContent(content);
    }

    const data = {
      vault: this.vault.getName(),
      path: file.path,
      pathHash: hashContent(file.path),
      oldPath: oldPath,
      oldPathHash: hashContent(oldPath),
    };

    this.client.Send('NoteRename', data);

    this.client.removeFileHash(oldPath);
    this.client.setFileHash(file.path, contentHash);
    this.client.removeIgnoredFile(file.path);
  }

  /**
   * Receive note sync modify from server
   */
  async receiveNoteSyncModify(data: any): Promise<void> {
    const path = data.path;
    const content = data.content;
    const contentHash = data.contentHash;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);

    const normalizedPath = normalizePath(path);
    const file = this.vault.getFileByPath(normalizedPath);

    this.client.addIgnoredFile(normalizedPath);

    try {
      if (file) {
        // Update existing file
        await this.vault.modify(normalizedPath, content, { ctime, mtime });
      } else {
        // Create new file
        const folder = normalizedPath.split('/').slice(0, -1).join('/');
        if (folder) {
          const dirExists = this.vault.getFolderByPath(folder);
          if (!dirExists) {
            await this.vault.createFolder(folder);
          }
        }
        await this.vault.create(normalizedPath, content, { ctime, mtime });
      }

      // Update last sync time
      const lastTime = this.client.getMetadata('lastNoteSyncTime') || 0;
      if (lastTime < data.lastTime) {
        this.client.setMetadata('lastNoteSyncTime', data.lastTime);
      }
    } catch (e) {
      log('[ERROR]', e);
    } finally {
      this.client.removeIgnoredFile(normalizedPath);
    }

    // Update hash
    this.client.setFileHash(path, contentHash);
    this.client.noteSyncTasks.completed++;
  }

  /**
   * Receive note need push (server requests upload)
   */
  async receiveNoteUpload(data: any): Promise<void> {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping note upload request for', data.path);
      return;
    }

    const path = data.path;
    if (!path.endsWith('.md')) return;

    const file = this.vault.getFileByPath(normalizePath(path));
    if (!file) return;

    this.client.addIgnoredFile(file.path);

    try {
      const content = await this.vault.read(file.path);
      const contentHash = hashContent(content);
      const baseHash = this.client.getFileHash(file.path);

      const sendData = {
        vault: this.vault.getName(),
        ctime: getSafeCtime(file.stat),
        mtime: file.stat.mtime,
        path: file.path,
        pathHash: hashContent(file.path),
        content: content,
        contentHash: contentHash,
        ...(baseHash !== null ? { baseHash } : { baseHashMissing: true }),
      };

      this.client.Send('NoteModify', sendData);

      this.client.setFileHash(file.path, contentHash);
    } catch (e) {
      log('[ERROR]', e);
    } finally {
      this.client.removeIgnoredFile(file.path);
      this.client.noteSyncTasks.completed++;
    }
  }

  /**
   * Receive note mtime update from server
   */
  async receiveNoteSyncMtime(data: any): Promise<void> {
    const path = data.path;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);

    const normalizedPath = normalizePath(path);
    const file = this.vault.getFileByPath(normalizedPath);

    if (file) {
      // Compare local and server mtime
      if (file.stat.mtime === mtime) {
        return; // Skip if same
      }

      this.client.addIgnoredFile(normalizedPath);
      try {
        const content = await this.vault.read(normalizedPath);
        await this.vault.modify(normalizedPath, content, { ctime, mtime });
      } catch (e) {
        log('[ERROR]', e);
      } finally {
        this.client.removeIgnoredFile(normalizedPath);
      }
    }

    this.client.noteSyncTasks.completed++;
  }

  /**
   * Receive note delete from server
   */
  async receiveNoteSyncDelete(data: any): Promise<void> {
    const path = data.path;
    const normalizedPath = normalizePath(path);
    const file = this.vault.getFileByPath(normalizedPath);

    if (file) {
      this.client.addIgnoredFile(normalizedPath);
      try {
        await this.vault.delete(normalizedPath);
      } catch (e) {
        log('[ERROR]', e);
      } finally {
        this.client.removeIgnoredFile(normalizedPath);
      }
      this.client.removeFileHash(normalizedPath);
    }

    this.client.noteSyncTasks.completed++;
  }

  /**
   * Receive note sync end
   */
  async receiveNoteSyncEnd(data: any): Promise<void> {
    this.client.setMetadata('lastNoteSyncTime', data.lastTime);

    log('[DEBUG] NoteSyncEnd received, lastTime:', data.lastTime);
    log('[DEBUG] needModifyCount:', data.needModifyCount);
    log('[DEBUG] messages count:', data.messages ? data.messages.length : 0);

    // Process embedded messages
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        log('[DEBUG] Processing message:', msg.action, msg.data?.path);
        const handler = this.client.messageHandlers.get(msg.action);
        if (handler) {
          await handler(msg.data, this.client);
        } else {
          log('[WARN] No handler for note action:', msg.action);
        }
        await sleep(2);
      }
    }

    this.client.syncTypeCompleteCount++;
  }

  /**
   * Receive note rename from server
   */
  async receiveNoteSyncRename(data: any): Promise<void> {
    const oldPath = data.oldPath;
    const newPath = data.path;
    const contentHash = data.contentHash;
    const ctime = msToSeconds(data.ctime || 0);
    const mtime = msToSeconds(data.mtime || 0);

    log('[RECEIVE] Note rename:', oldPath, '->', newPath);

    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    const file = this.vault.getFileByPath(normalizedOldPath);

    if (file) {
      this.client.addIgnoredFile(normalizedNewPath);
      this.client.addIgnoredFile(normalizedOldPath);

      try {
        // If target exists, delete first
        const targetFile = this.vault.getFileByPath(normalizedNewPath);
        if (targetFile) {
          await this.vault.delete(normalizedNewPath);
        }

        // Rename
        await this.vault.rename(normalizedOldPath, normalizedNewPath);

        // Update mtime if provided
        if (mtime) {
          const renamedFile = this.vault.getFileByPath(normalizedNewPath);
          if (renamedFile) {
            const content = await this.vault.read(normalizedNewPath);
            await this.vault.modify(normalizedNewPath, content, { ctime, mtime });
          }
        }
      } catch (e) {
        log('[ERROR] Receive note rename error:', e);
      } finally {
        this.client.removeIgnoredFile(normalizedNewPath);
        this.client.removeIgnoredFile(normalizedOldPath);
      }

      this.client.removeFileHash(oldPath);
      this.client.setFileHash(newPath, contentHash);
    } else {
      // Request re-push if local file not found
      log('[INFO] Local file not found, requesting re-push:', oldPath);
      const rePushData = {
        vault: this.vault.getName(),
        path: newPath,
        pathHash: hashContent(newPath),
      };
      this.client.Send('NoteRePush', rePushData);
      this.client.setFileHash(newPath, contentHash);
    }

    this.client.noteSyncTasks.completed++;
  }

  /**
   * Register handlers
   */
  registerHandlers(): void {
    this.client.registerHandler('NoteSyncModify', this.receiveNoteSyncModify.bind(this));
    this.client.registerHandler('NoteSyncNeedPush', this.receiveNoteUpload.bind(this));
    this.client.registerHandler('NoteSyncMtime', this.receiveNoteSyncMtime.bind(this));
    this.client.registerHandler('NoteSyncDelete', this.receiveNoteSyncDelete.bind(this));
    this.client.registerHandler('NoteSyncEnd', this.receiveNoteSyncEnd.bind(this));
    this.client.registerHandler('NoteSyncRename', this.receiveNoteSyncRename.bind(this));
  }
}
