import { HttpClient } from './http-client.js';
import type { JoplinNotebook, JoplinNote } from '../types/joplin.js';
import { getScopedNotebooks, hasNotebookScope } from '../config.js';

/**
 * Notebook (Folder) operations
 */
export class NotebooksApi extends HttpClient {
  async listNotebooks(
    fields?: string,
    orderBy?: string,
    orderDir?: 'ASC' | 'DESC',
    limit?: number,
  ): Promise<JoplinNotebook[]> {
    const fieldsParam =
      fields ||
      'id,title,parent_id,created_time,updated_time,user_created_time,user_updated_time';
    let endpoint = `/folders?fields=${fieldsParam}`;
    if (orderBy) {
      endpoint += `&order_by=${orderBy}`;
    }
    if (orderDir) {
      endpoint += `&order_dir=${orderDir}`;
    }
    return this.paginatedRequest(endpoint, limit);
  }

  async getNotebook(
    notebookId: string,
    fields?: string,
  ): Promise<JoplinNotebook> {
    const fieldsParam =
      fields ||
      'id,title,parent_id,created_time,updated_time,user_created_time,user_updated_time';
    return this.request(
      'GET',
      `/folders/${notebookId}?fields=${fieldsParam}`,
    ) as Promise<JoplinNotebook>;
  }

  async createNotebook(
    title: string,
    parentId?: string,
  ): Promise<JoplinNotebook> {
    const body: Record<string, unknown> = { title };
    if (parentId) body.parent_id = parentId;
    return this.request('POST', '/folders', body) as Promise<JoplinNotebook>;
  }

  async getNotebookNotes(
    notebookId: string,
    fields?: string,
    orderBy?: string,
    orderDir?: 'ASC' | 'DESC',
    limit?: number,
  ): Promise<JoplinNote[]> {
    const fieldsParam =
      fields ||
      'id,title,body,parent_id,created_time,updated_time,user_created_time,user_updated_time,is_todo,todo_completed';
    let endpoint = `/folders/${notebookId}/notes?fields=${fieldsParam}`;
    if (orderBy) {
      endpoint += `&order_by=${orderBy}`;
    }
    if (orderDir) {
      endpoint += `&order_dir=${orderDir}`;
    }
    return this.paginatedRequest(endpoint, limit);
  }

  async updateNotebook(
    notebookId: string,
    updates: { title?: string; parent_id?: string },
  ): Promise<JoplinNotebook> {
    return this.request(
      'PUT',
      `/folders/${notebookId}`,
      updates,
    ) as Promise<JoplinNotebook>;
  }

  async renameNotebook(
    notebookId: string,
    newTitle: string,
  ): Promise<JoplinNotebook> {
    return this.updateNotebook(notebookId, { title: newTitle });
  }

  async deleteNotebook(notebookId: string): Promise<void> {
    await this.request('DELETE', `/folders/${notebookId}`);
  }

  /**
   * Get a visual tree representation of a notebook and its contents.
   * Returns a formatted string with notebooks (📁) and notes (📝) indented hierarchically.
   * @param depth - How deep to recurse. undefined = full depth, 1 = direct notes only, 2 = notes + one level of subnotebooks, etc.
   */
  async getNotebookTree(notebookId: string, depth?: number): Promise<string> {
    const allNotebooks = await this.listNotebooks('id,title,parent_id');
    const rootNotebook = allNotebooks.find((nb) => nb.id === notebookId);
    if (!rootNotebook) {
      throw new Error(`Notebook not found: ${notebookId}`);
    }

    const buildTree = async (
      nbId: string,
      indent: string,
      currentDepth: number,
    ): Promise<string> => {
      let result = '';
      const notes = await this.getNotebookNotes(nbId, 'title');
      for (const note of notes) {
        result += `${indent}📝 ${note.title}\n`;
      }
      if (depth === undefined || currentDepth < depth) {
        const children = allNotebooks.filter((nb) => nb.parent_id === nbId);
        for (const child of children) {
          result += `${indent}📁 ${child.title}\n`;
          result += await buildTree(child.id, indent + '  ', currentDepth + 1);
        }
      }
      return result;
    };

    return (
      `📁 ${rootNotebook.title}\n` + (await buildTree(notebookId, '  ', 1))
    );
  }

