#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getVersion } from './version.js';
import { JoplinApiClient } from './api/client.js';
import { ScriptExecutor } from './mcp/script-executor.js';

// Re-export for backwards compatibility with tests
export { discoverJoplinToken } from './config/token-discovery.js';
export { JoplinApiClient } from './api/client.js';

export function determineReadOnly(
  argv: string[],
  env: Record<string, string | undefined>,
): boolean {
  const envVal = env.JOPLIN_READONLY?.trim().toLowerCase();
  const hasEnvLock =
    envVal !== undefined &&
    envVal !== '' &&
    envVal !== 'false' &&
    envVal !== '0' &&
    envVal !== 'no' &&
    envVal !== 'off';
  return argv.includes('--readonly') || hasEnvLock;
}

export class JoplinServer {
  private server: Server;
  private apiClient: JoplinApiClient;
  private scriptExecutor: ScriptExecutor;
  private isReadOnly: boolean;

  constructor(options?: { readOnly?: boolean }) {
    this.isReadOnly = !!options?.readOnly;

    this.server = new Server(
      {
        name: 'joplin-server',
        version: getVersion(),
        description: `MCP server for Joplin note-taking application.
        
This server exposes script execution tools to interact with the Joplin API directly, enabling complex workflows, batch processing, and "agentic" behaviors.
By default, it provides 'execute_joplin_readonly_script' for read-only querying, and 'execute_joplin_script' for modifications.
If configured in read-only lock mode, only the read-only tool is available.
`,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.apiClient = new JoplinApiClient();
    this.scriptExecutor = new ScriptExecutor(this.apiClient);
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private getToolsDefinitions() {
    const tools = [
      {
        name: 'execute_joplin_readonly_script',
        description: `Execute JS with global 'joplin' object in read-only mode. Top-level await. Return the result.
Modifications, deletions, and creations are blocked.

NOTEBOOKS (read-only):
listNotebooks(fields?, orderBy?, orderDir?, limit?)
getNotebook(id)
getNotebookNotes(notebookId, fields?, orderBy?, orderDir?, limit?)
getNotebookTree(notebookId, depth?) — formatted tree
getAllNotebooksTree({ exclude? }) — notebooks only, respects scope
getScopedTree({ exclude?, depth? }) — notebooks + notes, respects scope

NOTES (read-only):
listAllNotes(fields?, includeDeleted?, orderBy?, orderDir?, limit?)
searchNotes(query) — returns note array
readNote(id) — formatted display with metadata + line numbers
getNote(id) — raw object
getNoteLineRange(id, startLine, endLine)
searchInNote(id, pattern)
getNoteSections(id)

Call as joplin.notebooks.X() or joplin.notes.X().

SEARCH: searchNotes("any:1 term1 term2"). Use OR/synonyms, not user's literal phrase. Syntax: "any:1", "tag:X", "notebook:X", "title:X", "updated:month-1", "type:todo", "iscompleted:0", "docker*", "-excluded".

RULES:
- These methods return pre-formatted output: readNote, getNoteLineRange, searchInNote, getNoteSections, getNotebookTree, getAllNotebooksTree, getScopedTree. After calling them, respond only "Done." — do not repeat, summarize, or reformat the output.
`,
        inputSchema: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description: 'The JavaScript code to execute.',
            },
          },
          required: ['script'],
        },
      },
    ];

    if (!this.isReadOnly) {
      tools.push({
        name: 'execute_joplin_script',
        description: `Execute JS with global 'joplin' object with write/destructive permissions. Top-level await. Return the result.
Supports all read-only methods, search syntax, and call patterns defined in 'execute_joplin_readonly_script', plus the following modifying/destructive methods:

NOTES (write/destructive):
createNote(title, body, notebookId?, tags?, isTodo?, todoDue?, todoCompleted?)
updateNote(id, { title?, body?, parent_id?, is_todo?, todo_due?, todo_completed? })
appendToNote(id, content)
prependToNote(id, content)
deleteNote(id)
moveNoteToNotebook(noteId, notebookId)
editNote(id, oldString, newString, replaceAll?)

RULES:
- createNote needs notebookId — call listNotebooks() first.
- editNote returns pre-formatted output: after calling it, respond only "Done." — do not repeat, summarize, or reformat the output.
`,
        inputSchema: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description: 'The JavaScript code to execute.',
            },
          },
          required: ['script'],
        },
      });
    }

    return tools;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.getToolsDefinitions(),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new Error('Missing arguments');
      }

      const isReadOnlyTool = name === 'execute_joplin_readonly_script';
      const isWriteTool = name === 'execute_joplin_script';

      if (isReadOnlyTool || isWriteTool) {
        if (isWriteTool && this.isReadOnly) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: execute_joplin_script is not allowed when server is in read-only mode.',
              },
            ],
            isError: true,
          };
        }

        const script = args.script as string;
        try {
          const result = await this.scriptExecutor.execute(script, {
            readOnly: isReadOnlyTool,
          });

          // Format the result for display
          let textResult = '';
          if (typeof result === 'string') {
            textResult = result;
          } else if (result === undefined) {
            textResult = 'Script executed successfully (no return value).';
          } else if (
            Array.isArray(result) &&
            result.every(
              (item: unknown) =>
                typeof item === 'object' &&
                item !== null &&
                'id' in item &&
                'title' in item,
            )
          ) {
            // Assume it's an array of Joplin-like objects (e.g., notes, notebooks, tags)
            textResult =
              `Found ${result.length} items:\n` +
              (result as Array<{ id: string; title: string }>)
                .map((item) => `- ${item.title} (ID: ${item.id})`)
                .join('\n');
          } else if (
            typeof result === 'object' &&
            result !== null &&
            'id' in result &&
            'title' in result
          ) {
            // Single Joplin-like object (e.g., a note, notebook, or tag)
            const item = result as { id: string; title: string };
            textResult = `Found 1 item: ${item.title} (ID: ${item.id})`;
          } else {
            // Fallback for other complex objects, use compact JSON
            textResult = JSON.stringify(result);
          }

          return {
            content: [
              {
                type: 'text',
                text: textResult,
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          let finalMessage = `Script Execution Error: ${errorMessage}`;

          if (
            errorMessage.includes('ECONNREFUSED') ||
            errorMessage.includes('fetch failed')
          ) {
            finalMessage +=
              '\n\nCould not connect to Joplin. Please check:\n1. Is the Joplin app running?\n2. Is the Web Clipper enabled in settings?';
          }

          return {
            content: [
              {
                type: 'text',
                text: finalMessage,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  private setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.scriptExecutor.shutdown();
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Joplin MCP server (Script Mode) running on stdio');
  }
}
