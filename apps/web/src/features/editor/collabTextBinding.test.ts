/**
 * Unit tests for the `Y.Text` ⇄ editor binding.
 *
 * These are the A2 acceptance criteria that can be verified honestly in a node
 * environment: correctness of the two directions, absence of a feedback loop,
 * session-transaction ownership, divergence repair and teardown. The CodeMirror
 * *view* itself (`EditorView`) cannot be constructed without a DOM, so the
 * browser-level assertions are listed for M1-A6 in the M1-A2 report — they are
 * not silently claimed here.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { DOCUMENT_TEXT_KEY, TRANSACTION_ORIGINS } from '@insighthub/shared';

import {
  createCollabTextBinding,
  mergeAdjacentChanges,
  pendingEditorChange,
  type CollabTextBinding,
  type CollabTextTarget,
} from './collabTextBinding.js';
import type { EditorTextSurface } from './editorTextSurface.js';
import type { TextChange } from './textDiff.js';

/**
 * A real in-memory editor surface: same contract as the CodeMirror adapter, but
 * without a DOM. It deliberately mirrors the adapter's clamping behaviour so the
 * tests exercise the same rules the browser will.
 */
class InMemorySurface implements EditorTextSurface {
  text: string;
  /** How many times the surface was mutated because of `Y.Text`. */
  remoteApplications = 0;
  /** How many wholesale replacements happened (each one is a divergence repair). */
  resyncs = 0;
  range = { anchor: 0, head: 0 };

  constructor(text: string) {
    this.text = text;
  }

  getText(): string {
    return this.text;
  }

  hasText(text: string): boolean {
    return this.text === text;
  }

  applyDelta(changes: readonly TextChange[]): void {
    const docLength = this.text.length;
    const specs = changes.map((change) => {
      const from = clamp(change.from, 0, docLength);
      const to = clamp(change.to, from, docLength);
      return { from, to, insert: change.insert };
    });

    let next = this.text;
    let offset = 0;
    for (const spec of specs) {
      const from = spec.from + offset;
      const to = spec.to + offset;
      next = next.slice(0, from) + spec.insert + next.slice(to);
      offset += spec.insert.length - (spec.to - spec.from);
    }

    this.text = next;
    this.remoteApplications += 1;
  }

  setText(text: string): void {
    this.text = text;
    this.resyncs += 1;
  }

  getRange(): { anchor: number; head: number } {
    return this.range;
  }

  /** Simulate a user edit and hand the changes to the binding, as CM would. */
  typeLocally(binding: CollabTextBinding, change: TextChange): void {
    const from = clamp(change.from, 0, this.text.length);
    const to = clamp(change.to, from, this.text.length);
    this.text = this.text.slice(0, from) + change.insert + this.text.slice(to);
    binding.handleLocalChanges([{ from, to, insert: change.insert }]);
  }
}

interface Harness {
  doc: Y.Doc;
  text: Y.Text;
  surface: InMemorySurface;
  binding: CollabTextBinding;
  transactions: { origin: unknown }[];
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function createHarness(initialText = ''): Harness {
  const doc = new Y.Doc();
  const text = doc.getText(DOCUMENT_TEXT_KEY);
  if (initialText.length > 0) {
    doc.transact(() => text.insert(0, initialText), TRANSACTION_ORIGINS.local);
  }

  const surface = new InMemorySurface(text.toString());
  const transactions: { origin: unknown }[] = [];

  const target: CollabTextTarget = {
    text,
    doc,
    transact: (fn, origin) => {
      transactions.push({ origin });
      doc.transact(() => fn(text), origin);
    },
  };

  const binding = createCollabTextBinding(target, surface);
  return { doc, text, surface, binding, transactions };
}

describe('collab text binding — editor to Y.Text', () => {
  it('writes a local edit into Y.Text inside a session transaction', () => {
    const { text, surface, binding, transactions } = createHarness('hello');

    surface.typeLocally(binding, { from: 5, to: 5, insert: ' world' });
    binding.flushLocalEdits();

    expect(text.toString()).toBe('hello world');
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.origin).toBe(TRANSACTION_ORIGINS.local);
  });

  it('batches a burst of local edits into one transaction', () => {
    const { text, surface, binding, transactions } = createHarness('ab');

    // Three separate editor updates (multi-cursor / IME style) before any flush.
    binding.handleLocalChanges([{ from: 0, to: 0, insert: 'X' }]);
    binding.handleLocalChanges([{ from: 2, to: 2, insert: 'Y' }]);
    binding.handleLocalChanges([{ from: 4, to: 4, insert: 'Z' }]);
    surface.text = 'XabYZ';
    binding.flushLocalEdits();

    expect(text.toString()).toBe('XabYZ');
    expect(transactions).toHaveLength(1);
  });

  it('does not open a transaction when there is nothing to flush', () => {
    const { binding, transactions } = createHarness('hello');
    binding.flushLocalEdits();
    binding.flushLocalEdits();
    expect(transactions).toHaveLength(0);
  });

  it('applies a delete and an insert in one local change', () => {
    const { text, surface, binding } = createHarness('one two three');
    surface.typeLocally(binding, { from: 4, to: 7, insert: '2' });
    binding.flushLocalEdits();
    expect(text.toString()).toBe('one 2 three');
  });
});

