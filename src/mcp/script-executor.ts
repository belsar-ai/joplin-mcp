import {
  QuickJSHandle,
  QuickJSContext,
  QuickJSWASMModule,
} from 'quickjs-emscripten';
import { JoplinApiClient } from '../api/client.js';

// Default script execution timeout in milliseconds (30 seconds)
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

export class ScriptExecutor {
  private client: JoplinApiClient;
  private qjs: QuickJSWASMModule;
  private scriptTimeoutMs: number;

  constructor(
    client: JoplinApiClient,
    qjsInstance: QuickJSWASMModule,
    scriptTimeoutMs: number = DEFAULT_SCRIPT_TIMEOUT_MS,
  ) {
    this.client = client;
    this.qjs = qjsInstance;
    this.scriptTimeoutMs = scriptTimeoutMs;
  }

  async execute(code: string): Promise<{ result: unknown; logs: string[] }> {
    const vm = this.qjs.newContext();
    const logs: string[] = [];

    // Track all active timers for cleanup
    const activeTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const activeIntervals = new Set<ReturnType<typeof setInterval>>();

    // Set up execution timeout using QuickJS interrupt handler
    const startTime = Date.now();
    const runtime = vm.runtime;
    runtime.setInterruptHandler(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed > this.scriptTimeoutMs) {
        return true; // Interrupt execution
      }
      return false; // Continue execution
    });

    try {
      // 1. Inject custom console functions
      const createConsoleFn = (level: 'log' | 'error' | 'warn') =>
        vm.newFunction(level, (...args: QuickJSHandle[]) => {
          const nativeArgs = args.map((arg) => vm.dump(arg));
          logs.push(
            `[Script ${level.toUpperCase()}] ${nativeArgs.map(String).join(' ')}`,
          );
        });

      const consoleLog = createConsoleFn('log');
      const consoleError = createConsoleFn('error');
      const consoleWarn = createConsoleFn('warn');

      const consoleObj = vm.newObject();
      vm.setProp(consoleObj, 'log', consoleLog);
      vm.setProp(consoleObj, 'error', consoleError);
      vm.setProp(consoleObj, 'warn', consoleWarn);
      vm.setProp(vm.global, 'console', consoleObj);

      consoleLog.dispose();
      consoleError.dispose();
      consoleWarn.dispose();
      consoleObj.dispose();

      // 2. Inject Node.js timers with tracking for cleanup
      const setTimeoutHandle = vm.newFunction(
        'setTimeout',
        (fnHandle: QuickJSHandle, delayHandle: QuickJSHandle) => {
          const delay = vm.dump(delayHandle);
          const timer = setTimeout(() => {
            activeTimeouts.delete(timer);
            try {
              if (fnHandle.alive) {
                vm.callFunction(fnHandle, vm.undefined);
              }
            } catch (err) {
              console.error('[Script Timer Error]', err);
            }
          }, delay);
          activeTimeouts.add(timer);
          return vm.newNumber(timer as unknown as number);
        },
      );
      vm.setProp(vm.global, 'setTimeout', setTimeoutHandle);
      setTimeoutHandle.dispose();

      const clearTimeoutHandle = vm.newFunction(
        'clearTimeout',
        (idHandle: QuickJSHandle) => {
          const id = vm.dump(idHandle);
          clearTimeout(id);
          // Remove from tracking (id might be the numeric representation)
          for (const timer of activeTimeouts) {
            if ((timer as unknown as number) === id) {
              activeTimeouts.delete(timer);
              break;
            }
          }
        },
      );
      vm.setProp(vm.global, 'clearTimeout', clearTimeoutHandle);
      clearTimeoutHandle.dispose();

      const setIntervalHandle = vm.newFunction(
        'setInterval',
        (fnHandle: QuickJSHandle, delayHandle: QuickJSHandle) => {
          const delay = vm.dump(delayHandle);
          const timer = setInterval(() => {
            try {
              if (fnHandle.alive) {
                vm.callFunction(fnHandle, vm.undefined);
              }
            } catch (err) {
              console.error('[Script Timer Error]', err);
            }
          }, delay);
          activeIntervals.add(timer);
          return vm.newNumber(timer as unknown as number);
        },
      );
      vm.setProp(vm.global, 'setInterval', setIntervalHandle);
      setIntervalHandle.dispose();

      const clearIntervalHandle = vm.newFunction(
        'clearInterval',
        (idHandle: QuickJSHandle) => {
          const id = vm.dump(idHandle);
          clearInterval(id);
          // Remove from tracking
          for (const timer of activeIntervals) {
            if ((timer as unknown as number) === id) {
              activeIntervals.delete(timer);
              break;
            }
          }
        },
      );
      vm.setProp(vm.global, 'clearInterval', clearIntervalHandle);
      clearIntervalHandle.dispose();

      // 3. Inject the joplin API client
      const joplinHandle = this.createJoplinApiHandle(vm, logs);
      vm.setProp(vm.global, 'joplin', joplinHandle);
      joplinHandle.dispose();

      // 4. Wrap and execute the user's script
      const wrappedCode = `
        (async () => {
          try {
            return await (async () => {
              ${code}
            })();
          } catch (e) {
            console.error(e);
            throw e;
          }
        })()
      `;

      const scriptResultResult = vm.evalCode(wrappedCode, 'script.js');
      const scriptResultHandle = vm.unwrapResult(scriptResultResult);

      const finalResultResult = await vm.resolvePromise(scriptResultHandle);

      if (finalResultResult.error) {
        const errorHandle = finalResultResult.error;
        const errorVal = vm.dump(errorHandle);
        errorHandle.dispose();
        throw new Error(String(errorVal));
      }

      const successHandle = finalResultResult.value;
      const scriptResult = vm.dump(successHandle); // Use const
      successHandle.dispose();
      scriptResultHandle.dispose();

      return { result: scriptResult, logs };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Check if this was a timeout interruption
      if (Date.now() - startTime > this.scriptTimeoutMs) {
        logs.push(
          `[Script Executor Error] Script execution timed out after ${this.scriptTimeoutMs}ms`,
        );
        const timeoutError = new Error(
          `Script execution timed out after ${this.scriptTimeoutMs}ms`,
        );
        Object.assign(timeoutError, { logs });
        throw timeoutError;
      }
      logs.push(`[Script Executor Error] ${errorMessage}`);
      // Attach logs to the error for the caller to access
      if (error instanceof Error) {
        Object.assign(error, { logs });
      }
      throw error;
    } finally {
      // Clean up all active timers to prevent memory leaks
      for (const timer of activeTimeouts) {
        clearTimeout(timer);
      }
      activeTimeouts.clear();

      for (const timer of activeIntervals) {
        clearInterval(timer);
      }
      activeIntervals.clear();

      // Remove the interrupt handler
      runtime.removeInterruptHandler();

      vm.dispose();
    }
  }

  private createJoplinApiHandle(
    vm: QuickJSContext,
    logs: string[],
    obj: unknown = this.client, // Use unknown
    path: string[] = [],
  ): QuickJSHandle {
    const qjsObj = vm.newObject();

    if (typeof obj !== 'object' || obj === null) {
      return qjsObj; // Should not happen with current recursion logic
    }

    // Cast to Record<string, unknown> for iteration
    const typedObj = obj as Record<string, unknown>;

    for (const key of Object.keys(typedObj)) {
      const value = typedObj[key];
      const currentPath = [...path, key];

      if (typeof value === 'function') {
        const funcHandle = vm.newFunction(
          key,
          (...qjsArgs: QuickJSHandle[]) => {
            const nativeArgs = qjsArgs.map((arg) => vm.dump(arg));
            qjsArgs.forEach((arg) => arg.dispose());

            let context: unknown = this.client;
            for (let i = 0; i < path.length; i++) {
              if (typeof context === 'object' && context !== null) {
                context = (context as Record<string, unknown>)[path[i]];
              } else {
                context = undefined;
              }

              if (context === undefined || context === null) {
                const errorMessage = `Invalid Joplin API context path: ${currentPath.slice(0, i + 1).join('.')}`;
                logs.push(`[Joplin API Bridge Error] ${errorMessage}`);
                return vm.newString(errorMessage);
              }
            }

            const clientMethod = value as (...args: unknown[]) => unknown; // Ensure it's treated as function
            // We don't check typeof clientMethod here because we checked typeof value === 'function' above,
            // and assumed structure hasn't changed. But context[key] might be different if path traversal failed?
            // Actually context[key] should be === value.

            try {
              const methodResult = clientMethod.apply(context, nativeArgs);

              if (methodResult instanceof Promise) {
                const {
                  handle: qjsPromise,
                  resolve: qjsResolve,
                  reject: qjsReject,
                } = vm.newPromise();

                methodResult
                  .then((res: unknown) => {
                    const jsonStr = JSON.stringify(
                      res === undefined ? null : res,
                    );
                    const parseResult = vm.evalCode(`(${jsonStr})`);
                    if (parseResult.error) {
                      const err = parseResult.error;
                      logs.push(
                        `[Joplin API Bridge Serialization Error] ${vm.dump(err)}`,
                      );
                      err.dispose();
                      qjsResolve(vm.undefined);
                    } else {
                      const val = parseResult.value;
                      qjsResolve(val);
                      val.dispose();
                    }
                  })
                  .catch((err: unknown) => {
                    const errorMessage = String(err);
                    logs.push(
                      `[Joplin API Bridge Async Error] ${currentPath.join('.')}: ${errorMessage}`,
                    );
                    const errorHandle = vm.newString(errorMessage);
                    qjsReject(errorHandle);
                    errorHandle.dispose();
                  });

                return qjsPromise;
              } else {
                // Synchronous result
                const jsonStr = JSON.stringify(
                  methodResult === undefined ? null : methodResult,
                );
                const parseResult = vm.evalCode(`(${jsonStr})`);
                if (parseResult.error) {
                  const err = parseResult.error;
                  logs.push(
                    `[Joplin API Bridge Serialization Error] ${vm.dump(err)}`,
                  );
                  err.dispose();
                  return vm.undefined;
                }
                return parseResult.value;
              }
            } catch (e) {
              const errorMessage = String(e);
              logs.push(
                `[Joplin API Bridge Error] ${currentPath.join('.')}: ${errorMessage}`,
              );
              const errorHandle = vm.newError({
                message: errorMessage,
                name: 'Error',
              });
              return vm.throw(errorHandle) as unknown as QuickJSHandle;
            }
          },
        );
        vm.setProp(qjsObj, key, funcHandle);
        funcHandle.dispose();
      } else if (typeof value === 'object' && value !== null) {
        const nestedQjsObj = this.createJoplinApiHandle(
          vm,
          logs,
          value,
          currentPath,
        );
        vm.setProp(qjsObj, key, nestedQjsObj);
        nestedQjsObj.dispose();
      }
    }
    return qjsObj;
  }
}
