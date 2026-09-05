import { describe, it, expect, vi } from 'vitest';
import { Broker } from './broker.js';
import type { JoplinApiClient } from '../api/client.js';

// Mock @anthropic-ai/sandbox-runtime — env-var prefix passes the broker's
// sandbox smoke check without needing bwrap installed (works in CI).
const mockSandboxManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  checkDependencies: vi.fn().mockReturnValue({ errors: [], warnings: [] }),
  wrapWithSandboxArgv: vi.fn(async (cmd: string) => ({
    argv: ['/bin/bash', '-c', `bwrap=1 ${cmd}`],
    env: process.env,
  })),
  cleanupAfterCommand: vi.fn(),
  reset: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: mockSandboxManager,
}));

function makeMockClient(
  overrides: Record<string, unknown> = {},
): JoplinApiClient {
  return {
    notes: {
      readNote: vi.fn().mockResolvedValue('# Hello\nWorld'),
      searchNotes: vi.fn().mockResolvedValue([{ id: '1', title: 'Test' }]),
      getNote: vi
        .fn()
        .mockResolvedValue({ id: '1', title: 'Test', body: 'hello' }),
      listAllNotes: vi.fn().mockResolvedValue([]),
      createNote: vi.fn().mockResolvedValue({ id: '2', title: 'New' }),
      updateNote: vi.fn().mockResolvedValue({ id: '1', title: 'Updated' }),
      appendToNote: vi.fn().mockResolvedValue({ id: '1' }),
      prependToNote: vi.fn().mockResolvedValue({ id: '1' }),
      deleteNote: vi.fn().mockResolvedValue(undefined),
      moveNoteToNotebook: vi.fn().mockResolvedValue({ id: '1' }),
      editNote: vi.fn().mockResolvedValue('Replaced 1 occurrence'),
      getNoteLineRange: vi.fn().mockResolvedValue('Lines 1-5'),
      searchInNote: vi.fn().mockResolvedValue('Found 1 match'),
      getNoteSections: vi.fn().mockResolvedValue('Table of Contents'),
      ...overrides,
    },
    notebooks: {
      listNotebooks: vi.fn().mockResolvedValue([]),
      getNotebook: vi.fn().mockResolvedValue({ id: 'nb1', title: 'Notebook' }),
      getNotebookNotes: vi.fn().mockResolvedValue([]),
      getNotebookTree: vi.fn().mockResolvedValue('tree'),
      getAllNotebooksTree: vi.fn().mockResolvedValue('all trees'),
      getScopedTree: vi.fn().mockResolvedValue('scoped tree'),
    },
  } as unknown as JoplinApiClient;
}

describe('Broker', () => {
  it('should return a simple value', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute('return 1 + 1;');
    expect(result).toBe(2);
  });

  it('should handle RPC call to readNote', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute(
      'return await joplin.notes.readNote("abc");',
    );
    expect(result).toBe('# Hello\nWorld');
    expect(client.notes.readNote).toHaveBeenCalledWith('abc');
  });

  it('should reject disallowed methods', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    await expect(
      broker.execute('return await joplin.tags.listTags();'),
    ).rejects.toThrow('Method not allowed: tags.listTags');
  });

  it('should reject invalid arguments (Zod validation)', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    // readNote expects a string, pass a number
    await expect(
      broker.execute('return await joplin.notes.readNote(123);'),
    ).rejects.toThrow('Invalid arguments');
  });

  it('should reject updateNote with disallowed fields', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    await expect(
      broker.execute(
        'return await joplin.notes.updateNote("abc", { encryption_applied: 1 });',
      ),
    ).rejects.toThrow('Invalid arguments');
  });

  it('should propagate script errors', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    await expect(broker.execute('throw new Error("Boom");')).rejects.toThrow(
      'Boom',
    );
  });

  it('should handle multiple RPC calls in one script', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute(`
      const notes = await joplin.notes.searchNotes("test");
      const note = await joplin.notes.readNote(notes[0].id);
      return note;
    `);
    expect(result).toBe('# Hello\nWorld');
    expect(client.notes.searchNotes).toHaveBeenCalled();
    expect(
      (client.notes.searchNotes as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toBe('test');
    expect(client.notes.readNote).toHaveBeenCalled();
    expect(
      (client.notes.readNote as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toBe('1');
  });

  it('should handle concurrent RPC calls with out-of-order responses', async () => {
    const client = makeMockClient({
      readNote: vi.fn(async (id: string) => {
        if (id === 'first') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return id;
      }),
    });
    const broker = new Broker(client);
    const result = await broker.execute(`
      return await Promise.all([
        joplin.notes.readNote("first"),
        joplin.notes.readNote("second"),
      ]);
    `);
    expect(result).toEqual(['first', 'second']);
  });

  it('should propagate API errors', async () => {
    const client = makeMockClient({
      readNote: vi
        .fn()
        .mockRejectedValue(new Error('Joplin API error (404): not found')),
    });
    const broker = new Broker(client);
    await expect(
      broker.execute('return await joplin.notes.readNote("bad-id");'),
    ).rejects.toThrow('Joplin API error (404): not found');
  });

  it('should handle undefined return', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute('const x = 1;');
    expect(result).toBeUndefined();
  });

  it('should handle string return', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute('return "hello world";');
    expect(result).toBe('hello world');
  });

  it('should handle object return', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute('return { a: 1, b: "two" };');
    expect(result).toEqual({ a: 1, b: 'two' });
  });

  it('should support top-level await', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute(`
      const r = await Promise.resolve(42);
      return r;
    `);
    expect(result).toBe(42);
  });

  it('should call notebook read methods', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    const result = await broker.execute(
      'return await joplin.notebooks.listNotebooks();',
    );
    expect(result).toEqual([]);
    expect(client.notebooks.listNotebooks).toHaveBeenCalled();
  });

  it('should refuse to execute if the runtime returns an unwrapped command', async () => {
    // Simulate srt bug/regression: returns the bare command without sandbox wrapper
    mockSandboxManager.wrapWithSandboxArgv.mockResolvedValueOnce({
      argv: ['/bin/bash', '-c', 'node /path/to/runner.js'],
      env: process.env,
    });
    const client = makeMockClient();
    const broker = new Broker(client);
    await expect(broker.execute('return 1;')).rejects.toThrow(
      'Sandbox wrapper did not produce a sandboxed command',
    );
  });

  describe('Read-Only Mode Constraints', () => {
    it('should allow read-only calls in read-only mode', async () => {
      const client = makeMockClient();
      const broker = new Broker(client);
      const result = await broker.execute(
        'return await joplin.notes.readNote("abc");',
        { readOnly: true },
      );
      expect(result).toBe('# Hello\nWorld');
      expect(client.notes.readNote).toHaveBeenCalledWith('abc');
    });

    it('should block modifying/destructive calls in read-only mode', async () => {
      const client = makeMockClient();
      const broker = new Broker(client);
      await expect(
        broker.execute(
          'return await joplin.notes.createNote("title", "body");',
          { readOnly: true },
        ),
      ).rejects.toThrow(
        'Method not allowed in read-only mode: notes.createNote',
      );
      expect(client.notes.createNote).not.toHaveBeenCalled();
    });
  });

  it('should shutdown cleanly', async () => {
    const client = makeMockClient();
    const broker = new Broker(client);
    await broker.execute('return 1;');
    await broker.shutdown();
  });
});
