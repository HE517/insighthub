/**
 * The `New document` click, proved without a browser (`docs/DECISIONS.md` D-084 #6 and #7).
 *
 * What a Node test can prove here:
 *
 * | claim | how |
 * | --- | --- |
 * | one click = one `POST` | the injected `create` is a spy; the run count is the request count |
 * | pending cannot double-submit | two `run()` calls while the first is unresolved; only one `create` |
 * | success refreshes **then** switches | both effects append to one order array |
 * | failure never switches and never refreshes | the same order array stays `['create']` |
 * | a failure is retryable | a second `run()` after a rejection performs a second `create` |
 * | unmount cancels the request | `abort()` aborts the signal handed to `create`; the run is `ignored` |
 *
 * What it **cannot** prove: that the panel actually closes. That is the keyed `DocumentWorkspace`
 * remount (`App.tsx` `key={activeDocumentId}`) and belongs to the real-browser suite; a Node test
 * must not pretend to be that evidence.
 */
import { describe, expect, it, vi } from 'vitest';

import { DocumentCreateError, type CreatedDocument } from './documentCreation.js';
import { createNewDocumentFlow, type NewDocumentFlowDependencies } from './newDocumentFlow.js';

interface Harness {
  readonly deps: NewDocumentFlowDependencies;
  readonly order: string[];
  readonly pending: boolean[];
  readonly failures: unknown[];
  readonly selected: string[];
}

function harness(overrides: Partial<NewDocumentFlowDependencies> = {}): Harness {
  const order: string[] = [];
  const pending: boolean[] = [];
  const failures: unknown[] = [];
  const selected: string[] = [];

  const deps: NewDocumentFlowDependencies = {
    create: vi.fn(async () => {
      order.push('create');
      return { documentId: 'new-document-id', title: 'Untitled document' };
    }),
    refreshDirectory: vi.fn(() => {
      order.push('refresh');
    }),
    selectDocument: vi.fn((documentId: string) => {
      order.push(`select:${documentId}`);
      selected.push(documentId);
    }),
    onPendingChange: vi.fn((value: boolean) => {
      pending.push(value);
    }),
    onFailure: vi.fn((error: unknown) => {
      failures.push(error);
    }),
    ...overrides,
  };

  return { deps, order, pending, failures, selected };
}

describe('createNewDocumentFlow: success', () => {
  it('POSTs once, refreshes the directory, then switches through the select path', async () => {
    const test = harness();
    const flow = createNewDocumentFlow(test.deps);

    await expect(flow.run()).resolves.toBe('created');

    expect(test.order).toEqual(['create', 'refresh', 'select:new-document-id']);
    expect(test.selected).toEqual(['new-document-id']);
    // The button is disabled for exactly the request's lifetime, then usable again.
    expect(test.pending).toEqual([true, false]);
    expect(test.failures).toEqual([]);
  });
});

describe('createNewDocumentFlow: failure', () => {
  it('reports the failure and neither refreshes nor switches the workspace', async () => {
    const failure = new DocumentCreateError('http', 'HTTP 500', 500);
    const test = harness({ create: vi.fn(async () => Promise.reject(failure)) });
    const flow = createNewDocumentFlow(test.deps);

    await expect(flow.run()).resolves.toBe('failed');

    // No refresh (no list change) and no select (the active document stays put) — D-084 #7.
    expect(test.order).toEqual([]);
    expect(test.selected).toEqual([]);
    expect(test.failures).toEqual([failure]);
    expect(test.pending).toEqual([true, false]);
  });

  it('is retryable: a second run after a failure performs a second POST and switches on success', async () => {
    const failure = new DocumentCreateError('unauthorized', 'no session', 401);
    const create = vi
      .fn<(signal: AbortSignal) => Promise<CreatedDocument>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ documentId: 'created-on-retry', title: 'Untitled document' });
    const test = harness({ create });
    const flow = createNewDocumentFlow(test.deps);

    await expect(flow.run()).resolves.toBe('failed');
    expect(test.selected).toEqual([]);

    await expect(flow.run()).resolves.toBe('created');

    expect(create).toHaveBeenCalledTimes(2);
    expect(test.order).toEqual(['refresh', 'select:created-on-retry']);
    expect(test.failures).toEqual([failure]);
  });
});

describe('createNewDocumentFlow: the double-click guard (D-084 #6)', () => {
  it('does not start a second POST while the first is still pending', async () => {
    let release: ((document: CreatedDocument) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<CreatedDocument>((resolve) => {
          release = resolve;
        }),
    );
    const test = harness({ create });
    const flow = createNewDocumentFlow(test.deps);

    const first = flow.run();
    // The second click lands before React has re-rendered the disabled button: the flow's own
    // in-flight guard is the only thing that can stop it.
    const second = flow.run();

    await expect(second).resolves.toBe('ignored');
    expect(create).toHaveBeenCalledTimes(1);

    release?.({ documentId: 'only-document', title: 'Untitled document' });
    await expect(first).resolves.toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    expect(test.order).toEqual(['refresh', 'select:only-document']);
  });
});

describe('createNewDocumentFlow: cancellation (R9)', () => {
  it('aborts the request signal and reports nothing when the directory unmounts', async () => {
    let captured: AbortSignal | undefined;
    const create = vi.fn(
      (signal: AbortSignal) =>
        new Promise<CreatedDocument>((_resolve, reject) => {
          captured = signal;
          signal.addEventListener(
            'abort',
            () => reject(new DocumentCreateError('aborted', 'cancelled')),
            { once: true },
          );
        }),
    );
    const test = harness({ create });
    const flow = createNewDocumentFlow(test.deps);

    const run = flow.run();
    await Promise.resolve();
    expect(captured?.aborted).toBe(false);

    flow.abort();

    await expect(run).resolves.toBe('ignored');
    expect(captured?.aborted).toBe(true);
    // A cancelled request is not a user-visible failure, and it must not switch documents.
    expect(test.failures).toEqual([]);
    expect(test.selected).toEqual([]);
    expect(test.pending).toEqual([true, false]);
  });

  it('abort() after a settled run is a no-op', async () => {
    const test = harness();
    const flow = createNewDocumentFlow(test.deps);

    await flow.run();
    expect(() => flow.abort()).not.toThrow();
    await expect(flow.run()).resolves.toBe('created');
  });
});
