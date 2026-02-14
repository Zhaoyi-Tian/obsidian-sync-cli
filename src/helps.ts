/**
 * Helper functions - adapted from plugin for CLI usage
 * Removed Obsidian dependencies (Notice, moment, normalizePath, TFolder)
 */

/**
 * Normalize path - convert backslashes to forward slashes
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Get file name from path
 */
export function getFileName(filePath: string, includeExt: boolean = true): string {
  const base = filePath.split(/[\\/]/).pop() || '';
  const lastDotIndex = base.lastIndexOf('.');

  if (lastDotIndex === -1) return '';

  if (includeExt) return base;
  return base.substring(0, lastDotIndex);
}

/**
 * Get directory name from path
 */
export function getDirName(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lastSlashIndex = normalizedPath.lastIndexOf('/');

  if (lastSlashIndex === -1) return '';

  const parts = normalizedPath.split('/');
  return parts[0] || '';
}

/**
 * Check if path matches pattern
 */
export function isPathMatch(filePath: string, pattern: string): boolean {
  // Try regex match (case insensitive)
  try {
    const regex = new RegExp('^' + pattern, 'i');
    if (regex.test(filePath)) return true;
  } catch (e) {
    // Ignore regex errors
  }

  // Traditional path prefix match
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const p = normalizedPattern.endsWith('/') ? normalizedPattern.slice(0, -1) : normalizedPattern;

  if (normalizedPath === p) return true;
  if (normalizedPath.startsWith(p + '/')) return true;

  return false;
}

/**
 * Hash string content (32-bit integer like the plugin)
 */
export function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash &= hash;
  }
  return String(hash);
}

/**
 * Hash ArrayBuffer (for binary files)
 */
export function hashArrayBuffer(buffer: ArrayBuffer): string {
  let hash = 0;
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    const byte = view[i];
    hash = (hash << 5) - hash + byte;
    hash &= hash;
  }
  return String(hash);
}

/**
 * Get safe ctime - if ctime is invalid, use mtime or current time
 */
export function getSafeCtime(stat: { ctime?: number; mtime?: number }): number {
  return (stat.ctime && stat.ctime > 0) ? stat.ctime : (stat.mtime || Date.now());
}

/**
 * Sleep/delay function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if URL is HTTP
 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/.+/i.test(url);
}

/**
 * Check if URL is WebSocket
 */
export function isWsUrl(url: string): boolean {
  return /^wss?:\/\/.+/i.test(url);
}

/**
 * Add random param to URL to prevent caching
 */
export function addRandomParam(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_t=${Date.now()}`;
}

/**
 * Log function (replaces Notice)
 */
export function log(...message: unknown[]): void {
  console.log(...message);
}

/**
 * Log error function
 */
export function logError(...message: unknown[]): void {
  console.error(...message);
}

/**
 * Convert milliseconds to seconds (for server timestamps)
 */
export function msToSeconds(ms: number): number {
  if (ms > 1e12) {  // If > 1 trillion (around year 2001), it's milliseconds
    return Math.floor(ms / 1000);
  }
  return ms;
}

/**
 * Convert seconds to milliseconds
 */
export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}
