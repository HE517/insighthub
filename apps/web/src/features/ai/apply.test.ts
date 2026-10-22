import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_TEXT_KEY,
  TRANSACTION_ORIGINS,
  UNDO_TRACKED_ORIGINS,
  type TransactionOrigin,
} from '@insighthub/shared';

import { applySuggestion } from './apply.js';
import { createLocalProvider } from './localProvider.js';
import {
  applyPort,
  createDocument,
  docText,
  insertOp,
  mergeRemote,
  replicaOf,
  replaceOp,
  suggestionWith,
} from './testSupport.js';

/**
 * `applySuggestion` against a **real** `Y.Doc` and a narrow port — no mock of Yjs anywhere.
 *
 * The four things this suite exists to prove:
 *
 * 1. a valid suggestion lands as exactly **one** Yjs transaction stamped `ai`;
 * 2. each stale reason is returned at its own layer, with the text untouched;
 * 3. a local undo takes back the AI edit but never a remote peer's edit (origin isolation);
 * 4. multiple operations are applied in descending index order, so one does not shift another.
 */

const REVISION = 3;

function seeded(text: string): { doc: Y.Doc; text: Y.Text } {
  const doc = createDocument(text);
  return { doc, text: doc.getText(DOCUMENT_TEXT_KEY) };
}

describe('applySuggestion: success', () => {
  it('applies a replace as one transaction with the ai origin', () => {
    const { doc, text } = seeded('The quick brown fox');
    const suggestion = suggestionWith([replaceOp(text, 4, 5, 'slow')], {
      baseRevision: REVISION,
    });

    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => {
      origins.push(transaction.origin);
    });

    const result = applySuggestion(applyPort(doc), suggestion, REVISION);

    expect(result).toEqual({ ok: true, applied: 1 });
    expect(docText(doc)).toBe('The slow brown fox');
    // Exactly one transaction, and it is the frozen AI origin — not `local`, not `remote`.
    expect(origins).toEqual([TRANSACTION_ORIGINS.ai]);
  });

  it('lands an insert at its anchored index', () => {
    const { doc, text } = seeded('alpha\nbeta');
    const suggestion = suggestionWith([insertOp(text, 6, '- [ ] ')], { baseRevision: REVISION });

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 1,
    });
    expect(docText(doc)).toBe('alpha\n- [ ] beta');
  });

  it('uses the resolved anchor, not the stored index/length', () => {
    const { doc, text } = seeded('The quick brown fox');
    const suggestion = suggestionWith([replaceOp(text, 4, 5, 'slow')], {
      baseRevision: REVISION,
    });

    // A peer prepends text before the anchored region. The revision is unchanged for this unit
    // test, so validation reaches the anchor: it must resolve to the shifted range (8..13) and
    // the operation's `index: 4` must be ignored.
    doc.transact(() => {
      text.insert(0, '>> ');
    }, TRANSACTION_ORIGINS.remote);

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 1,
    });
    expect(docText(doc)).toBe('>> The slow brown fox');
  });
});

describe('applySuggestion: stale suggestions are never partially applied', () => {
  it('returns `revision` at check 1 and leaves the text untouched', () => {
    const { doc, text } = seeded('The quick brown fox');
    const suggestion = suggestionWith([replaceOp(text, 4, 5, 'slow')], {
      baseRevision: REVISION,
    });
    const before = docText(doc);

    expect(applySuggestion(applyPort(doc), suggestion, REVISION + 1)).toEqual({
      ok: false,
      reason: 'revision',
    });
    expect(docText(doc)).toBe(before);
  });

  it('returns `anchor-unresolved` when the anchors belong to another replica', () => {
    const source = seeded('The quick brown fox');
    const suggestion = suggestionWith([replaceOp(source.text, 4, 5, 'slow')], {
      baseRevision: REVISION,
    });

    // Same text, different document: the encoded positions name client ids this replica has never
    // seen. This is exactly why a provider's `anchorText` must be the live Y.Text.
    const target = seeded('The quick brown fox');
    const before = docText(target.doc);

    expect(applySuggestion(applyPort(target.doc), suggestion, REVISION)).toEqual({
      ok: false,
      reason: 'anchor-unresolved',
    });
    expect(docText(target.doc)).toBe(before);
  });

  it('returns `text-mismatch` when the anchored range changed', () => {
    const { doc, text } = seeded('The quick brown fox');
    const suggestion = suggestionWith([replaceOp(text, 4, 5, 'slow')], {
      baseRevision: REVISION,
    });

    // A remote peer replaces the anchored word. Yjs keeps the deleted positions resolvable, which
    // is why the exact `expectedText` compare is the guard that catches this.
    doc.transact(() => {
      text.delete(4, 5);
      text.insert(4, 'green');
    }, TRANSACTION_ORIGINS.remote);
    const before = docText(doc);

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: false,
      reason: 'text-mismatch',
    });
    expect(docText(doc)).toBe(before);
  });

  it('returns `malformed` for unusable anchor JSON', () => {
    const { doc } = seeded('abcdef');
    const suggestion = suggestionWith(
      [
        {
          kind: 'replace',
          index: 0,
          length: 1,
          text: 'x',
          anchor: { start: 'not-json', end: 'not-json', expectedText: 'a' },
        },
      ],
      { baseRevision: REVISION },
    );
    const before = docText(doc);

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(docText(doc)).toBe(before);
  });

  it('returns `malformed` for operations with overlapping ranges', () => {
    const { doc, text } = seeded('abcdef');
    const suggestion = suggestionWith([replaceOp(text, 0, 3, 'X'), replaceOp(text, 2, 3, 'Y')], {
      baseRevision: REVISION,
    });
    const before = docText(doc);

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(docText(doc)).toBe(before);
  });

  it('returns `malformed` for an insert exactly where a replace starts', () => {
    const { doc, text } = seeded('abcdef');
    // Applying the insert first moves the replaced range; applying the replace first swallows the
    // insert. There is no unambiguous order, so it must not be applied at all.
    const suggestion = suggestionWith([replaceOp(text, 2, 2, 'XY'), insertOp(text, 2, 'Z')], {
      baseRevision: REVISION,
    });
    const before = docText(doc);

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(docText(doc)).toBe(before);
  });
});

