import { describe, it, expect, vi } from 'vitest';
import { ScriptExecutor } from './script-executor.js';
import { JoplinApiClient } from '../api/client.js';

// Mock @anthropic-ai/sandbox-runtime
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    checkDependencies: vi.fn().mockReturnValue({ errors: [], warnings: [] }),
    wrapWithSandbox: vi.fn(async (cmd: string) => cmd),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('ScriptExecutor', () => {
  it('should execute basic math', async () => {
    const mockClient = {
      notes: {},
      notebooks: {},
    } as unknown as JoplinApiClient;
    const executor = new ScriptExecutor(mockClient);

    const result = await executor.execute('return 1 + 1;');
    expect(result).toBe(2);
  });

  it('should have access to joplin context', async () => {
    const mockClient = {
      notes: {
        searchNotes: vi
          .fn()
          .mockResolvedValue([{ id: '1', title: 'Note matching foo' }]),
      },
      notebooks: {},
    } as unknown as JoplinApiClient;

    const executor = new ScriptExecutor(mockClient);

    const script = `
      const notes = await joplin.notes.searchNotes("foo");
      return notes[0].title;
    `;

    const result = await executor.execute(script);
    expect(result).toBe('Note matching foo');
  });

  it('should handle top-level await implicitly', async () => {
    const mockClient = {
      notes: {},
      notebooks: {},
    } as unknown as JoplinApiClient;
    const executor = new ScriptExecutor(mockClient);

    const script = `
      const r = await Promise.resolve("async works");
      return r;
    `;

    const result = await executor.execute(script);
    expect(result).toBe('async works');
  });

  it('should fail gracefully on errors', async () => {
    const mockClient = {
      notes: {},
      notebooks: {},
    } as unknown as JoplinApiClient;
    const executor = new ScriptExecutor(mockClient);

    await expect(executor.execute('throw new Error("Boom")')).rejects.toThrow(
      'Boom',
    );
  });
});
