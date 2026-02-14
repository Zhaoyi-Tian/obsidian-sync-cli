import * as chokidar from 'chokidar';
import * as path from 'path';
import { Vault } from './vault';
import { NoteOperator } from './note_operator';
import { FileOperator } from './file_operator';
import { TFile } from './types';
import { hashContent, normalizePath, log } from './helps';

type WatcherCallback = (type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir', filePath: string, file?: TFile) => void;

/**
 * File system watcher - replaces Obsidian's vault events with Node.js chokidar
 */
export class FSWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private vault: Vault;
  private noteOperator: NoteOperator;
  private fileOperator: FileOperator;
  private watchEnabled: boolean = true;

  // Hash cache for change detection
  private lastHashes = new Map<string, string>();

  // Debounce map
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceDelay = 100;

  constructor(vault: Vault, noteOperator: NoteOperator, fileOperator: FileOperator) {
    this.vault = vault;
    this.noteOperator = noteOperator;
    this.fileOperator = fileOperator;
  }

  /**
   * Start watching vault directory
   */
  start(): void {
    const vaultDir = this.vault.getDir();
    log('[Watcher] Starting file watcher for:', vaultDir);

    this.watcher = chokidar.watch(vaultDir, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 99,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      ignored: [
        /(^|[\/\\])\../,  // Ignore dotfiles
        /node_modules/,
        /\.git/,
      ],
    });

    this.watcher
      .on('add', (filePath) => this.handleFileEvent('add', filePath))
      .on('change', (filePath) => this.handleFileEvent('change', filePath))
      .on('unlink', (filePath) => this.handleFileEvent('unlink', filePath))
      .on('addDir', (dirPath) => this.handleDirEvent('addDir', dirPath))
      .on('unlinkDir', (dirPath) => this.handleDirEvent('unlinkDir', dirPath))
      .on('error', (error) => log('[Watcher] Error:', error));

    log('[Watcher] File watcher started');
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log('[Watcher] File watcher stopped');
    }

    // Clear all timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Enable/disable watching
   */
  setWatchEnabled(enabled: boolean): void {
    this.watchEnabled = enabled;
    log('[Watcher] Watch enabled:', enabled);
  }

  /**
   * Get current hash of file
   */
  private async getCurrentHash(filePath: string): Promise<string | null> {
    try {
      const stat = await this.vault.adapter.stat(normalizePath(path.relative(this.vault.getDir(), filePath)));
      // For simplicity, use mtime as hash
      return String(stat.mtime);
    } catch {
      return null;
    }
  }

  /**
   * Handle file event with debounce
   */
  private handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): void {
    if (!this.watchEnabled) return;

    // Get relative path
    const relPath = normalizePath(path.relative(this.vault.getDir(), filePath));

    // Skip hidden files
    if (path.basename(relPath).startsWith('.')) return;

    // Debounce
    const existingTimer = this.debounceTimers.get(relPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(relPath);

      try {
        if (type === 'unlink') {
          await this.handleFileDelete(relPath);
        } else {
          await this.handleFileChange(type, relPath, filePath);
        }
      } catch (e) {
        log('[Watcher] Error handling file event:', e);
      }
    }, this.debounceDelay);

    this.debounceTimers.set(relPath, timer);
  }

  /**
   * Handle file change
   */
  private async handleFileChange(type: 'add' | 'change', relPath: string, fullPath: string): Promise<void> {
    const file = this.vault.getFileByPath(relPath);
    if (!file) return;

    // Check if file is ignored by sync
    if (this.vault.getDir()) {
      // Use client isIgnoredFile if available
    }

    // Check hash to avoid duplicate events
    const currentHash = await this.getCurrentHash(fullPath);
    const lastHash = this.lastHashes.get(relPath);

    if (lastHash === currentHash && type === 'change') {
      log('[Watcher] Skipping - hash unchanged:', relPath);
      return;
    }

    this.lastHashes.set(relPath, currentHash || '');

    if (file.extension === 'md') {
      // Note
      if (type === 'add') {
        log('[Watcher] Note created:', relPath);
      } else {
        log('[Watcher] Note modified:', relPath);
      }
      await this.noteOperator.noteModify(file);
    } else {
      // Attachment
      if (type === 'add') {
        log('[Watcher] File created:', relPath);
      } else {
        log('[Watcher] File modified:', relPath);
      }
      await this.fileOperator.fileModify(file);
    }
  }

  /**
   * Handle file delete
   */
  private async handleFileDelete(relPath: string): Promise<void> {
    this.lastHashes.delete(relPath);

    // Determine file type by extension
    if (relPath.endsWith('.md')) {
      log('[Watcher] Note deleted:', relPath);
      // Create a dummy TFile for delete
      const dummyFile: TFile = {
        path: relPath,
        name: path.basename(relPath),
        extension: 'md',
        stat: { ctime: 0, mtime: 0, size: 0 },
      };
      this.noteOperator.noteDelete(dummyFile);
    } else {
      log('[Watcher] File deleted:', relPath);
      const dummyFile: TFile = {
        path: relPath,
        name: path.basename(relPath),
        extension: path.extname(relPath).slice(1),
        stat: { ctime: 0, mtime: 0, size: 0 },
      };
      this.fileOperator.fileDelete(dummyFile);
    }
  }

  /**
   * Handle directory event
   */
  private handleDirEvent(type: 'addDir' | 'unlinkDir', dirPath: string): void {
    if (!this.watchEnabled) return;

    const relPath = normalizePath(path.relative(this.vault.getDir(), dirPath));

    // Skip hidden directories
    if (path.basename(relPath).startsWith('.')) return;

    if (type === 'addDir') {
      log('[Watcher] Directory created:', relPath);
    } else {
      log('[Watcher] Directory deleted:', relPath);
    }
  }

  /**
   * Index all existing files in vault
   */
  async indexVault(): Promise<void> {
    log('[Watcher] Indexing vault...');
    const files = this.vault.getFiles();

    for (const file of files) {
      const hash = await this.getCurrentHash(path.join(this.vault.getDir(), file.path));
      if (hash) {
        this.lastHashes.set(file.path, hash);
      }
    }

    log('[Watcher] Indexed', files.length, 'files');
  }
}
