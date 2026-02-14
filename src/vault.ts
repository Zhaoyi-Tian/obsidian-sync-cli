import * as fs from 'fs';
import * as path from 'path';
import { TFile, TFolder, TAbstractFile, FileStat } from './types';
import { normalizePath, getSafeCtime } from './helps';

/**
 * Vault abstraction - replaces Obsidian's vault API with Node.js fs
 */
export class Vault {
  private vaultDir: string;
  private vaultName: string;

  constructor(vaultDir: string, vaultName: string) {
    this.vaultDir = vaultDir;
    this.vaultName = vaultName;
    this.adapter = this.createAdapter();
  }

  getName(): string {
    return this.vaultName;
  }

  getDir(): string {
    return this.vaultDir;
  }

  /**
   * Read text file content
   */
  async read(filePath: string): Promise<string> {
    const fullPath = path.join(this.vaultDir, filePath);
    return fs.promises.readFile(fullPath, 'utf-8');
  }

  /**
   * Read binary file content
   */
  async readBinary(filePath: string): Promise<Buffer> {
    const fullPath = path.join(this.vaultDir, filePath);
    return fs.promises.readFile(fullPath);
  }

  /**
   * Create a new text file
   */
  async create(filePath: string, content: string, options?: { ctime?: number; mtime?: number }): Promise<void> {
    const fullPath = path.join(this.vaultDir, filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, content, 'utf-8');

    // Set timestamps if provided
    if (options) {
      const atime = Math.floor(Date.now() / 1000);
      const ctime = options.ctime || options.mtime || atime;
      const mtime = options.mtime || atime;
      await fs.promises.utimes(fullPath, ctime, mtime);
    }
  }

  /**
   * Create a new binary file
   */
  async createBinary(filePath: string, buffer: Buffer, options?: { ctime?: number; mtime?: number }): Promise<void> {
    const fullPath = path.join(this.vaultDir, filePath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, buffer);

    // Set timestamps if provided
    if (options) {
      const atime = Math.floor(Date.now() / 1000);
      const ctime = options.ctime || options.mtime || atime;
      const mtime = options.mtime || atime;
      await fs.promises.utimes(fullPath, ctime, mtime);
    }
  }

  /**
   * Modify existing text file
   */
  async modify(filePath: string, content: string, options?: { ctime?: number; mtime?: number }): Promise<void> {
    const fullPath = path.join(this.vaultDir, filePath);

    await fs.promises.writeFile(fullPath, content, 'utf-8');

    // Set timestamps if provided
    if (options) {
      const atime = Math.floor(Date.now() / 1000);
      const ctime = options.ctime || options.mtime || atime;
      const mtime = options.mtime || atime;
      await fs.promises.utimes(fullPath, ctime, mtime);
    }
  }

  /**
   * Modify existing binary file
   */
  async modifyBinary(filePath: string, buffer: Buffer | ArrayBuffer, options?: { ctime?: number; mtime?: number }): Promise<void> {
    const fullPath = path.join(this.vaultDir, filePath);

    const buf = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;
    await fs.promises.writeFile(fullPath, buf);

    // Set timestamps if provided
    if (options) {
      const atime = Math.floor(Date.now() / 1000);
      const ctime = options.ctime || options.mtime || atime;
      const mtime = options.mtime || atime;
      await fs.promises.utimes(fullPath, ctime, mtime);
    }
  }