describe('applySuggestion: undo isolation (real Y.UndoManager)', () => {
  it('lets a local undo revert the AI edit while the remote edit survives', () => {
    const { doc, text } = seeded('A');
    const undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set<TransactionOrigin>(UNDO_TRACKED_ORIGINS),
    });

    const suggestion = suggestionWith([insertOp(text, 1, 'I')], { baseRevision: REVISION });
    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 1,
    });
    expect(docText(doc)).toBe('AI');

    // A peer appends text and that update arrives over the wire, stamped `remote`.
    const peer = replicaOf(doc);
    peer.getText(DOCUMENT_TEXT_KEY).insert(2, 'REMOTE');
    mergeRemote(peer, doc);
    expect(docText(doc)).toBe('AIREMOTE');

    // The AI transaction is tracked, so undo takes it back...
    undoManager.undo();
    expect(docText(doc)).toBe('AREMOTE');
    // ...and the remote text is still there. It is not local history, so there is nothing else to
    // undo — a snapshot-style undo would have wiped "REMOTE" here.
    expect(undoManager.undoStack.length).toBe(0);
    undoManager.undo();
    expect(docText(doc)).toBe('AREMOTE');

    // Redo re-applies only the AI edit, again leaving the remote text alone.
    undoManager.redo();
    expect(docText(doc)).toBe('AIREMOTE');

    undoManager.destroy();
  });

  it('does not track a remote-only edit as undoable', () => {
    const { doc, text } = seeded('base');
    const undoManager = new Y.UndoManager(text, {
      trackedOrigins: new Set<TransactionOrigin>(UNDO_TRACKED_ORIGINS),
    });

    const peer = replicaOf(doc);
    peer.getText(DOCUMENT_TEXT_KEY).insert(4, '-remote');
    mergeRemote(peer, doc);

    expect(docText(doc)).toBe('base-remote');
    expect(undoManager.undoStack.length).toBe(0);
    undoManager.undo();
    expect(docText(doc)).toBe('base-remote');

    undoManager.destroy();
  });
});

describe('applySuggestion: multiple operations', () => {
  it('applies two replaces in descending order so indices do not shift each other', () => {
    const { doc, text } = seeded('0123456789');
    const suggestion = suggestionWith([replaceOp(text, 0, 3, 'AB'), replaceOp(text, 6, 2, 'XY')], {
      baseRevision: REVISION,
    });

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 2,
    });
    // Ascending order would target 6..8 after the first edit shortened the text and produce
    // "AB3456XY9"; descending produces the diff the user reviewed.
    expect(docText(doc)).toBe('AB345XY89');
  });

  it('keeps listed order for two inserts at the same index', () => {
    const { doc, text } = seeded('1234');
    const suggestion = suggestionWith([insertOp(text, 2, 'A'), insertOp(text, 2, 'B')], {
      baseRevision: REVISION,
    });

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 2,
    });
    expect(docText(doc)).toBe('12AB34');
  });

  it('applies a provider-generated multi-operation suggestion end to end', () => {
    const { doc, text } = seeded('one  \ntwo  \nthree');
    // Two trailing-space trims; the diff preview is computed from the projected result, so after
    // applying the text must equal the projection exactly.
    const suggestion = suggestionWith([replaceOp(text, 3, 2, ''), replaceOp(text, 9, 2, '')], {
      baseRevision: REVISION,
    });

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 2,
    });
    expect(docText(doc)).toBe('one\ntwo\nthree');
  });

  it('closes the loop: generate with the local provider, then apply', async () => {
    const { doc, text } = seeded('The quick brown fox');
    const provider = createLocalProvider();

    const suggestion = await provider.suggest({
      documentId: 'demo-document',
      instruction: 'uppercase',
      text: docText(doc),
      selection: { from: 4, to: 9 },
      baseRevision: REVISION,
      anchorText: text,
    });

    expect(applySuggestion(applyPort(doc), suggestion, REVISION)).toEqual({
      ok: true,
      applied: 1,
    });
    expect(docText(doc)).toBe('The QUICK brown fox');
  });

  it('refuses a proposal generated for a different document', () => {
    // A7's probe (A5 review, P3-1): an insert at the end of a document anchors at a **type-level**
    // position whose expectedText is '', so it resolves against another document and passes all
    // three text checks. The documentId comparison is what refuses it.
    const { doc } = seeded('completely different ');
    const insertAtEnd = insertOp(doc.getText(DOCUMENT_TEXT_KEY), docText(doc).length, 'FROM-A');
    const suggestion = suggestionWith([insertAtEnd], { documentId: 'document-a' });

    expect(applySuggestion(applyPort(doc, 'document-b'), suggestion, REVISION)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(docText(doc)).toBe('completely different ');
  });
});
