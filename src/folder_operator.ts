import * as fs from 'fs';
import * as path from 'path';
import { Vault } from './vault';
import { SyncClient } from './websocket';
import { hashContent, log, sleep } from './helps';
import { TFolder } from './types';

/**
 * Folder operator - handles folder sync operations
 * Adapted from plugin's folder_operator.ts
 */
export class FolderOperator {
  private vault: Vault;
  private client: SyncClient;
  private enableLocalPush: boolean;

  constructor(vault: Vault, client: SyncClient, enableLocalPush: boolean = true) {
    this.vault = vault;
    this.client = client;
    this.enableLocalPush = enableLocalPush;
  }

  /**
   * Send folder create/modify to server (like plugin's folderModify)
   */
  folderCreate(folderPath: string): void {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping folder create for', folderPath);
      return;
    }

    const data = {
      vault: this.vault.getName(),
      path: folderPath,
      pathHash: hashContent(folderPath),
    };

    this.client.Send('FolderModify', data);
    log('[SEND] Folder modify:', folderPath);
  }

  /**
   * Send folder delete to server (like plugin's folderDelete)
   */
  folderDelete(folderPath: string): void {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping folder delete for', folderPath);
      return;
    }

    const data = {
      vault: this.vault.getName(),
      path: folderPath,
      pathHash: hashContent(folderPath),
    };

    this.client.Send('FolderDelete', data);
    log('[SEND] Folder delete:', folderPath);
  }

  /**
   * Send folder rename to server (like plugin's folderRename)
   */
  folderRename(oldPath: string, newPath: string): void {
    if (!this.enableLocalPush) {
      log('[SafeMode] Skipping folder rename for', oldPath);
      return;
    }

    const data = {
      vault: this.vault.getName(),
      path: newPath,
      pathHash: hashContent(newPath),
      oldPath: oldPath,
      oldPathHash: hashContent(oldPath),
    };

    this.client.Send('FolderRename', data);
    log('[SEND] Folder rename:', oldPath, '->', newPath);
  }

  /**
   * Receive folder sync modify from server
   */
  async receiveFolderSyncModify(data: any): Promise<void> {
    const normalizedPath = data.path;

    log('[RECEIVE] Folder sync modify:', normalizedPath);

    this.client.addIgnoredFile(normalizedPath);

    try {
      const existingFolder = this.vault.getFolderByPath(normalizedPath);
      if (!existingFolder) {
        // Create new folder
        await this.vault.createFolder(normalizedPath);
        log('[RECEIVE] Folder created:', normalizedPath);
      }
    } catch (e) {
      log('[ERROR]', e);
    } finally {
      this.client.removeIgnoredFile(normalizedPath);
    }

    this.client.folderSyncTasks.completed++;
  }

  /**
   * Receive folder sync delete from server
   */
  async receiveFolderSyncDelete(data: any): Promise<void> {
    const normalizedPath = data.path;

    log('[RECEIVE] Folder sync delete:', normalizedPath);

    this.client.addIgnoredFile(normalizedPath);

    try {
      const folder = this.vault.getFolderByPath(normalizedPath);
      if (folder) {
        await this.vault.deleteFolder(normalizedPath);
        log('[RECEIVE] Folder deleted:', normalizedPath);
      }
    } catch (e) {
      log('[ERROR]', e);
    } finally {
      this.client.removeIgnoredFile(normalizedPath);
    }

    this.client.folderSyncTasks.completed++;
  }

  /**
   * Receive folder rename from server
   */
  async receiveFolderSyncRename(data: any): Promise<void> {
    const oldPath = data.oldPath;
    const newPath = data.path;

    log('[RECEIVE] Folder rename:', oldPath, '->', newPath);

    this.client.addIgnoredFile(newPath);
    this.client.addIgnoredFile(oldPath);

    try {
      // Check if old folder exists
      const oldFolder = this.vault.getFolderByPath(oldPath);
      if (oldFolder) {
        // Rename the folder
        await this.vault.renameFolder(oldPath, newPath);
        log('[RECEIVE] Folder renamed:', oldPath, '->', newPath);
      } else {
        // If old folder doesn't exist, create new folder
        const newFolder = this.vault.getFolderByPath(newPath);
        if (!newFolder) {
          await this.vault.createFolder(newPath);
          log('[RECEIVE] Folder created (from rename):', newPath);
        }
      }
    } catch (e) {
      log('[ERROR]', e);
    } finally {
      this.client.removeIgnoredFile(newPath);
      this.client.removeIgnoredFile(oldPath);
    }

    this.client.folderSyncTasks.completed++;
  }

  /**
   * Receive folder sync end
   */
  async receiveFolderSyncEnd(data: any): Promise<void> {
    this.client.setMetadata('lastFolderSyncTime', data.lastTime);

    log('[RECEIVE] Folder sync end, lastTime:', data.lastTime);
    log('[RECEIVE] Folder messages count:', data.messages ? data.messages.length : 0);

    // Process embedded messages
    if (data.messages && data.messages.length > 0) {
      log('[RECEIVE] Processing', data.messages.length, 'folder sync messages...');
      for (const msg of data.messages) {
        log('[RECEIVE] Processing folder message:', msg.action, msg.data?.path);
        const handler = this.client.messageHandlers.get(msg.action);
        if (handler) {
          await handler(msg.data, this.client);
        } else {
          log('[WARN] No handler for folder action:', msg.action);
        }
        await sleep(2);
      }
    }

    this.client.syncTypeCompleteCount++;
  }

  /**
   * Register handlers
   */
  registerHandlers(): void {
    this.client.registerHandler('FolderSyncModify', this.receiveFolderSyncModify.bind(this));
    this.client.registerHandler('FolderSyncDelete', this.receiveFolderSyncDelete.bind(this));
    this.client.registerHandler('FolderSyncRename', this.receiveFolderSyncRename.bind(this));
    this.client.registerHandler('FolderSyncEnd', this.receiveFolderSyncEnd.bind(this));
  }
}