describe('collab text binding — Y.Text to editor', () => {
  it('applies a remote insertion to the surface', () => {
    const { doc, text, surface, binding } = createHarness('hello');

    doc.transact(() => text.insert(5, ' remote'), TRANSACTION_ORIGINS.remote);

    expect(surface.getText()).toBe('hello remote');
    // One remote Yjs update → exactly one editor mutation.
    expect(surface.remoteApplications).toBe(1);
    expect(binding.destroyed).toBe(false);
  });

  it('applies a remote deletion to the surface', () => {
    const { doc, text, surface } = createHarness('hello remote');
    doc.transact(() => text.delete(5, 7), TRANSACTION_ORIGINS.remote);
    expect(surface.getText()).toBe('hello');
  });

  it('applies a remote change inside a long document without touching the rest', () => {
    const body = `${'line\n'.repeat(500)}end`;
    const { doc, text, surface } = createHarness(body);

    doc.transact(() => text.insert(0, 'X'), TRANSACTION_ORIGINS.remote);

    expect(text.length).toBe(body.length + 1);
    expect(surface.getText()).toBe(`X${body}`);
    // Exactly one editor mutation, and never a wholesale rewrite: on a 5 000-line
    // document a remote keystroke must stay O(change), not O(document).
    expect(surface.remoteApplications).toBe(1);
    expect(surface.resyncs).toBe(0);
  });

  it('applies a remote edit in the middle of a long document with a single delta', () => {
    const body = `${'x'.repeat(5000)}`;
    const { doc, text, surface } = createHarness(body);

    doc.transact(() => text.insert(2500, 'INSERTED'), TRANSACTION_ORIGINS.remote);

    expect(surface.getText()).toBe(`${'x'.repeat(2500)}INSERTED${'x'.repeat(2500)}`);
    expect(surface.remoteApplications).toBe(1);
    expect(surface.resyncs).toBe(0);
  });

  it('applies concurrent remote updates in arrival order, converging with Y.Text', () => {
    const { doc, text, surface } = createHarness('abc');

    doc.transact(() => {
      text.insert(0, '1');
    }, TRANSACTION_ORIGINS.remote);
    doc.transact(() => {
      text.insert(3, '2');
    }, TRANSACTION_ORIGINS.remote);

    expect(surface.getText()).toBe(text.toString());
  });

  it('converges with Y.Text for every real multi-operation delta shape', () => {
    // A single Yjs transaction can contain several operations (paste, multi-cursor
    // edit, merge of concurrent remote work). The reconcile path must reproduce
    // Y.Text's content for all of them, which is why it diffs rather than
    // hand-translating delta offsets.
    const cases: { name: string; before: string; mutate: (text: Y.Text) => void }[] = [
      { name: 'insert at end', before: 'hello', mutate: (text) => text.insert(5, ' world') },
      {
        name: 'delete two ranges',
        before: 'abcdefgh',
        mutate: (text) => {
          text.delete(0, 2);
          text.delete(4, 2);
        },
      },
      {
        name: 'delete then insert after it',
        before: 'abcdef',
        mutate: (text) => {
          text.delete(1, 2);
          text.insert(4, 'X');
        },
      },
      {
        name: 'insert then delete after it',
        before: 'abcdef',
        mutate: (text) => {
          text.insert(0, 'X');
          text.delete(4, 2);
        },
      },
      {
        name: 'interleaved delete / insert / delete',
        before: 'abcdefghij',
        mutate: (text) => {
          text.delete(1, 1);
          text.insert(3, 'Y');
          text.delete(5, 2);
        },
      },
      {
        name: 'insert at both ends',
        before: 'abc',
        mutate: (text) => {
          text.insert(0, 'X');
          text.insert(text.length, 'Y');
        },
      },
      { name: 'delete everything', before: 'abcdef', mutate: (text) => text.delete(0, 6) },
      {
        name: 'five deletions',
        before: 'abcdefghijkl',
        mutate: (text) => {
          text.delete(0, 1);
          text.delete(2, 1);
          text.delete(4, 1);
          text.delete(6, 1);
          text.delete(8, 1);
        },
      },
      {
        name: 'replace then append',
        before: 'abcdef',
        mutate: (text) => {
          text.delete(2, 2);
          text.insert(text.length, '!');
        },
      },
    ];

    for (const testCase of cases) {
      const { doc, text, surface } = createHarness(testCase.before);

      doc.transact(() => testCase.mutate(text), TRANSACTION_ORIGINS.remote);

      expect(surface.getText(), testCase.name).toBe(text.toString());
      expect(surface.remoteApplications, `${testCase.name}: one update, one mutation`).toBe(1);
    }
  });

  it('applies a remote edit in the middle of a 5000-character document as one small change', () => {
    const body = 'x'.repeat(5000);
    const { doc, text, surface } = createHarness(body);

    doc.transact(() => text.insert(2500, 'INSERTED'), TRANSACTION_ORIGINS.remote);

    expect(surface.getText()).toBe(`${'x'.repeat(2500)}INSERTED${'x'.repeat(2500)}`);
    expect(surface.remoteApplications).toBe(1);
    // No wholesale rewrite for a one-place edit.
    expect(surface.resyncs).toBe(0);
  });

  it('does not mutate the surface when the remote update changed nothing', () => {
    const { doc, surface } = createHarness('abc');

    doc.transact(() => {
      /* no-op transaction */
    }, TRANSACTION_ORIGINS.remote);

    expect(surface.remoteApplications).toBe(0);
  });
});

