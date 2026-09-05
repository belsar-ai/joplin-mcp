import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Build the list of candidate settings.json paths for the current platform.
 *
 * Joplin's install method affects where settings.json lives. The native
 * desktop app uses one location, while package managers like Homebrew place
 * it under XDG-style ~/.config/joplin instead. We try each candidate in order.
 */
function getCandidateSettingsPaths(): string[] {
  const platform = process.platform;
  const home = homedir();

  if (platform === 'darwin') {
    return [
      join(
        home,
        'Library',
        'Application Support',
        'joplin-desktop',
        'settings.json',
      ),
      join(home, '.config', 'joplin', 'settings.json'),
      join(home, '.config', 'joplin-desktop', 'settings.json'),
    ];
  }

  if (platform === 'win32') {
    const appData = process.env.APPDATA || '';
    return [
      join(appData, 'joplin-desktop', 'settings.json'),
      join(appData, 'joplin', 'settings.json'),
    ];
  }

  return [
    join(home, '.config', 'joplin-desktop', 'settings.json'),
    join(home, '.config', 'joplin', 'settings.json'),
  ];
}

/**
 * Auto-discover Joplin API token from settings.json
 */
export function discoverJoplinToken(): string | null {
  try {
    const candidates = getCandidateSettingsPaths();
    const attempted: string[] = [];

    for (const settingsPath of candidates) {
      if (!existsSync(settingsPath)) {
        attempted.push(`${settingsPath} (not found)`);
        continue;
      }

      // A single corrupt or token-less file must not abort discovery —
      // a later candidate may still hold the real token (e.g. stale
      // native settings.json alongside a working Homebrew install).
      let settings: Record<string, unknown>;
      try {
        const settingsContent = readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(settingsContent);
      } catch (error) {
        console.error(
          `[Warning] Failed to read Joplin settings at ${settingsPath}:`,
          error instanceof Error ? error.message : error,
        );
        attempted.push(`${settingsPath} (read/parse error)`);
        continue;
      }

      const token = settings?.['api.token'];
      if (typeof token !== 'string' || token === '') {
        attempted.push(`${settingsPath} (api.token missing)`);
        continue;
      }

      console.error(
        `[Info] Successfully auto-discovered Joplin API token from: ${settingsPath}`,
      );
      return token;
    }

    console.error(
      `[Info] Could not auto-discover Joplin API token. Tried: ${attempted.join(', ')}`,
    );
    console.error('[Info] Make sure Web Clipper is enabled in Joplin settings');
    return null;
  } catch (error) {
    console.error(
      '[Warning] Failed to auto-discover Joplin token:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
