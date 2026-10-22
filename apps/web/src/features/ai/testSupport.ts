import * as Y from 'yjs';

import {
  createOperationAnchor,
  DOCUMENT_TEXT_KEY,
  TRANSACTION_ORIGINS,
  type AiEditOperation,
  type AiEditSuggestion,
  type AiInsertOperation,
  type AiReplaceOperation,
  type CollaborativeSession,
  type TransactionOrigin,
} from '@insighthub/shared';

/**
 * Test-only helpers for `features/ai/*.test.ts`.
 *
 * No runtime module imports this file. It exists so every AI test builds suggestions the same
 * way production does — anchors minted by `createOperationAnchor` against a **real** `Y.Doc` —
 * instead of hand-writing anchor JSON. Mocks of Yjs are deliberately absent: the whole point of
 * the apply/undo tests is that they run against the real CRDT.
 */

let nextClientId = 500_000;

/** A fresh real `Y.Doc` with deterministic client ids (so two runs encode identically). */
export function createDocument(initialText = ''): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = nextClientId;
  nextClientId += 1;
  if (initialText !== '') doc.getText(DOCUMENT_TEXT_KEY).insert(0, initialText);
  return doc;
}

/** A second replica of `source`, as another browser client would have it. */
export function replicaOf(source: Y.Doc): Y.Doc {
  const replica = new Y.Doc();
  replica.clientID = nextClientId;
  nextClientId += 1;
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(source), TRANSACTION_ORIGINS.remote);
  return replica;
}

/** Copy the missing part of `from` into `into` with the remote origin (a real wire update). */
export function mergeRemote(from: Y.Doc, into: Y.Doc): void {
  Y.applyUpdate(
    into,
    Y.encodeStateAsUpdate(from, Y.encodeStateVector(into)),
    TRANSACTION_ORIGINS.remote,
  );
}

export function docText(doc: Y.Doc): string {
  return doc.getText(DOCUMENT_TEXT_KEY).toString();
}

export function replaceOp(
  text: Y.Text,
  index: number,
  length: number,
  replacement: string,
): AiReplaceOperation {
  return {
    kind: 'replace',
    index,
    length,
    text: replacement,
    anchor: createOperationAnchor(text, { index, length }),
  };
}

export function insertOp(text: Y.Text, index: number, inserted: string): AiInsertOperation {
  return {
    kind: 'insert',
    index,
    text: inserted,
    anchor: createOperationAnchor(text, { index }),
  };
}

export function suggestionWith(
  operations: AiEditOperation[],
  overrides: Partial<AiEditSuggestion> = {},
): AiEditSuggestion {
  return {
    id: 'sug-test',
    documentId: 'demo-document',
    baseRevision: 1,
    summary: 'test suggestion',
    operations,
    diff: '--- current\n+++ proposed\n',
    status: 'pending',
    createdAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The narrow port `applySuggestion` takes, backed by a real `Y.Doc`.
 *
 * `transact` mirrors what `CollaborativeSession.transact` does (a Yjs transaction stamped with the
 * supplied origin, defaulting to `local`), which is what makes the undo-isolation test meaningful.
 */
export function applyPort(doc: Y.Doc): Pick<CollaborativeSession, 'doc' | 'transact'> {
  return {
    doc,
    transact(fn: (text: Y.Text) => void, origin: TransactionOrigin = TRANSACTION_ORIGINS.local) {
      doc.transact(() => fn(doc.getText(DOCUMENT_TEXT_KEY)), origin);
    },
  };
}
