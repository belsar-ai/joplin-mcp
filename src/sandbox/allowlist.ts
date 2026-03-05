/**
 * Allowlist of API methods that sandboxed scripts may call.
 *
 * Each entry defines:
 *  - A Zod schema that validates the arguments array
 *  - A dispatch function that calls the real API method on JoplinApiClient
 *
 * 20 methods total: 14 note methods + 6 read-only notebook methods.
 * All tag methods and notebook CRUD are intentionally excluded.
 */

import { z } from 'zod';
import type { JoplinApiClient } from '../api/client.js';

// ── Types ──

export interface AllowlistEntry {
  schema: z.ZodType;
  arity: number; // expected tuple length (for padding short args arrays)
  dispatch: (client: JoplinApiClient, args: unknown[]) => Promise<unknown>;
}

// ── Allowlist ──

export const ALLOWLIST: Record<string, AllowlistEntry> = {
  // ── Notes (14 methods) ──

  'notes.listAllNotes': {
    arity: 5,
    schema: z
      .tuple([
        z.string().optional(),
        z.boolean().optional(),
        z.string().optional(),
        z.enum(['ASC', 'DESC']).optional(),
        z.number().int().positive().optional(),
      ])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notes.listAllNotes(
        a[0] as string | undefined,
        a[1] as boolean | undefined,
        a[2] as string | undefined,
        a[3] as 'ASC' | 'DESC' | undefined,
        a[4] as number | undefined,
      ),
  },

  'notes.searchNotes': {
    arity: 2,
    schema: z.tuple([z.string(), z.string().optional()]).rest(z.never()),
    dispatch: (c, a) =>
      c.notes.searchNotes(a[0] as string, a[1] as string | undefined),
  },

  'notes.getNote': {
    arity: 2,
    schema: z.tuple([z.string(), z.string().optional()]).rest(z.never()),
    dispatch: (c, a) =>
      c.notes.getNote(a[0] as string, a[1] as string | undefined),
  },

  'notes.readNote': {
    arity: 1,
    schema: z.tuple([z.string()]).rest(z.never()),
    dispatch: (c, a) => c.notes.readNote(a[0] as string),
  },

  'notes.createNote': {
    arity: 7,
    schema: z
      .tuple([
        z.string(),
        z.string(),
        z.string().optional(),
        z.string().optional(),
        z.number().optional(),
        z.number().optional(),
        z.number().optional(),
      ])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notes.createNote(
        a[0] as string,
        a[1] as string,
        a[2] as string | undefined,
        a[3] as string | undefined,
        a[4] as number | undefined,
        a[5] as number | undefined,
        a[6] as number | undefined,
      ),
  },

  'notes.updateNote': {
    arity: 2,
    schema: z
      .tuple([
        z.string(),
        z
          .object({
            title: z.string().optional(),
            body: z.string().optional(),
            parent_id: z.string().optional(),
            is_todo: z.number().optional(),
            todo_due: z.number().optional(),
            todo_completed: z.number().optional(),
          })
          .strict(),
      ])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notes.updateNote(a[0] as string, a[1] as Record<string, unknown>),
  },

  'notes.appendToNote': {
    arity: 2,
    schema: z.tuple([z.string(), z.string()]).rest(z.never()),
    dispatch: (c, a) => c.notes.appendToNote(a[0] as string, a[1] as string),
  },

  'notes.prependToNote': {
    arity: 2,
    schema: z.tuple([z.string(), z.string()]).rest(z.never()),
    dispatch: (c, a) => c.notes.prependToNote(a[0] as string, a[1] as string),
  },

  'notes.deleteNote': {
    arity: 1,
    schema: z.tuple([z.string()]).rest(z.never()),
    dispatch: (c, a) => c.notes.deleteNote(a[0] as string, false),
  },

  'notes.moveNoteToNotebook': {
    arity: 2,
    schema: z.tuple([z.string(), z.string()]).rest(z.never()),
    dispatch: (c, a) =>
      c.notes.moveNoteToNotebook(a[0] as string, a[1] as string),
  },

  'notes.editNote': {
    arity: 4,
    schema: z
      .tuple([z.string(), z.string(), z.string(), z.boolean().optional()])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notes.editNote(
        a[0] as string,
        a[1] as string,
        a[2] as string,
        a[3] as boolean | undefined,
      ),
  },

  'notes.getNoteLineRange': {
    arity: 3,
    schema: z.tuple([z.string(), z.number(), z.number()]).rest(z.never()),
    dispatch: (c, a) =>
      c.notes.getNoteLineRange(a[0] as string, a[1] as number, a[2] as number),
  },

  'notes.searchInNote': {
    arity: 2,
    schema: z.tuple([z.string(), z.string()]).rest(z.never()),
    dispatch: (c, a) => c.notes.searchInNote(a[0] as string, a[1] as string),
  },

  'notes.getNoteSections': {
    arity: 1,
    schema: z.tuple([z.string()]).rest(z.never()),
    dispatch: (c, a) => c.notes.getNoteSections(a[0] as string),
  },

  // ── Notebooks (6 read-only methods) ──

  'notebooks.listNotebooks': {
    arity: 4,
    schema: z
      .tuple([
        z.string().optional(),
        z.string().optional(),
        z.enum(['ASC', 'DESC']).optional(),
        z.number().int().positive().optional(),
      ])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notebooks.listNotebooks(
        a[0] as string | undefined,
        a[1] as string | undefined,
        a[2] as 'ASC' | 'DESC' | undefined,
        a[3] as number | undefined,
      ),
  },

  'notebooks.getNotebook': {
    arity: 2,
    schema: z.tuple([z.string(), z.string().optional()]).rest(z.never()),
    dispatch: (c, a) =>
      c.notebooks.getNotebook(a[0] as string, a[1] as string | undefined),
  },

  'notebooks.getNotebookNotes': {
    arity: 5,
    schema: z
      .tuple([
        z.string(),
        z.string().optional(),
        z.string().optional(),
        z.enum(['ASC', 'DESC']).optional(),
        z.number().int().positive().optional(),
      ])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notebooks.getNotebookNotes(
        a[0] as string,
        a[1] as string | undefined,
        a[2] as string | undefined,
        a[3] as 'ASC' | 'DESC' | undefined,
        a[4] as number | undefined,
      ),
  },

  'notebooks.getNotebookTree': {
    arity: 2,
    schema: z.tuple([z.string(), z.number().optional()]).rest(z.never()),
    dispatch: (c, a) =>
      c.notebooks.getNotebookTree(a[0] as string, a[1] as number | undefined),
  },

  'notebooks.getAllNotebooksTree': {
    arity: 1,
    schema: z
      .tuple([z.object({ exclude: z.array(z.string()).optional() }).optional()])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notebooks.getAllNotebooksTree(
        a[0] as { exclude?: string[] } | undefined,
      ),
  },

  'notebooks.getScopedTree': {
    arity: 1,
    schema: z
      .tuple([
        z
          .object({
            exclude: z.array(z.string()).optional(),
            depth: z.number().optional(),
          })
          .optional(),
      ])
      .rest(z.never()),
    dispatch: (c, a) =>
      c.notebooks.getScopedTree(
        a[0] as { exclude?: string[]; depth?: number } | undefined,
      ),
  },
};

/**
 * Look up and validate an RPC call against the allowlist.
 * Returns the result on success, throws on disallowed method or invalid args.
 */
export async function dispatchAllowedCall(
  client: JoplinApiClient,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const entry = ALLOWLIST[method];
  if (!entry) {
    throw new Error(`Method not allowed: ${method}`);
  }

  // Pad args to expected arity (Zod tuples require exact length)
  const paddedArgs = [...args];
  while (paddedArgs.length < entry.arity) {
    paddedArgs.push(undefined);
  }

  // Validate args
  const parsed = entry.schema.safeParse(paddedArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid arguments for ${method}: ${issues}`);
  }

  return entry.dispatch(client, parsed.data as unknown[]);
}
