# Separate Read-Only and Read-Write Script Execution Paths

This plan details the changes needed to introduce a read-only script execution path, enabling secure operations where note modifications or deletions are disallowed. We'll support both server-wide read-only lock mode via a CLI flag/environment variable, and two distinct MCP tools for dynamic execution path selection by the LLM when in normal mode.

## User Review Required

> [!IMPORTANT]
>
> - By default, both `execute_joplin_script` (read-write) and `execute_joplin_readonly_script` (read-only) will be registered as MCP tools.
> - If `--readonly` flag or `JOPLIN_READONLY` env variable (unless set to a falsy string like `'false'`, `'0'`, `'no'`, `'off'`, or empty) is set, **only** the `execute_joplin_readonly_script` tool will be registered, completely locking down the server.

## Proposed Changes

### Sandboxing & Allowlist

#### [MODIFY] [allowlist.ts](file:///home/belsar/projects/joplin-mcp/src/sandbox/allowlist.ts)

- Add `readOnly: boolean` to `AllowlistEntry` interface.
- Tag each of the 20 allowlist entries as either `readOnly: true` (e.g. search, list, read, get) or `readOnly: false` (create, update, append, prepend, delete, edit, move).
- Update `dispatchAllowedCall` to take `options?: { readOnly?: boolean }` and throw an error if a write/destructive method is invoked when `options.readOnly` is active.

#### [MODIFY] [broker.ts](file:///home/belsar/projects/joplin-mcp/src/sandbox/broker.ts)

- Update `Broker.execute` signature to accept `options?: { readOnly?: boolean }`.
- Pass `{ readOnly: options?.readOnly }` to `dispatchAllowedCall` when receiving `rpc_call` messages from the runner process.

#### [MODIFY] [script-executor.ts](file:///home/belsar/projects/joplin-mcp/src/mcp/script-executor.ts)

- Propagate `options?: { readOnly?: boolean }` from `ScriptExecutor.execute` to the internal `Broker.execute` call.

---

### MCP Server & CLI Configuration

#### [MODIFY] [index.ts](file:///home/belsar/projects/joplin-mcp/src/index.ts)

- Update `JoplinServer` constructor to accept `options?: { readOnly?: boolean }`.
- Store `readOnly` configuration on the class as `private isReadOnly: boolean`.
- Replace the server constructor description (lines 27-32) with:

  ```typescript
  description: `MCP server for Joplin note-taking application.
  
  This server exposes script execution tools to interact with the Joplin API directly, enabling complex workflows, batch processing, and "agentic" behaviors.
  By default, it provides 'execute_joplin_readonly_script' for read-only querying, and 'execute_joplin_script' for modifications.
  If configured in read-only lock mode, only the read-only tool is available.
  `;
  ```

- Split the tool definitions returned by `getToolsDefinitions()`:
  - `execute_joplin_readonly_script`:
    - **Description modifications**: Lists only the 13 read-only methods. Drops the rule `createNote needs notebookId`. Trims the list of "pre-formatted output" methods to: `readNote, getNoteLineRange, searchInNote, getNoteSections, getNotebookTree, getAllNotebooksTree, getScopedTree` (explicitly removing `editNote`).
  - `execute_joplin_script`:
    - **Description modifications**: Keeps the full description listing all 20 methods, indicating that it executes scripts with write/destructive permissions.
- Update `getToolsDefinitions()` to:
  - Return both tool definitions if `this.isReadOnly` is `false`.
  - Return only the `execute_joplin_readonly_script` tool if `this.isReadOnly` is `true`.
- Update `CallToolRequestSchema` handler in `setupToolHandlers()`:
  - If `execute_joplin_readonly_script` is called, invoke `scriptExecutor.execute(script, { readOnly: true })`.
  - If `execute_joplin_script` is called:
    - If `this.isReadOnly` is `true`, throw a permission/validation error immediately.
    - Otherwise, invoke `scriptExecutor.execute(script, { readOnly: false })`.

#### [MODIFY] [cli.ts](file:///home/belsar/projects/joplin-mcp/src/cli.ts)

- Parse process arguments and environment variables securely:
  - `const envVal = process.env.JOPLIN_READONLY?.trim().toLowerCase();`
  - `const hasEnvLock = envVal !== undefined && envVal !== '' && envVal !== 'false' && envVal !== '0' && envVal !== 'no' && envVal !== 'off';`
  - `const isReadOnly = process.argv.includes('--readonly') || hasEnvLock;`
- Pass this boolean as `{ readOnly: isReadOnly }` to the `JoplinServer` constructor.

---

### Documentation

#### [MODIFY] [README.md](file:///home/belsar/projects/joplin-mcp/README.md)

- Update "Architecture" section to document that the server exposes two tools: `execute_joplin_readonly_script` (read-only access) and `execute_joplin_script` (read-write/destructive access) by default.
- Add documentation on configuring read-only lock mode via CLI flag `--readonly` or environment variable `JOPLIN_READONLY=true` (with a note on supported truthy/falsy values).

---

### Testing

#### [MODIFY] [broker.test.ts](file:///home/belsar/projects/joplin-mcp/src/sandbox/broker.test.ts)

- Add test coverage for read-only script execution at the broker/allowlist level:
  - Verify that read-only API calls (e.g. `joplin.notes.readNote`) work fine when running in read-only mode.
  - Verify that modifying API calls (e.g. `joplin.notes.createNote`, `joplin.notes.deleteNote`) throw an error when executing in read-only mode.

#### [MODIFY] [index.test.ts](file:///home/belsar/projects/joplin-mcp/src/index.test.ts)

- Add test coverage for:
  - Server tool registration: Verify that both tools are registered by default, but only the read-only tool is registered when `readOnly: true` is passed to the constructor.
  - E2E routing: Verify calling `execute_joplin_readonly_script` executes the script with read-only constraint, and calling `execute_joplin_script` fails when `isReadOnly` is configured.
  - CLI argument and environment variable parsing logic: Add a unit test verifying correct derivation of the `readOnly` configuration under various argument/env-var conditions (e.g. `JOPLIN_READONLY=no`, `JOPLIN_READONLY=false`, `--readonly`).

## Verification Plan

### Automated Tests

- Run existing and new tests to ensure no regressions:
  ```bash
  npm test
  ```
- Run vitest watch/single-run on broker and index tests:
  ```bash
  npx vitest run src/sandbox/broker.test.ts
  npx vitest run src/index.test.ts
  ```

### Manual Verification

- Verify CLI execution and tool registration.
- Verify read-only restriction blocks write operations.
