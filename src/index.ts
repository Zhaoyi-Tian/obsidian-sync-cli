import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from './config';
import { Vault } from './vault';
import { SyncClient } from './websocket';
import { NoteOperator } from './note_operator';
import { FileOperator } from './file_operator';
import { FolderOperator } from './folder_operator';
import { FSWatcher } from './fs_watcher';
import { hashContent, log } from './helps';
import { SnapFile, SnapFolder } from './types';

/**
 * Main entry point for Obsidian Sync CLI
 */
class ObsidianSyncCLI {
  private config: any;
  private vault: Vault;
  private client: SyncClient;
  private noteOperator: NoteOperator;
  private fileOperator: FileOperator;
  private folderOperator: FolderOperator;
  private watcher: FSWatcher;

  constructor() {
    // Load configuration
    this.config = loadConfig();
    log('Config loaded:', {
      vault_name: this.config.vault_name,
      vault_dir: this.config.vault_dir,
      api_url: this.config.api_url,
    });

    // Verify vault directory exists
    if (!fs.existsSync(this.config.vault_dir)) {
      log('ERROR: Vault directory not found:', this.config.vault_dir);
      process.exit(1);
    }

    // Check API token
    if (!this.config.api_token) {
      log('ERROR: API token is required in config.json');
      process.exit(1);
    }

    // Create vault
    this.vault = new Vault(this.config.vault_dir, this.config.vault_name);

    // Create sync client
    this.client = new SyncClient(
      this.config.vault_name,
      this.config.api_url,
      this.config.api_token,
      null as any // Will be set later
    );

    // Create operators
    this.fileOperator = new FileOperator(this.vault, this.client, this.config.enable_local_push);
    this.noteOperator = new NoteOperator(this.vault, this.client, this.config.enable_local_push);
    this.folderOperator = new FolderOperator(this.vault, this.client);

    // Set file operator reference in client
    (this.client as any).fileOperator = this.fileOperator;

    // Create watcher
    this.watcher = new FSWatcher(this.vault, this.noteOperator, this.fileOperator);
  }

  /**
   * Register all message handlers
   */
  private registerHandlers(): void {
    this.noteOperator.registerHandlers();
    this.fileOperator.registerHandlers();
    this.folderOperator.registerHandlers();
  }

  /**
   * Start full sync
   */
  private async startSync(): Promise<void> {
    this.client.isFirstSync = true;

    // Get last sync times (0 means full sync)
    const lastNoteSyncTime = Number(this.client.getMetadata('lastNoteSyncTime')) || 0;
    const lastFileSyncTime = Number(this.client.getMetadata('lastFileSyncTime')) || 0;
    const lastFolderSyncTime = Number(this.client.getMetadata('lastFolderSyncTime')) || 0;

    // Check if vault is empty - force full sync
    const notes = this.getLocalNotes();
    const files = this.getLocalFiles();
    const folders = this.getLocalFolders();
    const isEmptyVault = notes.length === 0 && files.length === 0;

    // Determine if this is incremental sync (has previous sync time)
    const isIncrementalSync = !isEmptyVault && lastNoteSyncTime > 0;

    // Build local paths sets for del/missing detection
    const localNotePaths = new Set(notes.map(n => n.path));
    const localFilePaths = new Set(files.map(f => f.path));
    const localFolderPaths = new Set(folders.map(f => f.path));

    // Get tracked paths from hash cache
    const trackedPaths = this.client.getAllPaths();
    const trackedNotePaths = trackedPaths.filter(p => p.endsWith('.md'));
    const trackedFilePaths = trackedPaths.filter(p => !p.endsWith('.md'));

    // Detect deleted notes (tracked but not in local)
    const delNotes: { path: string; pathHash: string }[] = [];
    for (const path of trackedNotePaths) {
      if (!localNotePaths.has(path)) {
        delNotes.push({ path, pathHash: hashContent(path) });
      }
    }

    // Detect missing notes (tracked but not in local, only for incremental sync)
    const missingNotes: { path: string; pathHash: string }[] = [];
    if (isIncrementalSync) {
      for (const path of trackedNotePaths) {
        if (!localNotePaths.has(path)) {
          missingNotes.push({ path, pathHash: hashContent(path) });
        }
      }
    }

    // Detect deleted files
    const delFiles: { path: string; pathHash: string }[] = [];
    for (const path of trackedFilePaths) {
      if (!localFilePaths.has(path)) {
        delFiles.push({ path, pathHash: hashContent(path) });
      }
    }

    // Detect missing files (only for incremental sync)
    const missingFiles: { path: string; pathHash: string }[] = [];
    if (isIncrementalSync) {
      for (const path of trackedFilePaths) {
        if (!localFilePaths.has(path)) {
          missingFiles.push({ path, pathHash: hashContent(path) });
        }
      }
    }

    // Debug info
    log('[DEBUG] lastNoteSyncTime:', lastNoteSyncTime);
    log('[DEBUG] lastFileSyncTime:', lastFileSyncTime);
    log('[DEBUG] lastFolderSyncTime:', lastFolderSyncTime);
    log('[DEBUG] isEmptyVault:', isEmptyVault);
    log('[DEBUG] isIncrementalSync:', isIncrementalSync);
    log('[DEBUG] localNotes count:', notes.length);
    log('[DEBUG] localFiles count:', files.length);
    log('[DEBUG] localFolders count:', folders.length);
    log('[DEBUG] delNotes count:', delNotes.length);
    log('[DEBUG] missingNotes count:', missingNotes.length);
    log('[DEBUG] delFiles count:', delFiles.length);
    log('[DEBUG] missingFiles count:', missingFiles.length);

    const forceLastTime = isEmptyVault ? 0 : lastNoteSyncTime;
    const forceFileLastTime = isEmptyVault ? 0 : lastFileSyncTime;
    const forceFolderLastTime = isEmptyVault ? 0 : lastFolderSyncTime;

    log('[DEBUG] sending NoteSync with lastTime:', forceLastTime);
    log('[DEBUG] sending FileSync with lastTime:', forceFileLastTime);
    log('[DEBUG] sending FolderSync with lastTime:', forceFolderLastTime);

    // Sync notes - with delNotes and missingNotes (matching plugin format)
    const noteSyncData: any = {
      vault: this.config.vault_name,
      lastTime: forceLastTime,
      notes: notes,
    };
    // Add delNotes if any (like plugin's offlineDeleteSyncEnabled)
    if (delNotes.length > 0) {
      noteSyncData.delNotes = delNotes;
    }
    // Add missingNotes if any (like plugin does for incremental sync)
    if (missingNotes.length > 0) {
      noteSyncData.missingNotes = missingNotes;
    }
    this.client.Send('NoteSync', noteSyncData);

    // Sync files - with delFiles and missingFiles
    const fileSyncData: any = {
      vault: this.config.vault_name,
      lastTime: forceFileLastTime,
      files: files,
    };
    if (delFiles.length > 0) {
      fileSyncData.delFiles = delFiles;
    }
    if (missingFiles.length > 0) {
      fileSyncData.missingFiles = missingFiles;
    }
    this.client.Send('FileSync', fileSyncData);

    // Sync folders - matching plugin format
    // Detect deleted folders (tracked but not in local)
    const delFolders: { path: string; pathHash: string }[] = [];
    // For now, folder tracking is simpler - just use local folders
    // Missing folders detection for incremental sync
    const missingFolders: { path: string; pathHash: string }[] = [];

    const folderSyncData: any = {
      vault: this.config.vault_name,
      lastTime: forceFolderLastTime,
      folders: folders,
    };
    if (delFolders.length > 0) {
      folderSyncData.delFolders = delFolders;
    }
    if (missingFolders.length > 0) {
      folderSyncData.missingFolders = missingFolders;
    }
    this.client.Send('FolderSync', folderSyncData);
  }

