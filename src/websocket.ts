import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { addRandomParam, isWsUrl, log, logError } from './helps';
import { SyncMessage, FileDownloadSession } from './types';
import { FileOperator } from './file_operator';

// Reconnect constants
const RECONNECT_BASE_DELAY = 3000;
const CONNECTION_CHECK_INTERVAL = 3000;

// Error codes
const ERROR_SYNC_CONFLICT = 530;

export type MessageHandler = (data: any, client: SyncClient) => void;

/**
 * Sync Client - WebSocket client for syncing with server
 */
export class SyncClient {
  private ws: WebSocket | null = null;
  private wsApi: string;
  private apiToken: string;
  private vaultName: string;

  public isOpen: boolean = false;
  public isAuth: boolean = false;
  public isFirstSync: boolean = true;
  public isWatchEnabled: boolean = true;
  private checkConnection: NodeJS.Timeout | null = null;
  private checkReConnectTimeout: NodeJS.Timeout | null = null;
  private timeConnect = 0;
  private count = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 15;

  // Message handlers
  public messageHandlers = new Map<string, MessageHandler>();

  // Binary message handlers
  private binaryHandlers = new Map<string, (data: ArrayBuffer, client: SyncClient) => void>();

  // Download sessions
  public fileDownloadSessions = new Map<string, FileDownloadSession>();

  // Ignored paths
  public ignoredPaths = new Set<string>();

  // File hash cache
  public fileHashes = new Map<string, string | null>();

  // Sync tasks tracking
  public noteSyncTasks = { completed: 0 };
  public fileSyncTasks = { completed: 0 };
  public folderSyncTasks = { completed: 0 };
  public syncTypeCompleteCount = 0;

  // Total chunks tracking
  public totalChunksToUpload = 0;
  public totalChunksToDownload = 0;
  public uploadedChunksCount = 0;
  public downloadedChunksCount = 0;
  public downloadedFilesCount = 0;
  public totalFilesToDownload = 0;

  // Local storage metadata
  private metadata = new Map<string, any>();
  private metadataFile: string;
  private fileHashesFile: string;

  // File operator reference
  private fileOperator: FileOperator;

  // Callback for when sync should start
  public onSyncStart: (() => void) | null = null;

  constructor(vaultName: string, vaultDir: string, apiUrl: string, apiToken: string, fileOperator: FileOperator) {
    this.vaultName = vaultName;
    this.apiToken = apiToken;
    this.fileOperator = fileOperator;

    // Convert http to ws
    this.wsApi = apiUrl.replace(/^http/, 'ws').replace(/\/+$/, '');

    // Initialize metadata file path in vault's .obsidian folder
    const obsidianDir = path.join(vaultDir, '.obsidian');
    if (!fs.existsSync(obsidianDir)) {
      fs.mkdirSync(obsidianDir, { recursive: true });
    }
    this.metadataFile = path.join(obsidianDir, 'sync-metadata.json');
    this.loadMetadata();

    // Initialize file hashes file path
    this.fileHashesFile = path.join(obsidianDir, 'file-hashes.json');
    this.loadFileHashes();
  }

  /**
   * Load file hashes from file
   */
  private loadFileHashes(): void {
    try {
      if (fs.existsSync(this.fileHashesFile)) {
        const data = JSON.parse(fs.readFileSync(this.fileHashesFile, 'utf-8'));
        this.fileHashes = new Map(Object.entries(data));
        log('[FileHashes] Loaded', this.fileHashes.size, 'hashes from:', this.fileHashesFile);
      }
    } catch (e) {
      // Ignore errors
    }
  }

  /**
   * Save file hashes to file
   */
  private saveFileHashes(): void {
    try {
      const obj = Object.fromEntries(this.fileHashes);
      fs.writeFileSync(this.fileHashesFile, JSON.stringify(obj, null, 2));
    } catch (e) {
      log('[FileHashes] Save error:', e);
    }
  }

  /**
   * Load metadata from file
   */
  private loadMetadata(): void {
    try {
      if (fs.existsSync(this.metadataFile)) {
        const data = JSON.parse(fs.readFileSync(this.metadataFile, 'utf-8'));
        this.metadata = new Map(Object.entries(data));
        log('[Metadata] Loaded from:', this.metadataFile);
      }
    } catch (e) {
      // Ignore errors
    }
  }

  /**
   * Save metadata to file
   */
  private saveMetadata(): void {
    try {
      const obj = Object.fromEntries(this.metadata);
      fs.writeFileSync(this.metadataFile, JSON.stringify(obj, null, 2));
    } catch (e) {
      log('[Metadata] Save error:', e);
    }
  }

  /**
   * Register message handler
   */
  registerHandler(action: string, handler: MessageHandler): void {
    this.messageHandlers.set(action, handler);
  }

