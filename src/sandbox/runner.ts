#!/usr/bin/env node

/**
 * Sandbox runner — standalone entry point executed in a separate (sandboxed) process.
 *
 * Reads an `execute` message from stdin, builds a `joplin.*.*()` proxy that
 * forwards every call as an RPC request over stdout, executes the user code
 * via the AsyncFunction constructor (supports top-level await), and writes
 * a `result` or `error` message back to stdout.
 *
 * Console output is forwarded to stderr so it doesn't interfere with the
 * JSON protocol on stdout.
 */

import type {
  BrokerMessage,
  RpcCallMessage,
  RpcResultMessage,
  RpcErrorMessage,
  ResultMessage,
  ErrorMessage,
} from './protocol.js';

// ── Helpers ──

function writeLine(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Stdin reader: newline-delimited JSON ──

let stdinBuffer = '';
type LineCallback = (msg: BrokerMessage) => void;
let onMessage: LineCallback | null = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;
  let nl: number;
  while ((nl = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, nl);
    stdinBuffer = stdinBuffer.slice(nl + 1);
    if (line.trim()) {
      const msg = JSON.parse(line) as BrokerMessage;
      if (onMessage) onMessage(msg);
    }
  }
});

function waitForMessage(
  predicate: (msg: BrokerMessage) => boolean,
): Promise<BrokerMessage> {
  return new Promise((resolve) => {
    const prev = onMessage;
    onMessage = (msg) => {
      if (predicate(msg)) {
        onMessage = prev;
        resolve(msg);
      } else if (prev) {
        prev(msg);
      }
    };
  });
}

// ── RPC machinery ──

let nextRpcId = 1;

function makeRpcCall(method: string, args: unknown[]): Promise<unknown> {
  const id = nextRpcId++;
  const msg: RpcCallMessage = { type: 'rpc_call', id, method, args };
  writeLine(msg);

  return waitForMessage(
    (m) =>
      (m.type === 'rpc_result' || m.type === 'rpc_error') &&
      (m as RpcResultMessage | RpcErrorMessage).id === id,
  ).then((m) => {
    if (m.type === 'rpc_error') {
      throw new Error((m as RpcErrorMessage).error);
    }
    return (m as RpcResultMessage).result;
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
  const execMsg = (await waitForMessage(
    (m) => m.type === 'execute',
  )) as BrokerMessage & { type: 'execute'; code: string };

  const joplin = buildJoplinProxy();

  try {
    // AsyncFunction constructor: like Function but the body can use await
     
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;

    const fn = new AsyncFunction('joplin', 'console', execMsg.code);
    const result = await fn(joplin, consoleProxy);

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
