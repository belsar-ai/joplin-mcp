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
}