  /**
   * Delete a file
   */
  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.vaultDir, filePath);
    await fs.promises.unlink(fullPath);
  }

  /**
   * Rename/move a file
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldFullPath = path.join(this.vaultDir, oldPath);
    const newFullPath = path.join(this.vaultDir, newPath);
    const newDir = path.dirname(newFullPath);

    // Ensure new directory exists
    if (!fs.existsSync(newDir)) {
      await fs.promises.mkdir(newDir, { recursive: true });
    }

    await fs.promises.rename(oldFullPath, newFullPath);
  }

  /**
   * Create a folder
   */
  async createFolder(folderPath: string): Promise<void> {
    const fullPath = path.join(this.vaultDir, folderPath);
    await fs.promises.mkdir(fullPath, { recursive: true });
  }

  /**
   * Get file by path
   */
  getFileByPath(filePath: string): TFile | null {
    const normalizedPath = normalizePath(filePath);
    const fullPath = path.join(this.vaultDir, normalizedPath);

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return null;
    }

    return this.createTFile(normalizedPath, stat);
  }

  /**
   * Get abstract file (file or folder) by path
   */
  getAbstractFileByPath(filePath: string): TAbstractFile | null {
    const normalizedPath = normalizePath(filePath);
    const fullPath = path.join(this.vaultDir, normalizedPath);

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return this.createTFolder(normalizedPath);
    } else {
      return this.createTFile(normalizedPath, stat);
    }
  }

  /**
   * Get all files in vault
   */
  getAllLoadedFiles(): TFile[] {
    return this.getFiles();
  }

  /**
   * Get all files (non-folder) in vault
   */
  getFiles(): TFile[] {
    const files: TFile[] = [];

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;

      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const relPath = path.relative(this.vaultDir, fullPath);
        const normalizedPath = normalizePath(relPath);

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          // Skip hidden directories
          if (!item.startsWith('.')) {
            walk(fullPath);
          }
        } else {
          // Skip hidden files
          if (!item.startsWith('.')) {
            files.push(this.createTFile(normalizedPath, stat));
          }
        }
      }
    };

    walk(this.vaultDir);
    return files;
  }

  /**
   * Get all folders in vault
   */
  getFolders(): TFolder[] {
    const folders: TFolder[] = [];

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      if (dir === this.vaultDir) return; // Skip root

      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip hidden directories
          if (!item.startsWith('.')) {
            const relPath = path.relative(this.vaultDir, fullPath);
            const normalizedPath = normalizePath(relPath);
            folders.push({
              path: normalizedPath,
              name: item,
            });
            walk(fullPath);
          }
        }
      }
    };

    walk(this.vaultDir);
    return folders;
  }

  /**
   * Get folder by path
   */
  getFolderByPath(folderPath: string): TFolder | null {
    const normalizedPath = normalizePath(folderPath);
    const fullPath = path.join(this.vaultDir, normalizedPath);

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      return null;
    }

    return this.createTFolder(normalizedPath);
  }

  /**
   * Delete a folder
   */
  async deleteFolder(folderPath: string): Promise<void> {
    const normalizedPath = normalizePath(folderPath);
    const fullPath = path.join(this.vaultDir, normalizedPath);

    if (!fs.existsSync(fullPath)) {
      return;
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory: ' + normalizedPath);
    }

    // Use rmSync with recursive to delete folder and contents
    fs.rmSync(fullPath, { recursive: true, force: true });
  }

  /**
   * Rename a folder
   */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);

    const oldFullPath = path.join(this.vaultDir, normalizedOldPath);
    const newFullPath = path.join(this.vaultDir, normalizedNewPath);

    if (!fs.existsSync(oldFullPath)) {
      throw new Error('Folder not found: ' + normalizedOldPath);
    }

    if (fs.existsSync(newFullPath)) {
      throw new Error('Target folder already exists: ' + normalizedNewPath);
    }

    fs.renameSync(oldFullPath, newFullPath);
  }

  /**
   * Adapter for low-level operations - using a function to properly bind this
   */
  createAdapter() {
    const vault = this;
    return {
      stat: (filePath: string): FileStat => {
        const fullPath = path.join(vault.vaultDir, filePath);
        const stat = fs.statSync(fullPath);
        return {
          ctime: Math.floor(stat.ctimeMs),
          mtime: Math.floor(stat.mtimeMs),
          size: stat.size
        };
      },
      readBinary: (filePath: string): Promise<Buffer> => {
        return vault.readBinary(filePath);
      }
    };
  }

  // Adapter property - initialize in constructor
  adapter: ReturnType<typeof this.createAdapter>;

  /**
   * Helper: Create TFile object from path and stat
   */
  private createTFile(filePath: string, stat: fs.Stats): TFile {
    const name = path.basename(filePath);
    const ext = path.extname(filePath).slice(1);

    return {
      path: filePath,
      name: name,
      extension: ext,
      stat: {
        ctime: Math.floor(stat.ctimeMs),
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size
      }
    };
  }

  /**
   * Helper: Create TFolder object from path
   */
  private createTFolder(folderPath: string): TFolder {
    const name = path.basename(folderPath);
    return {
      path: folderPath,
      name: name
    };
  }

  /**
   * Check if file exists
   */
  fileExists(filePath: string): boolean {
    const fullPath = path.join(this.vaultDir, filePath);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
  }

  /**
   * Check if folder exists
   */
  folderExists(folderPath: string): boolean {
    const fullPath = path.join(this.vaultDir, folderPath);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  }
}
