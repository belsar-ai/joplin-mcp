import { HttpClient } from './http-client.js';
import type { JoplinNote, JoplinTag } from '../types/joplin.js';

/**
 * Note operations
 */
export class NotesApi extends HttpClient {
  // Reference to tags API for cross-domain operations
  private tagsApi?: {
    addTagsToNote: (noteId: string, tagNames: string) => Promise<void>;
  };

  // Reference to notebooks API for scope enforcement
  private notebooksApi?: {
    getInScopeNotebookIds: () => Promise<Set<string> | null>;
  };

  setTagsApi(tagsApi: {
    addTagsToNote: (noteId: string, tagNames: string) => Promise<void>;
  }) {
    this.tagsApi = tagsApi;
  }

  setNotebooksApi(notebooksApi: {
    getInScopeNotebookIds: () => Promise<Set<string> | null>;
  }) {
    this.notebooksApi = notebooksApi;
  }

  private async filterNotesByScope(notes: JoplinNote[]): Promise<JoplinNote[]> {
    if (!this.notebooksApi) return notes;
    const inScopeIds = await this.notebooksApi.getInScopeNotebookIds();
    if (!inScopeIds) return notes;

    return notes.filter((note) => inScopeIds.has(note.parent_id));
  }

  async listAllNotes(
    fields?: string,
    includeDeleted = false,
    orderBy?: string,
    orderDir?: 'ASC' | 'DESC',
    limit?: number,
  ): Promise<JoplinNote[]> {
    const fieldsParam =
      fields ||
      'id,title,body,parent_id,created_time,updated_time,user_created_time,user_updated_time,is_todo,todo_completed';

    let endpoint = `/notes?fields=${fieldsParam}`;
    if (includeDeleted) {
      endpoint += '&include_deleted=1';
    }
    if (orderBy) {
      endpoint += `&order_by=${orderBy}`;
    }
    if (orderDir) {
      endpoint += `&order_dir=${orderDir}`;
    }

    const results = (await this.paginatedRequest(
      endpoint,
      limit,
    )) as JoplinNote[];
    return this.filterNotesByScope(results);
  }

  async searchNotes(query: string, type?: string): Promise<JoplinNote[]> {
    let url = `/search?query=${encodeURIComponent(query)}`;
    if (type) url += `&type=${type}`;
    const results = (await this.paginatedRequest(url)) as JoplinNote[];
    return this.filterNotesByScope(results);
  }

  async getNote(
    noteId: string,
    fields?: string,
  ): Promise<JoplinNote & { tags?: JoplinTag[] }> {
    const fieldsParam =
      fields ||
      'id,title,body,parent_id,created_time,updated_time,user_created_time,user_updated_time,is_todo,todo_completed';

    const wantsTags = fields?.split(',').includes('tags');
    const noteFields = fieldsParam
      .split(',')
      .filter((f) => f !== 'tags')
      .join(',');

    const [note, tags] = (await Promise.all([
      this.request('GET', `/notes/${noteId}?fields=${noteFields}`),
      wantsTags
        ? this.paginatedRequest(`/notes/${noteId}/tags`)
        : Promise.resolve(undefined),
    ])) as [JoplinNote, JoplinTag[] | undefined];

    // Check scope
    if (this.notebooksApi) {
      const inScopeIds = await this.notebooksApi.getInScopeNotebookIds();
      if (inScopeIds && !inScopeIds.has(note.parent_id)) {
        throw new Error(
          `Permission denied: Note ${noteId} belongs to an out-of-scope notebook.`,
        );
      }
    }

    // Combine the results
    return { ...note, ...(tags ? { tags } : {}) };
  }

  async readNote(noteId: string): Promise<string> {
    const note = await this.getNote(
      noteId,
      'id,title,body,parent_id,is_todo,todo_completed,tags',
    );
    const lines = (note.body ?? '').split('\n');
    const totalLines = lines.length;
    const parts: string[] = [];
    parts.push(`Title: ${note.title}`);
    parts.push(`ID: ${note.id}`);
    if (note.is_todo) {
      parts.push(`Todo: ${note.todo_completed ? 'completed' : 'open'}`);
    }
    if (note.tags && note.tags.length > 0) {
      parts.push(`Tags: ${note.tags.map((t) => t.title).join(', ')}`);
    }
    parts.push(`Lines: 1-${totalLines} of ${totalLines}`);
    parts.push('');
    parts.push(note.body ?? '');

    return parts.join('\n');
  }

  async createNote(
    title: string,
    body: string,
    notebookId?: string,
    tags?: string,
    isTodo?: number,
    todoDue?: number,
    todoCompleted?: number,
  ): Promise<JoplinNote> {
    if (notebookId && this.notebooksApi) {
      const inScopeIds = await this.notebooksApi.getInScopeNotebookIds();
      if (inScopeIds && !inScopeIds.has(notebookId)) {
        throw new Error(
          `Permission denied: Target notebook ${notebookId} is out of scope.`,
        );
      }
    }

    const noteData: Record<string, unknown> = { title, body };
    if (notebookId) noteData.parent_id = notebookId;
    if (isTodo !== undefined) noteData.is_todo = isTodo;
    if (todoDue !== undefined) noteData.todo_due = todoDue;
    if (todoCompleted !== undefined) noteData.todo_completed = todoCompleted;

    // Create note first (API doesn't accept tags parameter)
    const note = (await this.request('POST', '/notes', noteData)) as JoplinNote;

    // Then add tags if provided
    if (tags && this.tagsApi) {
      await this.tagsApi.addTagsToNote(note.id, tags);
    }

    return note;
  }

