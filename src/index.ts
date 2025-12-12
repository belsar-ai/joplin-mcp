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

export class JoplinServer {
  private server: Server;
  private apiClient: JoplinApiClient;
  private scriptExecutor: ScriptExecutor;

  constructor() {
    this.server = new Server(
      {
        name: 'joplin-server',
        version: getVersion(),
        description: `MCP server for Joplin note-taking application.
        
This server exposes a single, powerful tool: 'execute_joplin_script'.
This tool allows you to write and execute JavaScript/TypeScript code to interact with the Joplin API directly.
This enables complex workflows, batch processing, and "agentic" behaviors in a single turn.
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
          const result = await this.scriptExecutor.execute(script);

          // Format the result for display
          let textResult = '';
          if (typeof result === 'string') {
            textResult = result;
          } else if (result === undefined) {
            textResult = 'Script executed successfully (no return value).';
          } else {
            textResult = JSON.stringify(result, null, 2);
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
          return {
            content: [
              {
                type: 'text',
                text: `Script Execution Error: ${error instanceof Error ? error.message : String(error)}`,
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
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Joplin MCP server (Script Mode) running on stdio');
  }
}