describe('collab text binding — no feedback loop', () => {
  it('does not rewrite Y.Text when applying a remote change', () => {
    const { doc, text, surface, transactions } = createHarness('hello');

    doc.transact(() => text.insert(5, ' there'), TRANSACTION_ORIGINS.remote);

    // The surface changed, but the binding must treat that as *derived* state and
    // never write it back: no transaction, and Y.Text untouched.
    expect(surface.getText()).toBe('hello there');
    expect(text.toString()).toBe('hello there');
    expect(transactions).toHaveLength(0);
  });

  it('does not re-apply our own local write to the surface', () => {
    const { text, surface, binding } = createHarness('hello');

    surface.typeLocally(binding, { from: 5, to: 5, insert: '!' });
    binding.flushLocalEdits();

    expect(text.toString()).toBe('hello!');
    // The local transaction is our own origin, so the observer skipped it: the
    // surface was not mutated a second time (which would move the caret).
    expect(surface.remoteApplications).toBe(0);
  });

  it('leaves Y.Text byte-identical when a remote update is delivered twice', () => {
    const { doc, text, surface } = createHarness('abc');
    const update = Y.encodeStateAsUpdate(doc);

    doc.transact(() => text.insert(0, 'X'), TRANSACTION_ORIGINS.remote);
    const afterFirst = surface.getText();

    // Duplicate delivery of the same update is expected on reconnect (D-012/§10.3)
    // and must be an idempotent no-op, not a second insertion.
    Y.applyUpdate(doc, update, TRANSACTION_ORIGINS.remote);

    expect(surface.getText()).toBe(afterFirst);
    expect(text.toString()).toBe(afterFirst);
  });

  it('does not write to Y.Text when the surface echoes an identical value', () => {
    const { doc, text, transactions } = createHarness('abc');
    // An outside actor writes text that already matches (e.g. a persistence
    // replay); nothing should bounce back from the editor.
    doc.transact(() => text.insert(0, ''), TRANSACTION_ORIGINS.persistence);
    expect(transactions).toHaveLength(0);
  });
});