  async updateNote(
    noteId: string,
    updates: Record<string, unknown>,
  ): Promise<JoplinNote> {
    // If moving to a new notebook, check scope
    if (updates.parent_id && this.notebooksApi) {
      const inScopeIds = await this.notebooksApi.getInScopeNotebookIds();
      if (inScopeIds && !inScopeIds.has(updates.parent_id as string)) {
        throw new Error(
          `Permission denied: Target notebook ${updates.parent_id} is out of scope.`,
        );
      }
    }

    // Verify current note is in scope
    await this.getNote(noteId, 'id,parent_id');

    return this.request(
      'PUT',
      `/notes/${noteId}`,
      updates,
    ) as Promise<JoplinNote>;
  }

  async appendToNote(noteId: string, content: string): Promise<JoplinNote> {
    const note = await this.getNote(noteId, 'id,body,parent_id');
    const updatedBody = note.body + '\n\n' + content;
    return this.updateNote(noteId, { body: updatedBody });
  }

  async prependToNote(noteId: string, content: string): Promise<JoplinNote> {
    const note = await this.getNote(noteId, 'id,body,parent_id');
    const updatedBody = content + '\n\n' + note.body;
    return this.updateNote(noteId, { body: updatedBody });
  }

  async deleteNote(noteId: string, permanent = false): Promise<void> {
    // Verify current note is in scope
    await this.getNote(noteId, 'id,parent_id');

    const url = permanent ? `/notes/${noteId}?permanent=1` : `/notes/${noteId}`;
    await this.request('DELETE', url);
  }

  async moveNoteToNotebook(
    noteId: string,
    notebookId: string,
  ): Promise<JoplinNote> {
    return this.updateNote(noteId, { parent_id: notebookId });
  }

  async editNote(
    noteId: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<string> {
    const note = await this.getNote(noteId, 'id,body,parent_id');
    const body = note.body ?? '';

    // Count occurrences
    let count = 0;
    let idx = 0;
    while ((idx = body.indexOf(oldString, idx)) !== -1) {
      count++;
      idx += oldString.length;
    }

    if (count === 0) {
      throw new Error('oldString not found in note');
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `Found ${count} matches for oldString. Pass replaceAll=true to replace all, or provide a more specific string.`,
      );
    }

    // Build new body while tracking replacement positions (char offsets in newBody)
    const replacementOffsets: number[] = [];
    let newBody: string;

    if (replaceAll) {
      const parts = body.split(oldString);
      let offset = 0;
      for (let i = 0; i < parts.length - 1; i++) {
        offset += parts[i].length;
        replacementOffsets.push(offset);
        offset += newString.length;
      }
      newBody = parts.join(newString);
    } else {
      const pos = body.indexOf(oldString);
      replacementOffsets.push(pos);
      newBody = body.replace(oldString, () => newString);
    }

    await this.updateNote(noteId, { body: newBody });

    // Build context: ~3 lines around each tracked replacement site
    const newLines = newBody.split('\n');
    const contextParts: string[] = [];

    for (let r = 0; r < replacementOffsets.length; r++) {
      const lineNumber = newBody
        .substring(0, replacementOffsets[r])
        .split('\n').length;
      const start = Math.max(0, lineNumber - 4); // 3 lines before (0-indexed)
      const end = Math.min(newLines.length, lineNumber + 3); // 3 lines after
      const snippet = newLines.slice(start, end).join('\n');
      contextParts.push(
        count > 1
          ? `--- replacement ${r + 1} (line ${lineNumber}) ---\n${snippet}`
          : `Line ${lineNumber}:\n${snippet}`,
      );
    }

    const header = `Replaced ${count} occurrence${count > 1 ? 's' : ''}:\n`;
    return header + contextParts.join('\n\n');
  }

  async getNoteLineRange(
    noteId: string,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    const note = await this.getNote(noteId, 'id,body,parent_id');
    const lines = (note.body ?? '').split('\n');
    const totalLines = lines.length;

    // Clamp to valid range (1-indexed input)
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));

    // Convert to 0-indexed for slicing
    const slice = lines.slice(clampedStart - 1, clampedEnd);

    return `Lines ${clampedStart}-${clampedEnd} of ${totalLines}:\n${slice.join('\n')}`;
  }

  async searchInNote(noteId: string, pattern: string): Promise<string> {
    const note = await this.getNote(noteId, 'id,body,parent_id');
    const lines = (note.body ?? '').split('\n');
    const lowerPattern = pattern.toLowerCase();

    const matchParts: string[] = [];
    let matchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerPattern)) {
        matchCount++;
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        const context = lines.slice(start, end).join('\n');
        matchParts.push(
          `--- match ${matchCount} (line ${i + 1}) ---\n${context}`,
        );
      }
    }

    if (matchCount === 0) {
      return `No matches found for "${pattern}".`;
    }
    return `Found ${matchCount} match${matchCount > 1 ? 'es' : ''}:\n\n${matchParts.join('\n\n')}`;
  }

  async getNoteSections(noteId: string): Promise<string> {
    const note = await this.getNote(noteId, 'id,body,parent_id');
    const lines = (note.body ?? '').split('\n');
    const sectionLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (match) {
        const indent = '  '.repeat(match[1].length - 1);
        sectionLines.push(`${indent}${match[1]} ${match[2]} (line ${i + 1})`);
      }
    }

    if (sectionLines.length === 0) {
      return 'No headings found.';
    }
    return `Table of Contents:\n${sectionLines.join('\n')}`;
  }
}
