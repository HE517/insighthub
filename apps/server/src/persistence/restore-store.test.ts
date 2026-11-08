/**
 * P0-1 store-level acceptance: the single-transaction restore write, the version history and
 * the content revision (`docs/agent-governance/P0-1-CONTRACTS.md` C1/C2/C3; D-090).
 *
 * ## Why the failures are injected through real SQLite triggers
 *
 * T2 needs each of the four writes to fail **inside** the transaction, and a wrapped store
 * cannot do that: `appendRestore` is one method, so a wrapper can only fail the whole call. A
 * `BEFORE INSERT` trigger created from a second connection aborts the real statement at a real
 * point in the real transaction — which is exactly the condition the rollback claim is about.
 * Nothing here is a production test hook.
 *
 * The four failure points are:
 *
 * ```text
 * pre-restore version  → document_version (kind = 'pre-restore')
 * restore update       → document_update
 * restored version     → document_version (kind = 'restored')
 * operation record     → restore_operation
 * ```
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as Y from 'yjs';

import { computeRestoreUpdate } from '../versions/restore.js';
import { isDocumentMetaStore } from './document-meta.js';
import { isDocumentVersionStore } from './document-versions.js';
import { openDocumentStore } from './open-store.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';
import { loadSqliteModule, type SqliteModule } from './sqlite-runtime.js';
import type { AppendRestoreInput, DocumentStore } from './types.js';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-restore-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

function stateOfText(text: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function textOfState(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    if (state.byteLength > 0) Y.applyUpdate(doc, state);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

function docWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return doc;
}

interface OpenStore {
  readonly store: DocumentStore;
  readonly dataPath: string;
}

async function openStore(dataPath: string): Promise<OpenStore> {
  const opened = await openDocumentStore(dataPath);
  return { store: opened.store, dataPath };
}

/**
 * A document that can be restored: one version row captured at `targetText`, and a later body
 * (`currentText`) so the restore is a real change.
 */
async function prepareRestorable(
  store: DocumentStore,
  documentId: string,
  targetText: string,
  currentText: string,
): Promise<{ versionId: string; baseRevision: number; current: Y.Doc }> {
  assert.ok(isDocumentVersionStore(store), 'the SQLite store must serve versions');
  await store.append(documentId, stateOfText(targetText)); // content revision 1
  const version = await store.captureDocumentVersion({
    documentId,
    title: 'history',
    authorId: 'demo-ada',
    state: stateOfText(targetText),
    kind: 'manual',
  });
  await store.append(documentId, stateOfText(currentText)); // content revision 2
  return { versionId: version.id, baseRevision: 2, current: docWithText(currentText) };
}

/** Build the exact input the registry builds. */
function restoreInputFor(input: {
  documentId: string;
  operationId: string;
  versionId: string;
  current: Y.Doc;
  targetText: string;
  baseRevision: number;
  requestHash?: string;
  now?: number;
}): AppendRestoreInput {
  const restore = computeRestoreUpdate(input.current, input.targetText);
  const after = new Y.Doc();
  Y.applyUpdate(after, Y.encodeStateAsUpdate(input.current));
  try {
    if (restore.changed) Y.applyUpdate(after, restore.update);
    return {
      documentId: input.documentId,
      operationId: input.operationId,
      requestHash: input.requestHash ?? `hash:${input.documentId}:${input.operationId}`,
      expectedRevision: input.baseRevision,
      authorId: 'demo-ada',
      title: 'history',
      preRestoreState: Y.encodeStateAsUpdate(input.current),
      restoreUpdate: restore.update,
      restoredState: Y.encodeStateAsUpdate(after),
      now: input.now ?? 1_700_000_000_000,
    };
  } finally {
    after.destroy();
  }
}

