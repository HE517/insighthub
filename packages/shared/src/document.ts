import { z } from 'zod';

/**
 * Document metadata as exchanged between client and server.
 *
 * M0 note: `revision` is the document version owned by the server. Once Yjs
 * collaboration lands (M1) it will be backed by the Yjs state vector, but the
 * field name and meaning stay stable for the API consumer.
 */
export const documentMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  /** Server-owned monotonic document revision. */
  revision: z.number().int().nonnegative(),
  /** User id of the author/owner. */
  ownerId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type DocumentMeta = z.infer<typeof documentMetaSchema>;

/** Lifecycle of a document in the knowledge base. */
export const DOCUMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;
