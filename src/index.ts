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

CRITICAL SEARCH STRATEGY:
When users ask "do you have notes about X?", DO NOT search their exact phrase. Instead, use OR logic with synonyms:

Examples:
- User: "linux installation steps" → Query: "any:1 linux install installation setup guide tutorial configure"
- User: "project documentation" → Query: "any:1 project initiative plan documentation docs readme"
- User: "recent work notes" → Query: "tag:work updated:month-1"

Key syntax:
- OR logic: "any:1 term1 term2 term3" (matches any term)
- Wildcards: "docker*" (matches docker, dockerfile, etc.)
- Field filters: "tag:work", "title:meeting", "notebook:Personal"
- Date filters: "updated:month-1", "created:2024"
- Exclude: "-archived"

Advanced filters (less obvious but powerful):
- resource:image/*, resource:application/pdf (specific attachment types)
- iscompleted:0|1 (todo completion status)
- type:note|todo (limit by note vs todo)

NEVER DO THIS:
- ❌ Search the user's literal question ("do you have notes about docker?")—it usually returns nothing. Always translate to broader concepts first.

WHEN TO USE:
- User asks "do you have notes about X?"
- Searching by keywords or concepts

WHEN NOT TO USE:
- For "all notes" → Use list_all_notes
- Specific notebook → Use get_notebook_notes
- Specific tag → Use get_notes_by_tag

WORKFLOW:
1. Construct query with OR logic + synonyms
2. Examine results (IDs and titles)
3. Use get_note for full content
4. If zero results, try broader terms or wildcards

STRATEGIC GUIDANCE:

1. Notebook Selection (Crucial):
   - Joplin has NO default notebook. You MUST provide a 'notebookId' when creating notes.
   - User provided a name? Use 'joplin.notebooks.listNotebooks()' to find the ID first.
   - User didn't specify? Ask them or check 'listNotebooks()' to find a sensible default.

2. Notebook Tree/Layout Requests ("show me the layout/tree/structure of X notebook"):
   - Use getNotebookTree(notebookId) - returns a pre-formatted recursive tree string.
   - Example: const nb = (await joplin.notebooks.listNotebooks()).find(n => n.title === 'Belsar');
             return await joplin.notebooks.getNotebookTree(nb.id);

AVAILABLE API (on 'joplin' object):

// NOTEBOOKS
joplin.notebooks.listNotebooks(fields?, orderBy?, orderDir?, limit?)
joplin.notebooks.getNotebook(id)
joplin.notebooks.createNotebook(title, parentId?)
joplin.notebooks.updateNotebook(id, { title, parent_id })
joplin.notebooks.deleteNotebook(id)
joplin.notebooks.getNotebookNotes(notebookId)
joplin.notebooks.getNotebookTree(notebookId) // Returns formatted tree string (📁/📝)

// NOTES
joplin.notes.listAllNotes(fields?, includeDeleted?, orderBy?, orderDir?, limit?)
joplin.notes.searchNotes(query) // Returns array of notes
joplin.notes.getNote(id) // Returns full note object with body
joplin.notes.createNote(title, body, notebookId?, tags?, isTodo?, todoDue?, todoCompleted?)
joplin.notes.updateNote(id, { title?, body?, parent_id?, is_todo?, todo_due?, todo_completed? })
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