async function withRawDb<T>(dataPath: string, body: (db: RawDb) => T): Promise<T> {
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return body(db);
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------- *
 * C2 — version history
 * ---------------------------------------------------------------- */

describe('P0-1 store — version history (C2)', () => {
  it('captures a version row with the current content revision and lists newest first', async () => {
    const dataPath = join(root, 'history');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      await store.append('doc', stateOfText('one'));
      const first = await store.captureDocumentVersion({
        documentId: 'doc',
        title: 'v1',
        authorId: 'demo-ada',
        state: stateOfText('one'),
        kind: 'manual',
      });
      await store.append('doc', stateOfText('two'));
      const second = await store.captureDocumentVersion({
        documentId: 'doc',
        title: 'v2',
        authorId: 'demo-ada',
        state: stateOfText('two'),
        kind: 'auto',
      });

      assert.equal(first.sequence, 1);
      assert.equal(second.sequence, 2);

      const versions = await store.listDocumentVersions('doc');
      assert.deepEqual(
        versions.map((version) => version.title),
        ['v2', 'v1'],
        'newest content revision first',
      );
      assert.equal(versions[0]?.kind, 'auto');
      assert.deepEqual(await store.listDocumentVersions('unknown'), []);
    } finally {
      await store.close();
    }
  });

  it('reads a version only through its own document id', async () => {
    const dataPath = join(root, 'scoped');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      await store.append('doc-a', stateOfText('secret'));
      const version = await store.captureDocumentVersion({
        documentId: 'doc-a',
        title: 'v1',
        authorId: 'demo-ada',
        state: stateOfText('secret'),
        kind: 'manual',
      });
      assert.notEqual(await store.readDocumentVersion('doc-a', version.id), null);
      assert.equal(
        await store.readDocumentVersion('doc-b', version.id),
        null,
        'a version id must never be readable through another document',
      );
    } finally {
      await store.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * C1 — the four-row restore
 * ---------------------------------------------------------------- */

describe('P0-1 store — appendRestore commits exactly four rows (C1)', () => {
  it('writes pre-restore version, update, restored version and operation in one transaction', async () => {
    const dataPath = join(root, 'success');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      const prepared = await prepareRestorable(store, 'doc', 'base', 'base-later');
      try {
        const before = {
          versions: (await store.listDocumentVersions('doc')).length,
          updates: (await store.load('doc'))?.updates.length ?? 0,
        };
        const outcome = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc',
            operationId: 'op-success-0001',
            versionId: prepared.versionId,
            current: prepared.current,
            targetText: 'base',
            baseRevision: prepared.baseRevision,
          }),
        );
        assert.equal(outcome.kind, 'committed');
        if (outcome.kind !== 'committed') return;

        // `sequence` is the restored version's content revision: the body changed.
        assert.equal(outcome.sequence, 3);
        const restored = await store.readDocumentVersion('doc', outcome.versionId);
        assert.equal(restored?.kind, 'restored');
        assert.equal(textOfState(restored?.state ?? new Uint8Array()), 'base');

        const versions = await store.listDocumentVersions('doc');
        assert.deepEqual(
          versions.map((version) => version.kind),
          ['restored', 'pre-restore', 'manual'],
        );
        assert.equal(versions.length, before.versions + 2);
        assert.equal((await store.load('doc'))?.updates.length, before.updates + 1);

        // The pre-restore row is captured before the apply: the pre-restore text.
        const preRestore = versions.find((version) => version.kind === 'pre-restore');
        assert.notEqual(preRestore, undefined);
        if (preRestore === undefined) return;
        const preState = await store.readDocumentVersion('doc', preRestore.id);
        assert.equal(textOfState(preState?.state ?? new Uint8Array()), 'base-later');

        assert.deepEqual(await store.findRestoreOperation('doc', 'op-success-0001'), {
          operationId: 'op-success-0001',
          requestHash: 'hash:doc:op-success-0001',
          versionId: outcome.versionId,
          sequence: outcome.sequence,
        });

        // A replay returns the original result and writes nothing (0 new rows).
        const replay = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc',
            operationId: 'op-success-0001',
            versionId: prepared.versionId,
            current: prepared.current,
            targetText: 'base',
            baseRevision: prepared.baseRevision,
          }),
        );
        assert.deepEqual(replay, {
          kind: 'replayed',
          versionId: outcome.versionId,
          sequence: outcome.sequence,
        });
        assert.equal((await store.listDocumentVersions('doc')).length, before.versions + 2);
        assert.equal((await store.load('doc'))?.updates.length, before.updates + 1);
      } finally {
        prepared.current.destroy();
      }
    } finally {
      await store.close();
    }
  });

  it('returns stale_revision and writes nothing when the content revision moved', async () => {
    const dataPath = join(root, 'stale');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      const prepared = await prepareRestorable(store, 'doc', 'base', 'base-later');
      try {
        const outcome = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc',
            operationId: 'op-stale-0001',
            versionId: prepared.versionId,
            current: prepared.current,
            targetText: 'base',
            baseRevision: 1, // the preview was taken before the second append
          }),
        );
        assert.deepEqual(outcome, { kind: 'stale', currentRevision: 2 });
        assert.equal((await store.listDocumentVersions('doc')).length, 1);
        assert.equal(await store.findRestoreOperation('doc', 'op-stale-0001'), null);
      } finally {
        prepared.current.destroy();
      }
    } finally {
      await store.close();
    }
  });

  it('refuses the same operation id with a different request hash', async () => {
    const dataPath = join(root, 'conflict');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      const prepared = await prepareRestorable(store, 'doc', 'base', 'base-later');
      try {
        const first = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc',
            operationId: 'op-conflict-0001',
            versionId: prepared.versionId,
            current: prepared.current,
            targetText: 'base',
            baseRevision: prepared.baseRevision,
          }),
        );
        assert.equal(first.kind, 'committed');

        const conflicting = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc',
            operationId: 'op-conflict-0001',
            versionId: prepared.versionId,
            current: prepared.current,
            targetText: 'a-different-target',
            baseRevision: prepared.baseRevision,
            requestHash: 'a-different-hash',
          }),
        );
        assert.deepEqual(conflicting, { kind: 'operation_conflict' });
        assert.equal((await store.listDocumentVersions('doc')).length, 3, 'nothing new was written');
      } finally {
        prepared.current.destroy();
      }
    } finally {
      await store.close();
    }
  });

  it('does not advance the content revision when the selected text is already current', async () => {
    const dataPath = join(root, 'no-change');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      await store.append('doc', stateOfText('same'));
      const version = await store.captureDocumentVersion({
        documentId: 'doc',
        title: 'v1',
        authorId: 'demo-ada',
        state: stateOfText('same'),
        kind: 'manual',
      });
      const current = docWithText('same');
      try {
        const outcome = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc',
            operationId: 'op-no-change-1',
            versionId: version.id,
            current,
            targetText: 'same',
            baseRevision: 1,
          }),
        );
        assert.equal(outcome.kind, 'committed');
        if (outcome.kind !== 'committed') return;
        assert.equal(outcome.sequence, 1, 'the body did not change');
        assert.equal(await store.documentContentRevision('doc'), 1);
        assert.equal((await store.listDocumentVersions('doc')).length, 3, 'still four rows');
      } finally {
        current.destroy();
      }
    } finally {
      await store.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * D-RC1 — content revision vs the log position
 * ---------------------------------------------------------------- */

describe('P0-1 store — content revision (D-RC1, T12 store half)', () => {
  it('advances on a body change and not on an empty (join) update', async () => {
    const dataPath = join(root, 'revision');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      assert.ok(isDocumentMetaStore(store));
      // Production order: the join records metadata before the first frame, so the document's
      // revision starts at 0 and every content append advances it.
      await store.ensureDocumentMeta('doc', 'demo-ada');
      await store.append('doc', stateOfText('one'));
      assert.equal(await store.documentContentRevision('doc'), 1);

      // Exactly what a join's SyncStep2 carries: a valid, non-empty update that changes
      // nothing. The log advances; the body does not.
      const emptyDoc = new Y.Doc();
      const emptyUpdate = Y.encodeStateAsUpdate(emptyDoc);
      emptyDoc.destroy();
      assert.ok(emptyUpdate.byteLength > 0, 'the fixture must be the real 1-2 byte update');
      await store.append('doc', emptyUpdate, { contentChanged: false });

      assert.equal(await store.documentContentRevision('doc'), 1);
      const stored = await store.load('doc');
      assert.equal(stored?.updates.length, 2, 'the log position did advance');
      assert.equal(stored?.updates[1]?.sequence, 2);
    } finally {
      await store.close();
    }
  });

  it('keeps the content revision across a reopen', async () => {
    const dataPath = join(root, 'revision-reopen');
    const first = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(first.store));
      assert.ok(isDocumentMetaStore(first.store));
      await first.store.ensureDocumentMeta('doc', 'demo-ada');
      await first.store.append('doc', stateOfText('one'));
    } finally {
      await first.store.close();
    }

    const second = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(second.store));
      assert.equal(await second.store.documentContentRevision('doc'), 1);
    } finally {
      await second.store.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * T2 store half — every write point rolls the transaction back
 * ---------------------------------------------------------------- */

describe('P0-1 store — a failure at any of the four writes rolls everything back (T2)', () => {
  const cases: { name: string; trigger: string }[] = [
    {
      name: 'pre-restore version',
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON document_version
                WHEN NEW.kind = 'pre-restore'
                BEGIN SELECT RAISE(ABORT, 'injected pre-restore failure'); END`,
    },
    {
      name: 'restore update',
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON document_update
                BEGIN SELECT RAISE(ABORT, 'injected update failure'); END`,
    },
    {
      name: 'restored version',
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON document_version
                WHEN NEW.kind = 'restored'
                BEGIN SELECT RAISE(ABORT, 'injected restored failure'); END`,
    },
    {
      name: 'operation record',
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON restore_operation
                BEGIN SELECT RAISE(ABORT, 'injected operation failure'); END`,
    },
  ];

  for (const { name, trigger } of cases) {
    it(`writes zero rows and rejects when the ${name} write fails`, async () => {
      const dataPath = join(root, `rollback-${name.replaceAll(' ', '-')}`);
      const { store } = await openStore(dataPath);
      try {
        assert.ok(isDocumentVersionStore(store));
        const prepared = await prepareRestorable(store, 'doc', 'base', 'base-later');
        try {
          const versionsBefore = (await store.listDocumentVersions('doc')).length;
          const updatesBefore = (await store.load('doc'))?.updates.length ?? 0;

          await withRawDb(dataPath, (db) => db.exec(trigger));

          await assert.rejects(
            store.appendRestore(
              restoreInputFor({
                documentId: 'doc',
                operationId: `op-rollback-${name}`,
                versionId: prepared.versionId,
                current: prepared.current,
                targetText: 'base',
                baseRevision: prepared.baseRevision,
              }),
            ),
            /document store restore failed/,
            'the store must report the failure, not a partial commit',
          );

          // Four rows minus the failing one: none of them may survive.
          assert.equal((await store.listDocumentVersions('doc')).length, versionsBefore);
          assert.equal((await store.load('doc'))?.updates.length, updatesBefore);
          assert.equal(await store.findRestoreOperation('doc', `op-rollback-${name}`), null);
          assert.equal(await store.documentContentRevision('doc'), 2, 'revision unchanged');

          await withRawDb(dataPath, (db) => db.exec('DROP TRIGGER injected_failure'));
        } finally {
          prepared.current.destroy();
        }
      } finally {
        await store.close();
      }
    });
  }

  it('reports the failure as a StoreOperationError with operation "restore"', async () => {
    const dataPath = join(root, 'rollback-shape');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      const prepared = await prepareRestorable(store, 'doc', 'base', 'base-later');
      try {
        await withRawDb(dataPath, (db) =>
          db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON restore_operation
                   BEGIN SELECT RAISE(ABORT, 'injected'); END`),
        );
        await assert.rejects(
          store.appendRestore(
            restoreInputFor({
              documentId: 'doc',
              operationId: 'op-shape-0001',
              versionId: prepared.versionId,
              current: prepared.current,
              targetText: 'base',
              baseRevision: prepared.baseRevision,
            }),
          ),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal((error as { name?: string }).name, 'StoreOperationError');
            assert.equal((error as { operation?: string }).operation, 'restore');
            return true;
          },
        );
      } finally {
        prepared.current.destroy();
      }
    } finally {
      await store.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * T13 store half — operation ids are per document
 * ---------------------------------------------------------------- */

describe('P0-1 store — operation ids never cross documents (T13 store half)', () => {
  it('reuses the same operation id on another document without exposing the first result', async () => {
    const dataPath = join(root, 'cross-doc');
    const { store } = await openStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(store));
      const preparedA = await prepareRestorable(store, 'doc-a', 'alpha', 'alpha-later');
      const preparedB = await prepareRestorable(store, 'doc-b', 'bravo', 'bravo-later');
      try {
        const resultA = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc-a',
            operationId: 'shared-operation-id',
            versionId: preparedA.versionId,
            current: preparedA.current,
            targetText: 'alpha',
            baseRevision: preparedA.baseRevision,
          }),
        );
        assert.equal(resultA.kind, 'committed');

        const resultB = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc-b',
            operationId: 'shared-operation-id',
            versionId: preparedB.versionId,
            current: preparedB.current,
            targetText: 'bravo',
            baseRevision: preparedB.baseRevision,
          }),
        );
        // The key is `(document_id, operation_id)` (C3): B is an independent operation, and
        // must not be answered with A's version id.
        assert.equal(resultB.kind, 'committed');
        if (resultA.kind !== 'committed' || resultB.kind !== 'committed') return;
        assert.notEqual(resultB.versionId, resultA.versionId);

        // A second B request with the same id replays B's result, not A's.
        const replayB = await store.appendRestore(
          restoreInputFor({
            documentId: 'doc-b',
            operationId: 'shared-operation-id',
            versionId: preparedB.versionId,
            current: preparedB.current,
            targetText: 'bravo',
            baseRevision: preparedB.baseRevision,
          }),
        );
        assert.deepEqual(replayB, {
          kind: 'replayed',
          versionId: resultB.versionId,
          sequence: resultB.sequence,
        });

        assert.equal(
          await store.readDocumentVersion('doc-b', resultA.versionId),
          null,
          "A's version id must not be readable through B",
        );
      } finally {
        preparedA.current.destroy();
        preparedB.current.destroy();
      }
    } finally {
      await store.close();
    }
  });
});