  /**
   * Register binary handler
   */
  registerBinaryHandler(prefix: string, handler: (data: ArrayBuffer, client: SyncClient) => void): void {
    if (prefix.length !== 2) {
      logError('Binary handler prefix must be exactly 2 characters');
      return;
    }
    this.binaryHandlers.set(prefix, handler);
  }

  /**
   * Get metadata
   */
  getMetadata(key: string): any {
    return this.metadata.get(key);
  }

  /**
   * Set metadata
   */
  setMetadata(key: string, value: any): void {
    this.metadata.set(key, value);
    this.saveMetadata();
  }

  /**
   * Clear all metadata (for when vault is deleted/recreated)
   */
  clearAllMetadata(): void {
    this.metadata.clear();
    this.saveMetadata();
  }

  /**
   * Clear all file hashes (for when vault is deleted/recreated)
   */
  clearAllFileHashes(): void {
    this.fileHashes.clear();
    this.saveFileHashes();
  }

  /**
   * Get watch enabled status
   */
  getWatchEnabled(): boolean {
    return this.isWatchEnabled;
  }

  /**
   * Check if file is ignored
   */
  isIgnoredFile(path: string): boolean {
    // Ignore .obsidian folder (local cache files)
    if (path.startsWith('.obsidian/') || path === '.obsidian') {
      return true;
    }
    return this.ignoredPaths.has(path);
  }

  /**
   * Add ignored file
   */
  addIgnoredFile(path: string): void {
    this.ignoredPaths.add(path);
  }

  /**
   * Remove ignored file
   */
  removeIgnoredFile(path: string): void {
    this.ignoredPaths.delete(path);
  }

  /**
   * Get file hash
   */
  getFileHash(path: string): string | null {
    return this.fileHashes.get(path) || null;
  }

  /**
   * Set file hash
   */
  setFileHash(path: string, hash: string): void {
    this.fileHashes.set(path, hash);
    this.saveFileHashes();
  }

  /**
   * Remove file hash
   */
  removeFileHash(path: string): void {
    this.fileHashes.delete(path);
    this.saveFileHashes();
  }

  /**
   * Get all tracked file paths
   */
  getAllPaths(): string[] {
    return Array.from(this.fileHashes.keys());
  }

  /**
   * Connect to WebSocket server
   */
  connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const url = addRandomParam(this.wsApi + '/api/user/sync?lang=en&count=' + this.count);
    log('Connecting to', url);

    this.ws = new WebSocket(url);

    this.ws.on('error', (error) => {
      logError('WebSocket error:', error);
      this.isOpen = false;
    });

    this.ws.on('open', () => {
      log('Connected, authenticating...');
      this.isOpen = true;
      this.isAuth = false;
      this.Send('Authorization', this.apiToken);
      this.startConnectionCheck();
    });

