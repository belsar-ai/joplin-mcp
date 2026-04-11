import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

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
        attempted.push(settingsPath);
        continue;
      }

      const settingsContent = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);

      if (!settings['api.token']) {
        console.error(
          `[Info] API token not found in Joplin settings at: ${settingsPath}`,
        );
        console.error(
          '[Info] Make sure Web Clipper is enabled in Joplin settings',
        );
        return null;
      }

      console.error(
        `[Info] Successfully auto-discovered Joplin API token from: ${settingsPath}`,
      );
      return settings['api.token'];
    }

    console.error(
      `[Info] Joplin settings not found. Tried: ${attempted.join(', ')}`,
    );
    return null;
  } catch (error) {
    console.error(
      '[Warning] Failed to auto-discover Joplin token:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
