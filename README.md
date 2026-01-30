# joplin-mcp

Model Context Protocol (MCP) server for the [Joplin](https://joplinapp.org/) note-taking app.

Designed by belsar.ai to be easy to install & enjoyable to use.

## Video

https://www.youtube.com/watch?v=B3qJa7ycqNM&t=6s

## Architecture: Script Mode

This MCP server uses a **Script Execution** architecture. Instead of exposing 30+ restricted tools, it exposes a single, powerful tool: `execute_joplin_script`.

This allows the AI to write and execute secure JavaScript/TypeScript code to interact with your Joplin instance. This enables:

- **Complex Workflows:** "Find all notes tagged 'work' and append a checklist to them" (1 turn vs. 50 turns).
- **Data Processing:** Filter, sort, and aggregate data using standard JS array methods.
- **Efficiency:** Drastically reduces context usage and latency.

## Quick Start

1. Open Joplin & navigate to tools > web clipper > enable web clipper service
2. The Joplin app needs to remain running (minimized is fine)
3. Pick the install command for your platform:

```bash
claude mcp add --transport stdio joplin -- npx -y @belsar-ai/joplin-mcp
```

```bash
codex mcp add joplin -- npx -y @belsar-ai/joplin-mcp
```

```bash
gemini extensions install https://github.com/belsar-ai/joplin-mcp
```

4. That's it. Send a test request like "Find my notes about installing Fedora linux".

## Configuration (Optional)

Create `.mcp-config/joplin-mcp.toml` in your project root to scope which notebooks are visible:

```toml
[defaults]
notebook = "Notes"

[scope]
notebooks = ["Notes", "Software"]
```

- `defaults.notebook`: Where new notes go if you don't specify a notebook
- `scope.notebooks`: Only these notebooks are visible to the AI

The config file is discovered by walking up from the current directory (like `.git`).

## Uninstall

To uninstall:

```bash
claude mcp remove joplin
```

```bash
codex mcp remove joplin
```

```bash
gemini extensions uninstall joplin-mcp
```

## Example Usage

The AI can now handle complex requests in a single shot:

```
Find my notes about installing Arch Linux.
```

```
Look for all notes whose last update time was before 2025. tag those as 'archived'.
```

```
Show me all notes in my Work Projects notebook.
```

```
Make a new note with a Mermaid diagram showing how a bill is passed on Capitol Hill.
```

### Working with Large Notes

The AI can navigate, search, and edit large notes without pulling the entire body into context:

```
Show me the table of contents for my platform docs note.
```

```
Show me section 10.1 of my platform docs note.
```

```
Search my project plan for "deadline".
```

```
Replace "Q3 2025" with "Q4 2025" in my roadmap note.
```

## Available API (Script Context)

The AI has access to a global `joplin` object with the following methods:

### Notes (`joplin.notes`)

- `readNote(id)`: Pretty-printed note with metadata header and body. Preferred for display.
- `getNote(id)`: Raw note object. Prefer `readNote()` for display.
- `searchNotes(query: string)`: Smart search with "any:1" logic.
- `listAllNotes(fields?, ...)`: Get all notes.
- `createNote(title, body, notebookId, ...)`: Create a new note.
- `updateNote(id, updates)`: Update properties or body.
- `appendToNote(id, text)`: Add text to the end.
- `prependToNote(id, text)`: Add text to the beginning.
- `editNote(id, oldString, newString, replaceAll?)`: Server-side string replacement. Fails if not found or ambiguous without `replaceAll`.
- `getNoteLineRange(id, startLine, endLine)`: Read a slice of a note by line number (1-indexed).
- `searchInNote(id, pattern)`: Case-insensitive search within a note. Returns matches with line numbers and context.
- `getNoteSections(id)`: Parse markdown headings into a table of contents with line numbers.
- `deleteNote(id)`: Move to trash.

### Notebooks (`joplin.notebooks`)

- `listNotebooks()`: Get folder structure.
- `getNotebookTree(notebookId, depth?)`: Get formatted tree of a notebook with notes (📁/📝).
- `getAllNotebooksTree({ exclude? })`: Get formatted tree of all notebooks (📁 only).
- `getScopedTree({ exclude?, depth? })`: Get formatted tree of scoped notebooks with notes.
- `createNotebook(title, parentId?)`
- `updateNotebook(id, updates)`
- `deleteNotebook(id)`

### Tags (`joplin.tags`)

- `listTags()`
- `getNotesByTagName(tagName)`: Find notes by tag name.
- `addTagsToNote(noteId, tags)`: e.g., "urgent, work"
- `removeTagsFromNote(noteId, tags)`
- `createTag(title)`

## Troubleshooting

- Verify Joplin desktop app is running
- Confirm Web Clipper is enabled in Joplin settings
- Ensure Joplin is listening on port 41184 (default)
- If auto-discovery fails, set `JOPLIN_TOKEN` in your environment (add to `.bashrc` or shell config)
- Go outside for a nice walk
