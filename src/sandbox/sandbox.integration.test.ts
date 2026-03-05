/**
 * Integration tests that verify both isolation layers actually work:
 *  1. vm context — blocks access to Node.js globals (process, require, import)
 *  2. OS sandbox (bwrap/sandbox-exec) — blocks network + filesystem at kernel level
 *
 * These use the real @anthropic-ai/sandbox-runtime — no mocks.
 * They will be skipped if srt or system deps (bwrap, socat, rg) are missing.
 *
 * Run with: npx vitest run src/sandbox/sandbox.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { Broker, SANDBOX_CONFIG } from './broker.js';
import type { JoplinApiClient } from '../api/client.js';

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
  // ── vm context layer ──

  it('should block dynamic import()', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    await expect(
      broker.execute(
        'const fs = await import("fs"); return "IMPORT_NOT_BLOCKED";',
      ),
    ).rejects.toThrow(/import/i);
  });

  it('should block access to process', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    const result = await broker.execute(
      'return typeof process === "undefined" ? "blocked" : "PROCESS_NOT_BLOCKED";',
    );
    expect(result).toBe('blocked');
  });

  it('should block access to require', { timeout: 30000 }, async () => {
    const broker = new Broker(mockClient);
    const result = await broker.execute(
      'return typeof require === "undefined" ? "blocked" : "REQUIRE_NOT_BLOCKED";',
    );
    expect(result).toBe('blocked');
  });

  // ── Basic execution ──

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

// ── OS sandbox layer ──
// These tests bypass the vm layer by running Node.js scripts directly inside
// the OS sandbox (bwrap/sandbox-exec), verifying kernel-level enforcement.

describe.skipIf(!sandboxAvailable)('OS sandbox integration', () => {
  let wrapWithSandbox: (cmd: string) => Promise<string>;
  let cleanupAfterCommand: () => void;
  let resetSandbox: () => Promise<void>;

  beforeAll(async () => {
    const srt = await import('@anthropic-ai/sandbox-runtime');
    await srt.SandboxManager.initialize(SANDBOX_CONFIG);
    wrapWithSandbox = (cmd: string) => srt.SandboxManager.wrapWithSandbox(cmd);
    cleanupAfterCommand = () => srt.SandboxManager.cleanupAfterCommand();
    resetSandbox = () => srt.SandboxManager.reset();
  });

  afterAll(async () => {
    await resetSandbox();
  });

  /** Run a Node.js script inside the OS sandbox (no vm layer). */
  async function runInOsSandbox(script: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'joplin-os-test-'));
    const scriptPath = join(dir, 'test.js');
    await writeFile(scriptPath, script);
    const cmd = await wrapWithSandbox(`node ${scriptPath}`);

    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(cmd, {
          shell: true,
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve('blocked: timeout');
        }, 15_000);

        child.on('close', () => {
          clearTimeout(timer);
          resolve(stdout.trim());
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      cleanupAfterCommand();
    }
  }

  it('should block outbound network access', { timeout: 30000 }, async () => {
    const result = await runInOsSandbox(`
      const http = require('http');
      const req = http.get('http://example.com', () => {
        process.stdout.write('NETWORK_NOT_BLOCKED');
      });
      req.on('error', (err) => {
        process.stdout.write('blocked: ' + err.code);
      });
      req.setTimeout(5000, () => {
        req.destroy();
        process.stdout.write('blocked: timeout');
      });
    `);
    expect(result).not.toBe('NETWORK_NOT_BLOCKED');
    expect(String(result)).toMatch(/^blocked:/);
  });

  it('should block filesystem writes', { timeout: 30000 }, async () => {
    const result = await runInOsSandbox(`
      const fs = require('fs');
      try {
        fs.writeFileSync('/tmp/sandbox-test-escape', 'pwned');
        process.stdout.write('WRITE_NOT_BLOCKED');
      } catch (err) {
        process.stdout.write('blocked: ' + err.code);
      }
    `);
    expect(result).not.toBe('WRITE_NOT_BLOCKED');
    expect(String(result)).toMatch(/^blocked:/);
  });

  it('should block reading denied paths', { timeout: 30000 }, async () => {
    const home = homedir();
    const result = await runInOsSandbox(`
      const fs = require('fs');
      try {
        const entries = fs.readdirSync('${home}/.ssh');
        if (entries.length > 0) {
          process.stdout.write('READ_NOT_BLOCKED: ' + entries.join(','));
        } else {
          process.stdout.write('blocked: empty tmpfs');
        }
      } catch (err) {
        process.stdout.write('blocked: ' + err.code);
      }
    `);
    expect(String(result)).not.toMatch(/^READ_NOT_BLOCKED/);
    expect(String(result)).toMatch(/^blocked:/);
  });

  it('should block writing to /tmp/claude', { timeout: 30000 }, async () => {
    const result = await runInOsSandbox(`
      const fs = require('fs');
      try {
        fs.mkdirSync('/tmp/claude', { recursive: true });
        fs.writeFileSync('/tmp/claude/escape-test', 'pwned');
        process.stdout.write('WRITE_NOT_BLOCKED');
      } catch (err) {
        process.stdout.write('blocked: ' + err.code);
      }
    `);
    expect(result).not.toBe('WRITE_NOT_BLOCKED');
    expect(String(result)).toMatch(/^blocked:/);
  });
});
