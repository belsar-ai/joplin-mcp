/**
 * Sandbox Broker — spawns a sandboxed runner process for each script execution.
 *
 * Lifecycle:
 *  - initialize() once at first use (lazy)
 *  - cleanupAfterCommand() after each execution
 *  - reset() only on shutdown
 *
 * Requires @anthropic-ai/sandbox-runtime — throws if not installed (fail-closed).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { JoplinApiClient } from '../api/client.js';
import type {
  RunnerMessage,
  ExecuteMessage,
  RpcResultMessage,
  RpcErrorMessage,
} from './protocol.js';
import { dispatchAllowedCall } from './allowlist.js';

type SandboxManagerType =
  (typeof import('@anthropic-ai/sandbox-runtime'))['SandboxManager'];

const TIMEOUT_MS = 30_000;

export const SANDBOX_CONFIG = {
  network: {
    allowedDomains: [] as string[],
    deniedDomains: [] as string[],
    allowLocalBinding: false,
  },
  filesystem: {
    denyRead: [
      '~/.ssh',
      '~/.gnupg',
      '~/.aws',
      '~/.config',
      '~/.local',
      '~/.docker',
      '~/.kube',
      '~/.password-store',
      '~/.netrc',
      '~/Documents',
      '~/Downloads',
      '~/Desktop',
      '~/Pictures',
      '~/Library',
    ],
    allowWrite: [] as string[],
    // Block srt's default write paths — the runner has no legitimate
    // reason to write anywhere. Without this, /tmp/claude is writable
    // and could be used as a sandbox escape vector.
    denyWrite: [
      '/dev/null',
      '/dev/stdout',
      '/dev/stderr',
      '/dev/tty',
      '/dev/dtracehelper',
      '/dev/autofs_nowait',
      '/tmp/claude',
      '/private/tmp/claude',
      '~/.npm/_logs',
      '~/.claude',
    ],
  },
} satisfies SandboxRuntimeConfig;

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class Broker {
  private client: JoplinApiClient;
  private sandboxManager!: SandboxManagerType;
  private initialized = false;

  constructor(client: JoplinApiClient) {
    this.client = client;
  }

  /**
   * Lazy initialization — called once on first execute().
   * Loads @anthropic-ai/sandbox-runtime; throws if not installed (fail-closed).
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load sandbox runtime
    let srt: typeof import('@anthropic-ai/sandbox-runtime');
    try {
      srt = await import('@anthropic-ai/sandbox-runtime');
    } catch {
      throw new Error(
        'Sandbox runtime (@anthropic-ai/sandbox-runtime) is not installed. ' +
          'Install it with: npm install @anthropic-ai/sandbox-runtime',
      );
    }

    this.sandboxManager = srt.SandboxManager;
    await this.sandboxManager.initialize(SANDBOX_CONFIG);

    // Treat seccomp warnings as hard errors — untrusted code must not
    // have unix socket access (Docker daemon, SSH agent, D-Bus, etc.)
    const deps = this.sandboxManager.checkDependencies();
    const allIssues = [...deps.errors, ...deps.warnings];
    if (allIssues.length > 0) {
      throw new Error(`Sandbox dependencies not met: ${allIssues.join('; ')}`);
    }

    // Only mark initialized after everything succeeds
    this.initialized = true;
  }

  /**
   * Execute a script in a sandboxed runner process.
   */
  async execute(
    code: string,
    options?: { readOnly?: boolean },
  ): Promise<unknown> {
    await this.initialize();

    // Resolve runner.js — always use the compiled dist/ version since
    // the runner is a standalone Node process (not run by vitest/tsx).
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);
    let runnerPath: string;
    if (thisDir.includes('/dist/')) {
      // Running from compiled output
      runnerPath = join(thisDir, 'runner.js');
    } else {
      // Running from source (vitest) — resolve to dist/
      const projectRoot = join(thisDir, '..', '..');
      runnerPath = join(projectRoot, 'dist', 'sandbox', 'runner.js');
    }

    // Create temp dir for cwd
    const tmpDir = await mkdtemp(join(tmpdir(), 'joplin-sandbox-'));

    let child: ChildProcess | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const baseCommand = [process.execPath, runnerPath]
        .map(quoteShellArg)
        .join(' ');
      const { argv } = await this.sandboxManager.wrapWithSandboxArgv(
        baseCommand,
        undefined,
        undefined,
        undefined,
        tmpDir,
      );

      // Fail closed if the runtime ever returns an unwrapped command.
      const hasSandbox = argv.some(
        (arg) =>
          arg.includes('bwrap') ||
          arg.includes('sandbox-exec') ||
          arg.includes('srt-win'),
      );
      if (!hasSandbox) {
        throw new Error(
          'Sandbox wrapper did not produce a sandboxed command. ' +
            'Refusing to execute untrusted code without OS-level isolation.',
        );
      }

      return await new Promise<unknown>((resolve, reject) => {
        child = spawn(argv[0], argv.slice(1), {
          shell: false,
          cwd: tmpDir,
          env: { PATH: process.env.PATH, HOME: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderrBuf = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf = (stderrBuf + chunk.toString()).slice(-8192);
          process.stderr.write(chunk);
        });

        // Read JSON lines from stdout
        let stdoutBuf = '';
        let settled = false;

        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true;
            fn();
          }
        };

        // 30s kill timer
        timer = setTimeout(() => {
          settle(() => {
            child?.kill('SIGKILL');
            reject(new Error('Script execution timed out (30s)'));
          });
        }, TIMEOUT_MS);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString();
          let nl: number;
          while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line.trim()) continue;

            let msg: RunnerMessage;
            try {
              msg = JSON.parse(line) as RunnerMessage;
            } catch {
              continue; // skip non-JSON lines
            }

            if (msg.type === 'rpc_call') {
              // Dispatch through allowlist
              dispatchAllowedCall(this.client, msg.method, msg.args, {
                readOnly: options?.readOnly,
              })
                .then((result) => {
                  const resp: RpcResultMessage = {
                    type: 'rpc_result',
                    id: msg.id,
                    result,
                  };
                  child?.stdin?.write(JSON.stringify(resp) + '\n');
                })
                .catch((err) => {
                  const resp: RpcErrorMessage = {
                    type: 'rpc_error',
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  };
                  child?.stdin?.write(JSON.stringify(resp) + '\n');
                });
            } else if (msg.type === 'result') {
              settle(() => resolve(msg.value));
            } else if (msg.type === 'error') {
              settle(() => reject(new Error(msg.error)));
            }
          }
        });

        child.on('error', (err) => {
          settle(() => reject(err));
        });

        child.on('close', (exitCode) => {
          settle(() => {
            if (exitCode !== 0 && exitCode !== null) {
              const detail = stderrBuf.trim();
              reject(
                new Error(
                  `Runner exited with code ${exitCode}${detail ? `: ${detail}` : ''}`,
                ),
              );
            } else {
              // Runner closed without sending result/error
              resolve(undefined);
            }
          });
        });

        // Send execute message
        const execMsg: ExecuteMessage = { type: 'execute', code };
        child.stdin?.write(JSON.stringify(execMsg) + '\n');
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (child) {
        (child as ChildProcess).kill();
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      this.sandboxManager.cleanupAfterCommand();
    }
  }

  /**
   * Shutdown — release sandbox resources.
   */
  async shutdown(): Promise<void> {
    if (this.initialized) {
      await this.sandboxManager.reset();
    }
  }
}
