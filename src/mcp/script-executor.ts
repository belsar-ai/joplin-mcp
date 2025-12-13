import vm from 'vm';
import { JoplinApiClient } from '../api/client.js';

export class ScriptExecutor {
  private client: JoplinApiClient;

  constructor(client: JoplinApiClient) {
    this.client = client;
  }

  async execute(code: string): Promise<unknown> {
    // We wrap the user's code in an async IFE (Immediately Invoked Function Expression)
    // to allow top-level await and ensure we can capture the return value.
    const wrappedCode = `
      (async () => {
        ${code}
      })()
    `;

    // Create a secure context
    // We expose:
    // - joplin: The API client
    // - console: For debugging (though strictly we might capture this)
    const contextObj = {
      joplin: this.client,
      console: {
        log: (...args: unknown[]) => console.error('[Script Log]', ...args),
        error: (...args: unknown[]) => console.error('[Script Error]', ...args),
        warn: (...args: unknown[]) => console.error('[Script Warn]', ...args),
      },
      // Timers
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      // Explicitly block dangerous globals to prevent data exfiltration
      fetch: undefined,
      process: undefined,
    };

    const context = vm.createContext(contextObj);

    try {
      // runInNewContext vs runInContext: we created a context, so runInContext.
      // We set a timeout to prevent infinite loops (e.g., 30 seconds).
      const result = await vm.runInContext(wrappedCode, context, {
        timeout: 30000,
        displayErrors: true,
      });

      return result;
    } catch (error) {
      // If the error comes from inside the VM, it might be a weird object.
      // We try to normalize it.
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Script execution failed: ${String(error)}`);
    }
  }
}
