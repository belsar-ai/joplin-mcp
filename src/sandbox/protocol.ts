/**
 * IPC protocol types for broker ↔ runner communication.
 * Messages are newline-delimited JSON over child stdio.
 */

// ── Broker → Runner ──

export interface ExecuteMessage {
  type: 'execute';
  code: string;
}

export interface RpcResultMessage {
  type: 'rpc_result';
  id: number;
  result: unknown;
}

export interface RpcErrorMessage {
  type: 'rpc_error';
  id: number;
  error: string;
}

export type BrokerMessage = ExecuteMessage | RpcResultMessage | RpcErrorMessage;

// ── Runner → Broker ──

export interface RpcCallMessage {
  type: 'rpc_call';
  id: number;
  method: string;
  args: unknown[];
}

export interface ResultMessage {
  type: 'result';
  value: unknown;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
}

export type RunnerMessage = RpcCallMessage | ResultMessage | ErrorMessage;
