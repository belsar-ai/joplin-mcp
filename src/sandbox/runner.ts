#!/usr/bin/env node

/**
 * Sandbox runner — standalone entry point executed in a separate (sandboxed) process.
 *
 * Reads an `execute` message from stdin, builds a `joplin.*.*()` proxy that
 * forwards every call as an RPC request over stdout, executes the user code
 * inside a vm context (whitelist: only `joplin` + `console` globals), and
 * writes a `result` or `error` message back to stdout.
 *
 * Console output is forwarded to stderr so it doesn't interfere with the
 * JSON protocol on stdout.
 */

import vm from 'node:vm';
import type {
  BrokerMessage,
  ExecuteMessage,
  RpcCallMessage,
  ResultMessage,
  ErrorMessage,
} from './protocol.js';

// ── Helpers ──

function writeLine(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Stdin reader: newline-delimited JSON ──

let stdinBuffer = '';
let resolveExecute: ((msg: ExecuteMessage) => void) | null = null;
let rejectExecute: ((error: Error) => void) | null = null;

const executeMessage = new Promise<ExecuteMessage>((resolve, reject) => {
  resolveExecute = resolve;
  rejectExecute = reject;
});

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pendingRpc = new Map<number, PendingRpc>();

function failPending(error: Error): void {
  rejectExecute?.(error);
  rejectExecute = null;
  resolveExecute = null;
  for (const pending of pendingRpc.values()) pending.reject(error);
  pendingRpc.clear();
}

function routeMessage(msg: BrokerMessage): void {
  if (msg.type === 'execute') {
    resolveExecute?.(msg);
    resolveExecute = null;
    rejectExecute = null;
    return;
  }

  if (msg.type !== 'rpc_result' && msg.type !== 'rpc_error') return;

  const pending = pendingRpc.get(msg.id);
  if (!pending) return;

  pendingRpc.delete(msg.id);
  if (msg.type === 'rpc_error') {
    pending.reject(new Error(msg.error));
  } else {
    pending.resolve(msg.result);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;
  let nl: number;
  while ((nl = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, nl);
    stdinBuffer = stdinBuffer.slice(nl + 1);
    if (line.trim()) {
      try {
        routeMessage(JSON.parse(line) as BrokerMessage);
      } catch (error) {
        failPending(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
});
process.stdin.on('error', (error) => failPending(error));

// ── RPC machinery ──

let nextRpcId = 1;

function makeRpcCall(method: string, args: unknown[]): Promise<unknown> {
  const id = nextRpcId++;
  const msg: RpcCallMessage = { type: 'rpc_call', id, method, args };

  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    try {
      writeLine(msg);
    } catch (error) {
      pendingRpc.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ── Build joplin proxy ──
// Two-level proxy: `joplin.<namespace>.<method>(...args)` → rpc_call

function buildJoplinProxy(): unknown {
  return new Proxy(
    {},
    {
      get(_target, namespace: string) {
        return new Proxy(
          {},
          {
            get(_t, method: string) {
              return (...args: unknown[]) =>
                makeRpcCall(`${namespace}.${method}`, args);
            },
          },
        );
      },
    },
  );
}

// ── Console proxy → stderr ──

const consoleProxy = {
  log: (...args: unknown[]) =>
    process.stderr.write('[Script Log] ' + args.map(String).join(' ') + '\n'),
  error: (...args: unknown[]) =>
    process.stderr.write('[Script Error] ' + args.map(String).join(' ') + '\n'),
  warn: (...args: unknown[]) =>
    process.stderr.write('[Script Warn] ' + args.map(String).join(' ') + '\n'),
};

// ── Main ──

async function main(): Promise<void> {
  // Wait for the execute message
  const execMsg = await executeMessage;

  const joplin = buildJoplinProxy();

  try {
    // Execute in a vm context — only joplin + console are available.
    // No process, require, import, fetch, Buffer, etc.
    // Wrapped in async IIFE for top-level await support.
    const context = vm.createContext({ joplin, console: consoleProxy });
    const result = await vm.runInNewContext(
      `(async () => { ${execMsg.code} })()`,
      context,
    );

    const msg: ResultMessage = { type: 'result', value: result };
    writeLine(msg);
  } catch (err) {
    const msg: ErrorMessage = {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    writeLine(msg);
  }

  process.exit(0);
}

main().catch((err) => {
  const msg: ErrorMessage = {
    type: 'error',
    error: `Runner fatal: ${err instanceof Error ? err.message : String(err)}`,
  };
  writeLine(msg);
  process.exit(1);
});