  /**
   * Get all local notes
   */
  private getLocalNotes(): SnapFile[] {
    const notes: SnapFile[] = [];
    const files = this.vault.getFiles();

    for (const file of files) {
      if (file.extension === 'md') {
        notes.push({
          path: file.path,
          pathHash: hashContent(file.path),
          contentHash: '', // Will be computed on read
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
      }
    }

    return notes;
  }

  /**
   * Get all local files (non-markdown)
   */
  private getLocalFiles(): SnapFile[] {
    const files: SnapFile[] = [];
    const allFiles = this.vault.getFiles();

    for (const file of allFiles) {
      if (file.extension !== 'md') {
        files.push({
          path: file.path,
          pathHash: hashContent(file.path),
          contentHash: '', // Will be computed on check
          mtime: file.stat.mtime,
          size: file.stat.size,
          ctime: file.stat.ctime,
        });
      }
    }

    return files;
  }

  /**
   * Get all local folders
   */
  private getLocalFolders(): SnapFolder[] {
    const folders: SnapFolder[] = [];
    const localFolders = this.vault.getFolders();

    for (const folder of localFolders) {
      folders.push({
        path: folder.path,
        pathHash: hashContent(folder.path),
      });
    }

    return folders;
  }

  /**
   * Run the CLI
   */
  async run(): Promise<void> {
    log('='.repeat(50));
    log('Obsidian Sync CLI v1.0.0');
    log('='.repeat(50));
    log('Vault:', this.config.vault_name);
    log('Vault dir:', this.config.vault_dir);
    log('API URL:', this.config.api_url);
    log('Enable local push:', this.config.enable_local_push);
    log('='.repeat(50));

    // Register handlers
    this.registerHandlers();

    // Index vault
    await this.watcher.indexVault();

    // Start file watcher
    this.watcher.start();

    // Connect to WebSocket
    this.client.connect();

    // Set callback for when sync should start (after auth and ClientInfo)
    this.client.onSyncStart = () => {
      this.startSync();
    };

    // Handle shutdown
    process.on('SIGINT', () => {
      log('[INFO] Shutting down...');
      this.watcher.stop();
      this.client.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      log('[INFO] Shutting down...');
      this.watcher.stop();
      this.client.disconnect();
      process.exit(0);
    });

    log('[INFO] Sync client running. Press Ctrl+C to stop.');
  }
}

// Run
const cli = new ObsidianSyncCLI();
cli.run().catch((e) => {
  log('[ERROR] Fatal error:', e);
  process.exit(1);
});