  /**
   * Get a visual tree of all notebooks (without notes).
   * Returns a formatted string showing notebook hierarchy with 📁 icons.
   * Respects scope from joplin-mcp.toml if present.
   * @param options.exclude - Array of notebook titles to exclude (case-insensitive partial match)
   */
  async getAllNotebooksTree(options?: { exclude?: string[] }): Promise<string> {
    const { exclude = [] } = options || {};
    const allNotebooks = await this.listNotebooks('id,title,parent_id');
    const excludeLower = exclude.map((e) => e.toLowerCase());

    // Get scoped notebooks from config if scope exists
    const useScope = hasNotebookScope();
    const scopedNotebooks = useScope ? getScopedNotebooks() : [];

    // Build a set of notebook IDs that are in scope (including their children)
    const inScopeIds = new Set<string>();
    if (useScope) {
      const findNotebookAndChildren = (nb: JoplinNotebook) => {
        inScopeIds.add(nb.id);
        const addChildren = (parentId: string) => {
          for (const child of allNotebooks.filter(
            (n) => n.parent_id === parentId,
          )) {
            inScopeIds.add(child.id);
            addChildren(child.id);
          }
        };
        addChildren(nb.id);
      };

      for (const nb of allNotebooks) {
        if (scopedNotebooks.includes(nb.title.toLowerCase())) {
          findNotebookAndChildren(nb);
        }
      }
    }

    const buildTree = (parentId: string | null, indent: string): string => {
      let result = '';
      const children = allNotebooks.filter((nb) => {
        const matchesParent =
          parentId === null ? !nb.parent_id : nb.parent_id === parentId;
        const excluded = excludeLower.some((ex) =>
          nb.title.toLowerCase().includes(ex),
        );
        const inScope = !useScope || inScopeIds.has(nb.id);
        return matchesParent && !excluded && inScope;
      });
      for (const child of children) {
        result += `${indent}📁 ${child.title}\n`;
        result += buildTree(child.id, indent + '  ');
      }
      return result;
    };

    return buildTree(null, '');
  }

  /**
   * Get a unified tree of all scoped notebooks WITH their notes.
   * Returns a formatted string with notebooks (📁) and notes (📝).
   * Respects scope from joplin-mcp.toml if present; shows all if no scope.
   * @param options.exclude - Array of notebook titles to exclude (case-insensitive partial match)
   * @param options.depth - How deep to recurse. undefined = full depth
   */
  async getScopedTree(options?: {
    exclude?: string[];
    depth?: number;
  }): Promise<string> {
    const { exclude = [], depth } = options || {};
    const allNotebooks = await this.listNotebooks('id,title,parent_id');
    const excludeLower = exclude.map((e) => e.toLowerCase());

    // Get scoped notebooks from config if scope exists
    const useScope = hasNotebookScope();
    const scopedNotebooks = useScope ? getScopedNotebooks() : [];

    // Find root-level notebooks to display (either scoped or all top-level)
    const rootNotebooks = allNotebooks.filter((nb) => {
      const excluded = excludeLower.some((ex) =>
        nb.title.toLowerCase().includes(ex),
      );
      if (excluded) return false;

      if (useScope) {
        // Only include notebooks that match scope (top-level scoped ones)
        return scopedNotebooks.includes(nb.title.toLowerCase());
      } else {
        // No scope - include all top-level notebooks
        return !nb.parent_id;
      }
    });

    const buildTree = async (
      nbId: string,
      indent: string,
      currentDepth: number,
    ): Promise<string> => {
      let result = '';
      const notes = await this.getNotebookNotes(nbId, 'title');
      for (const note of notes) {
        result += `${indent}📝 ${note.title}\n`;
      }
      if (depth === undefined || currentDepth < depth) {
        const children = allNotebooks.filter((nb) => {
          const excluded = excludeLower.some((ex) =>
            nb.title.toLowerCase().includes(ex),
          );
          return nb.parent_id === nbId && !excluded;
        });
        for (const child of children) {
          result += `${indent}📁 ${child.title}\n`;
          result += await buildTree(child.id, indent + '  ', currentDepth + 1);
        }
      }
      return result;
    };

    let result = '';
    for (const nb of rootNotebooks) {
      result += `📁 ${nb.title}\n`;
      result += await buildTree(nb.id, '  ', 1);
    }
    return result;
  }
}
