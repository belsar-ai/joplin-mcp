import { parse } from 'smol-toml';
import * as fs from 'fs';
import * as path from 'path';

export interface JoplinMcpConfig {
  defaults?: {
    notebook?: string;
  };
  scope?: {
    notebooks?: string[];
  };
}

const CONFIG_FILENAME = 'joplin-mcp.toml';

/**
 * Walk up directories to find joplin-mcp.toml (like .git discovery)
 */
function findConfigFile(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const configPath = path.join(currentDir, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    currentDir = path.dirname(currentDir);
  }

  // Check root as well
  const rootConfig = path.join(root, CONFIG_FILENAME);
  if (fs.existsSync(rootConfig)) {
    return rootConfig;
  }

  return null;
}

let cachedConfig: JoplinMcpConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load config from joplin-mcp.toml, walking up from cwd.
 * Returns empty config if no file found.
 */
export function loadConfig(forceReload = false): JoplinMcpConfig {
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    cachedConfig = {};
    cachedConfigPath = null;
    return cachedConfig;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    cachedConfig = parse(content) as JoplinMcpConfig;
    cachedConfigPath = configPath;
    return cachedConfig;
  } catch (error) {
    console.error(`Failed to parse ${configPath}:`, error);
    cachedConfig = {};
    cachedConfigPath = null;
    return cachedConfig;
  }
}

/**
 * Get the path to the loaded config file, if any.
 */
export function getConfigPath(): string | null {
  return cachedConfigPath;
}

/**
 * Check if notebooks are scoped in the config.
 */
export function hasNotebookScope(): boolean {
  const config = loadConfig();
  return !!(config.scope?.notebooks && config.scope.notebooks.length > 0);
}

/**
 * Get scoped notebook names (lowercase for comparison).
 */
export function getScopedNotebooks(): string[] {
  const config = loadConfig();
  return (config.scope?.notebooks || []).map((n) => n.toLowerCase());
}

/**
 * Get the default notebook name.
 */
export function getDefaultNotebook(): string | undefined {
  const config = loadConfig();
  return config.defaults?.notebook;
}
