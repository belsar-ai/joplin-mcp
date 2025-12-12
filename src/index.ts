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
import { getQuickJS, QuickJSWASMModule } from 'quickjs-emscripten'; // Corrected Import

// Re-export for backwards compatibility with tests
export { discoverJoplinToken } from './config/token-discovery.js';
export { JoplinApiClient } from './api/client.js';

export class JoplinServer {
  private server: Server;
  private apiClient: JoplinApiClient;
  private scriptExecutor: ScriptExecutor;
  private qjsInstance: QuickJSWASMModule; // Corrected Type

  // Private constructor to enforce static async factory
  private constructor(qjsInstance: QuickJSWASMModule) {
    this.qjsInstance = qjsInstance; // Assign the pre-initialized instance
    this.server = new Server(
      {
        name: 'joplin-server',
        version: getVersion(),
        // Removed unsupported 'description' property
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.apiClient = new JoplinApiClient();
    this.scriptExecutor = new ScriptExecutor(this.apiClient, this.qjsInstance); // Pass qjsInstance
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  // Static async factory method
  static async create(): Promise<JoplinServer> {
    const qjs = await getQuickJS();
    return new JoplinServer(qjs);
  }

  private getToolsDefinitions() {
    return [
      {
        name: 'execute_joplin_script',
        description: `Execute a JavaScript script to interact with the Joplin API.
The script has access to a global 'joplin' object.
You can use top-level 'await'.
Return the result you want to see.

AVAILABLE API (on 'joplin' object):

// NOTEBOOKS
joplin.notebooks.listNotebooks(fields?, orderBy?, orderDir?, limit?)
joplin.notebooks.getNotebook(id)
joplin.notebooks.createNotebook(title, parentId?)
joplin.notebooks.updateNotebook(id, { title, parent_id })
joplin.notebooks.deleteNotebook(id)
joplin.notebooks.getNotebookNotes(notebookId)

// NOTES
joplin.notes.listAllNotes(fields?, includeDeleted?, orderBy?, orderDir?, limit?)
joplin.notes.searchNotes(query) // Returns array of notes
joplin.notes.getNote(id) // Returns full note object with body
joplin.notes.createNote(title, body, notebookId, tags?, isTodo?, ...)
joplin.notes.updateNote(id, { title, body, parent_id, is_todo, ... })
joplin.notes.appendToNote(id, content) // Appends text to end
joplin.notes.prependToNote(id, content) // Prepends text to start
joplin.notes.deleteNote(id)

// TAGS
joplin.tags.listTags()
joplin.tags.getTagNotes(tagId)
joplin.tags.getNotesByTagName(tagName)
joplin.tags.addTagsToNote(noteId, "tag1,tag2")
joplin.tags.removeTagsFromNote(noteId, "tag1,tag2")
joplin.tags.createTag(title)

// RESOURCES (Attachments)
joplin.resources.listAllResources()
joplin.resources.getNoteResources(noteId)
joplin.resources.downloadResourceToFile(resourceId, path)

EXAMPLES:

1. Search and summarize:
const notes = await joplin.notes.searchNotes("project alpha");
const summaries = notes.map(n => n.title);
return summaries;

2. Batch update:
const todos = await joplin.notes.searchNotes("type:todo iscompleted:0");
for (const todo of todos) {
  await joplin.notes.updateNote(todo.id, { todo_due: Date.now() + 86400000 });
}
return "Updated due dates";
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

      if (name === 'execute_joplin_script') {
        const script = args.script as string;
        try {
          const { result, logs } = await this.scriptExecutor.execute(script);

          // Format the result for display
          let textResult = '';
          if (typeof result === 'string') {
            textResult = result;
          } else if (result === undefined) {
            textResult = 'Script executed successfully (no return value).';
          } else {
            textResult = JSON.stringify(result, null, 2);
          }

          let finalContent = textResult;
          if (logs.length > 0) {
              finalContent += `\n\n--- Script Logs ---\n${logs.join('\n')}`;
          }


          return {
            content: [
              {
                type: 'text',
                text: finalContent,
              },
            ],
          };
        } catch (error) {
            const errorObj = error as { logs?: string[], message?: string };
            const errorLogs = errorObj.logs || [];
            const errorOutput = `Script Execution Error: ${error instanceof Error ? error.message : String(error)}`;
            let finalErrorContent = errorOutput;
            if (errorLogs.length > 0) {
                finalErrorContent += `\n\n--- Script Logs ---\n${errorLogs.join('\n')}`;
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: finalErrorContent,
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
      await this.server.close();
      // qjsInstance doesn't have a dispose method, contexts do. 
      // The module itself usually doesn't need explicit disposal in this context unless using a variant that does.
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Joplin MCP server (Script Mode) running on stdio');
  }
}