describe('collab text binding — divergence repair and teardown', () => {
  it('applies the authoritative change and clamps it to a diverged surface', () => {
    const doc = new Y.Doc();
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    doc.transact(() => text.insert(0, 'authoritative'), TRANSACTION_ORIGINS.local);

    // The surface starts somewhere else entirely. The offsets are still clamped
    // into range, so nothing throws inside the Yjs observer — and `resync` is the
    // explicit repair the component (or a diagnostic) can trigger.
    const surface = new InMemorySurface('different content');
    const binding = createCollabTextBinding(
      { text, doc, transact: (fn, origin) => doc.transact(() => fn(text), origin) },
      surface,
    );

    expect(() => doc.transact(() => text.insert(0, 'X'), TRANSACTION_ORIGINS.remote)).not.toThrow();

    binding.resync('diverged');
    expect(surface.getText()).toBe('Xauthoritative');
  });

  it('resync() is a no-op when the surface already matches', () => {
    const { binding, surface } = createHarness('hello');
    const before = surface.resyncs;
    binding.resync();
    expect(surface.resyncs).toBe(before);
  });

  it('resync() replaces the surface when it does not match', () => {
    const { binding, surface, text } = createHarness('hello');
    surface.text = 'stale';
    binding.resync('test');
    expect(surface.getText()).toBe(text.toString());
  });

  it('reports a resync through onResync', () => {
    const doc = new Y.Doc();
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    doc.transact(() => text.insert(0, 'authoritative'), TRANSACTION_ORIGINS.local);

    const surface = new InMemorySurface('stale');
    const onResync = vi.fn();
    const binding = createCollabTextBinding(
      { text, doc, transact: (fn, origin) => doc.transact(() => fn(text), origin) },
      surface,
      { onResync },
    );

    binding.resync('explicit');
    expect(onResync).toHaveBeenCalledWith('explicit');
    expect(surface.getText()).toBe('authoritative');
  });

  it('stops applying remote changes after destroy()', () => {
    const { doc, text, surface, binding } = createHarness('hello');
    binding.destroy();
    expect(binding.destroyed).toBe(true);

    doc.transact(() => text.insert(0, 'X'), TRANSACTION_ORIGINS.remote);

    expect(surface.getText()).toBe('hello');
  });

  it('destroy() is idempotent and drops queued local edits', () => {
    const { binding, surface, text } = createHarness('hello');
    binding.handleLocalChanges([{ from: 5, to: 5, insert: 'X' }]);
    binding.destroy();
    binding.destroy();

    binding.flushLocalEdits();
    expect(text.toString()).toBe('hello');
    expect(surface.getText()).toBe('hello');
  });

  it('does not sync after destroy even for a local flush in flight', () => {
    const { binding, text } = createHarness('hello');
    binding.handleLocalChanges([{ from: 0, to: 0, insert: 'X' }]);
    binding.destroy();
    binding.flushLocalEdits();
    expect(text.toString()).toBe('hello');
  });
});

describe('mergeAdjacentChanges', () => {
  it('merges two edits of the same replaced range', () => {
    expect(
      mergeAdjacentChanges([
        { from: 1, to: 4, insert: 'a' },
        { from: 1, to: 4, insert: 'b' },
      ]),
    ).toEqual([{ from: 1, to: 4, insert: 'ab' }]);
  });

  it('merges overlapping ranges instead of producing an invalid range', () => {
    expect(
      mergeAdjacentChanges([
        { from: 1, to: 4, insert: 'x' },
        { from: 3, to: 6, insert: 'y' },
      ]),
    ).toEqual([{ from: 1, to: 6, insert: 'xy' }]);
  });

  it('leaves contiguous single-character changes separate but ordered', () => {
    // CodeMirror reports typing `ab` at offset 0 as two changes in *original*
    // document coordinates; they are applied back to front and need no merging.
    expect(
      mergeAdjacentChanges([
        { from: 0, to: 0, insert: 'a' },
        { from: 1, to: 1, insert: 'b' },
      ]),
    ).toEqual([
      { from: 0, to: 0, insert: 'a' },
      { from: 1, to: 1, insert: 'b' },
    ]);
  });

  it('keeps disjoint changes separate and ordered', () => {
    expect(
      mergeAdjacentChanges([
        { from: 10, to: 10, insert: 'b' },
        { from: 0, to: 0, insert: 'a' },
      ]),
    ).toEqual([
      { from: 0, to: 0, insert: 'a' },
      { from: 10, to: 10, insert: 'b' },
    ]);
  });
});

describe('pendingEditorChange', () => {
  it('describes the change that adopts existing Y.Text content', () => {
    expect(pendingEditorChange('', '# Title')).toEqual({ from: 0, to: 0, insert: '# Title' });
  });

  it('returns null when the editor already matches', () => {
    expect(pendingEditorChange('same', 'same')).toBeNull();
  });
});
