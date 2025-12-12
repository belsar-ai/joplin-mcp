import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScriptExecutor } from './script-executor.js';
import { JoplinApiClient } from '../api/client.js';
import { QuickJSWASMModule, QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

describe('ScriptExecutor', () => {
  let mockQjs: QuickJSWASMModule;
  let mockVm: QuickJSContext;
  let mockClient: JoplinApiClient;

  // Mock implementation of QuickJS
  beforeEach(() => {
    // Basic mocks for handles
    const createMockHandle = (val: unknown) => ({
      dispose: vi.fn(),
      alive: true, // Add alive property for strict checks
      value: val,
    } as unknown as QuickJSHandle);

    mockVm = {
      newFunction: vi.fn((name, fn) => createMockHandle(fn)),
      newObject: vi.fn(() => createMockHandle({})),
      newString: vi.fn((str) => createMockHandle(str)),
      newNumber: vi.fn((num) => createMockHandle(num)),
      newUndefined: vi.fn(() => createMockHandle(undefined)),
      newPromise: vi.fn(() => ({
          handle: createMockHandle('promise'), 
          resolve: createMockHandle('resolve'), 
          reject: createMockHandle('reject')
      })),
      newError: vi.fn((msg) => createMockHandle(msg)), // Mock newError
      setProp: vi.fn(),
      defineProp: vi.fn(),
      callFunction: vi.fn(),
      evalCode: vi.fn(() => ({ // evalCode returns a Result
        value: createMockHandle('result'),
        error: undefined
      })),
      resolvePromise: vi.fn(async () => ({ // resolvePromise returns a Result
        value: createMockHandle('resolved'),
        error: undefined
      })),
      unwrapResult: vi.fn((res) => res.value), // Mock unwrapResult
      dump: vi.fn((handle: unknown) => (handle as { value: unknown }).value),
      dispose: vi.fn(),
      global: createMockHandle('global'),
      json: {
        stringify: vi.fn((val) => createMockHandle(JSON.stringify(val))),
      },
    } as unknown as QuickJSContext;

    mockQjs = {
      newContext: vi.fn(() => mockVm),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      QuickJSError: class QuickJSError extends Error { constructor(v: any) { super(); (this as any).value = v; } },
    } as unknown as QuickJSWASMModule;

    mockClient = {
      notes: {
        searchNotes: vi.fn(async (query: string) => [`Note matching ${query}`]),
      },
    } as unknown as JoplinApiClient;
  });

  // Helper to create executor with mocked QJS
  const createExecutor = () => new ScriptExecutor(mockClient, mockQjs);

  it('should execute basic math and return result', async () => {
    const executor = createExecutor();
    // We mock evalCode/resolvePromise to return the result directly for this test
    // since we aren't running real QuickJS in unit tests.
    // In our implementation, evalCode returns a handle, which we unwrap,
    // then pass to resolvePromise.
    
    // Mock resolvePromise to return 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockVm.resolvePromise as any).mockResolvedValue({
        value: { dispose: vi.fn(), value: 2 },
        error: undefined
    });

    const { result, logs } = await executor.execute('return 1 + 1;');
    expect(result).toBe(2);
    expect(logs).toEqual([]);
    expect(mockVm.dispose).toHaveBeenCalled();
  });

  it('should capture console logs', async () => {
    const executor = createExecutor();
    
    // We need to simulate the console.log callback
    // This is tricky to mock perfectly without real QJS, but we can check if console is defined
    await executor.execute('console.log("foo")');
    
    // Verify console was injected using setProp (global object)
    expect(mockVm.setProp).toHaveBeenCalledWith(
        expect.anything(), 
        'console', 
        expect.anything()
    );
  });

  it('should inject joplin client', async () => {
    const executor = createExecutor();
    await executor.execute('some script');
    
    // Verify joplin object was injected using setProp
    expect(mockVm.setProp).toHaveBeenCalledWith(
        expect.anything(),
        'joplin',
        expect.anything()
    );
  });

  it('should dispose VM on error', async () => {
    const executor = createExecutor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockVm.evalCode as any).mockImplementation(() => {
        throw new Error('Script error');
    });

    await expect(executor.execute('bad code')).rejects.toThrow('Script error');
    expect(mockVm.dispose).toHaveBeenCalled();
  });
});