    this.ws.on('close', (code, reason) => {
      log('Connection closed:', code, reason.toString());
      this.isAuth = false;
      this.isOpen = false;
      this.stopConnectionCheck();

      if (this.reconnectAttempts < this.maxReconnectAttempts && reason.toString() !== 'AuthorizationFaild' && reason.toString() !== 'ClientClose') {
        this.scheduleReconnect();
      }
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: WebSocket.Data): void {
    // Handle binary message - Node.js ws library returns Buffer
    if (Buffer.isBuffer(data)) {
      // Check if it's actually binary (starts with binary prefix)
      if (data.length >= 2) {
        const prefix = data.slice(0, 2).toString('ascii');
        if (prefix === '00' || prefix === '01') {
          this.handleBinaryMessage(data);
          return;
        }
      }
      // If not binary prefix, treat as text
    }

    // Handle text message
    const message = data.toString();

    log('[DEBUG] Raw message received:', message.substring(0, 200));

    const index = message.indexOf('|');
    if (index === -1) {
      return;
    }

    const msgAction = message.slice(0, index);
    const msgData = message.slice(index + 1);

    let dataObj: any;
    try {
      dataObj = JSON.parse(msgData);
    } catch (e) {
      logError('JSON parse error:', e);
      return;
    }

    // Handle authorization
    if (msgAction === 'Authorization') {
      if (dataObj.code === 0 || dataObj.code > 200) {
        logError('Authorization failed:', dataObj.code, dataObj.msg || dataObj.message);
        this.ws?.close();
        process.exit(1);
      } else {
        log('Authenticated successfully');
        this.isAuth = true;
        this.reconnectAttempts = 0;
        // Send client info after auth
        this.sendClientInfo();
      }
      return;
    }

    // Handle client info response
    if (msgAction === 'ClientInfo') {
      if (dataObj.code === 0 || dataObj.code > 200) {
        log('[WARN] ClientInfo error:', dataObj.code);
      } else {
        log('[INFO] ClientInfo received, starting sync...');
        if (this.onSyncStart) {
          this.onSyncStart();
        }
      }
      return;
    }

    // Handle errors
    if (dataObj.code === 0 || dataObj.code > 200) {
      if (dataObj.code === ERROR_SYNC_CONFLICT) {
        this.handleConflictError(dataObj);
      } else {
        logError('Server error:', dataObj);
      }
      return;
    }

    // Check vault match
    if (dataObj.vault && dataObj.vault !== this.vaultName) {
      log('Service vault', dataObj.vault, 'not match', this.vaultName);
      return;
    }

    // Call registered handler
    const handler = this.messageHandlers.get(msgAction);
    if (handler) {
      handler(dataObj.data || dataObj, this);
    } else {
      log('[WARN] Unknown action:', msgAction);
    }
  }

  /**
   * Handle binary message
   */
  private handleBinaryMessage(data: WebSocket.Data): void {
    let buffer: ArrayBuffer;
    if (Buffer.isBuffer(data)) {
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer;
    } else if (data instanceof ArrayBuffer) {
      buffer = data;
    } else {
      return;
    }

    if (buffer.byteLength < 2) return;

    const prefixBytes = new Uint8Array(buffer.slice(0, 2));
    const prefix = new TextDecoder().decode(prefixBytes);

    const handler = this.binaryHandlers.get(prefix);
    if (handler) {
      const rest = buffer.slice(2);
      handler(rest as ArrayBuffer, this);
    } else {
      log('[WARN] No handler for binary prefix:', prefix);
    }
  }

  /**
   * Handle conflict error
   */
  private handleConflictError(data: any): void {
    const path = data.data?.path;
    log('Conflict detected:', { code: data.code, path: path, message: data.message });
  }

  /**
   * Send message to server
   */
  Send(action: string, data: string | object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('Service not connected, cannot send:', action);
      return;
    }

    const message = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(action + '|' + message);
  }

  /**
   * Send binary message to server
   */
  async SendBinary(data: ArrayBuffer | Uint8Array, prefix: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!prefix || prefix.length !== 2) {
      return false;
    }

    let dataToSend: Uint8Array;
    if (data instanceof Uint8Array) {
      const prefixBytes = new TextEncoder().encode(prefix);
      dataToSend = new Uint8Array(prefixBytes.length + data.length);
      dataToSend.set(prefixBytes);
      dataToSend.set(data, prefixBytes.length);
    } else {
      const prefixBytes = new TextEncoder().encode(prefix);
      const dataView = new Uint8Array(data);
      dataToSend = new Uint8Array(prefixBytes.length + dataView.length);
      dataToSend.set(prefixBytes);
      dataToSend.set(dataView, prefixBytes.length);
    }

    this.ws.send(dataToSend);
    return false;
  }

  /**
   * Start connection check
   */
  private startConnectionCheck(): void {
    this.checkConnection = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.isOpen = true;
      } else {
        this.isOpen = false;
      }
    }, CONNECTION_CHECK_INTERVAL);
  }

  /**
   * Stop connection check
   */
  private stopConnectionCheck(): void {
    if (this.checkConnection) {
      clearInterval(this.checkConnection);
      this.checkConnection = null;
    }
    if (this.checkReConnectTimeout) {
      clearTimeout(this.checkReConnectTimeout);
      this.checkReConnectTimeout = null;
    }
  }

  /**
   * Schedule reconnect
   */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1);
    log('Reconnecting in', delay, 'ms (attempt', this.reconnectAttempts, ')');

    this.checkReConnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Start sync
   */
  private startSync(): void {
    log('Starting sync...');
    // This will be called after authentication
    // The actual sync logic will be triggered by handlers
  }

  /**
   * Send client info to server
   */
  private sendClientInfo(): void {
    if (!this.isAuth) {
      return;
    }

    // Determine client type based on platform
    let clientName = 'CLI';
    const platform = process.platform;
    if (platform === 'darwin') {
      clientName += ' Mac';
    } else if (platform === 'win32') {
      clientName += ' Win';
    } else if (platform === 'linux') {
      clientName += ' Linux';
    }

    const clientInfo = {
      name: clientName,
      version: '1.0.0',
      type: 'cli',
      offlineSyncStrategy: 'auto'
    };

    log('[INFO] Sending ClientInfo:', clientInfo);
    this.Send('ClientInfo', JSON.stringify(clientInfo));
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    this.stopConnectionCheck();
    this.isOpen = false;
    this.isAuth = false;
    if (this.ws) {
      this.ws.close(1000, 'ClientClose');
    }
  }
}
