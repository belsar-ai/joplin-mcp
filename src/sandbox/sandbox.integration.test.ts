/**
 * Integration tests that verify the OS-level sandbox actually works.
 * These use the real @anthropic-ai/sandbox-runtime — no mocks.
 * They will be skipped if srt or system deps (bwrap, socat, rg) are missing.
 *
 * Run with: npx vitest run src/sandbox/sandbox.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Broker } from './broker.js';
import type { JoplinApiClient } from '../api/client.js';
import { homedir } from 'os';

// Check if sandbox deps are available synchronously at module load
let sandboxAvailable = false;
try {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  const deps = SandboxManager.checkDependencies();
  sandboxAvailable = deps.errors.length === 0 && deps.warnings.length === 0;
} catch {
  sandboxAvailable = false;
}

// Minimal mock client — these tests don't make real Joplin API calls
const mockClient = {
  notes: {},
  notebooks: {},
} as unknown as JoplinApiClient;

describe.skipIf(!sandboxAvailable)('Sandbox integration', () => {
  // Increase timeout — sandbox init + child spawn is slower than unit tests
  it('should block outbound network access', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    const result = await broker.execute(`
      const http = await import('http');
      return new Promise((resolve) => {
        const req = http.get('http://example.com', () => {
          resolve('NETWORK_NOT_BLOCKED');
        });
        req.on('error', (err) => {
          resolve('blocked: ' + err.code);
        });
        req.setTimeout(5000, () => {
          req.destroy();
          resolve('blocked: timeout');
        });
      });
    `);
    expect(result).not.toBe('NETWORK_NOT_BLOCKED');
    expect(String(result)).toMatch(/^blocked:/);
  });

  it('should block filesystem writes', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    const result = await broker.execute(`
      const fs = await import('fs');
      try {
        fs.writeFileSync('/tmp/sandbox-test-escape', 'pwned');
        return 'WRITE_NOT_BLOCKED';
      } catch (err) {
        return 'blocked: ' + err.code;
      }
    `);
    expect(result).not.toBe('WRITE_NOT_BLOCKED');
    expect(String(result)).toMatch(/^blocked:/);
  });

  it('should block reading denied paths', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    const home = homedir();
    // denyRead mounts a tmpfs over the directory, so files inside are invisible
    const result = await broker.execute(`
      const fs = await import('fs');
      const entries = fs.readdirSync('${home}/.ssh');
      if (entries.length > 0) return 'READ_NOT_BLOCKED: ' + entries.join(',');
      return 'blocked: empty tmpfs';
    `);
    expect(String(result)).not.toMatch(/^READ_NOT_BLOCKED/);
    expect(String(result)).toMatch(/^blocked:/);
  });

  it('should block writing to /tmp/claude', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    const result = await broker.execute(`
      const fs = await import('fs');
      try {
        fs.mkdirSync('/tmp/claude', { recursive: true });
        fs.writeFileSync('/tmp/claude/escape-test', 'pwned');
        return 'WRITE_NOT_BLOCKED';
      } catch (err) {
        return 'blocked: ' + err.code;
      }
    `);
    expect(result).not.toBe('WRITE_NOT_BLOCKED');
    expect(String(result)).toMatch(/^blocked:/);
  });

  it(
    'should allow RPC calls through the allowlist',
    { timeout: 30000 },
    async () => {
      const broker = new Broker(mockClient);
      const result = await broker.execute('return 1 + 1;');
      expect(result).toBe(2);
    },
  );
});
