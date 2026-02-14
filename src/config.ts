import * as fs from 'fs';
import * as path from 'path';
import { CLIConfig } from './types';

const CONFIG_FILE = path.join(__dirname, '../config.json');

/**
 * Normalized config interface for internal use
 */
export interface NormalizedConfig {
  vault_dir: string;
  vault_name: string;
  api_url: string;
  api_token: string;
  enable_local_push: boolean;
}

export function loadConfig(): NormalizedConfig {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data) as CLIConfig;

    // Support both original plugin format and CLI format
    const api = config.api || config.api_url;
    const apiToken = config.apiToken || config.api_token;
    const vaultName = config.vault || config.vault_name;
    let vaultDir = config.vault_dir || '';

    // Validate required fields
    if (!apiToken) {
      throw new Error('apiToken/api_token is required in config.json');
    }

    // If vault_dir is not provided, try to infer from environment or use default
    if (!vaultDir) {
      // Try common Obsidian vault locations
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const obsidianVaults = path.join(home, 'Obsidian');
      if (fs.existsSync(obsidianVaults) && vaultName) {
        vaultDir = path.join(obsidianVaults, vaultName);
      }
      if (!vaultDir || !fs.existsSync(vaultDir)) {
        throw new Error('vault_dir is required in config.json or vault must exist in ~/Obsidian/');
      }
    }

    // Resolve vault_dir to absolute path
    if (!path.isAbsolute(vaultDir)) {
      vaultDir = path.resolve(process.cwd(), vaultDir);
    }

    // Set default vault_name if not provided
    const finalVaultName = vaultName || path.basename(vaultDir);

    // Set default api_url if not provided
    const finalApiUrl = api || 'http://localhost:9000';

    // Set default enable_local_push if not provided
    const enableLocalPush = config.enable_local_push !== false;

    return {
      vault_dir: vaultDir,
      vault_name: finalVaultName,
      api_url: finalApiUrl,
      api_token: apiToken,
      enable_local_push: enableLocalPush
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      throw new Error(`Config file not found: ${CONFIG_FILE}`);
    }
    throw error;
  }
}

export function saveConfig(config: CLIConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
