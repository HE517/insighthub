/**
 * Startup capability check (`docs/ARCHITECTURE.md` §7.11, `docs/DECISIONS.md` D-051).
 *
 * The rule under test is not "SQLite works here" but **"the server refuses to start, with a
 * clear diagnostic, when it cannot have durable storage"**. A silent memory-only fallback is
 * exactly the M1 data-loss mode this milestone removes, so a lenient check would be worse
 * than no check.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { openDocumentStore } from './open-store.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';
import { isSqliteCapabilityError } from './sqlite-runtime.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-capability-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('startup capability check', () => {
  it('opens a store in a fresh directory and reports WAL', async () => {
    const dataPath = join(root, 'data');
    const opened = await openDocumentStore(dataPath);
    try {
      assert.equal(opened.journalMode, 'wal');
      assert.equal(opened.dataPath, dataPath);
    } finally {
      await opened.store.close();
    }
  });

  it('proves the runtime by executing a statement, not merely by opening a handle', async () => {
    // The trap this guards (`docs/DECISIONS.md` D-041): a corrupt database does not
    // necessarily throw at `new DatabaseSync(...)` — the failure surfaces on the first
    // statement. A check that only constructs a handle would pass on a file it cannot read.
    const dataPath = join(root, 'data');
    const first = await openDocumentStore(dataPath);
    await first.store.close();

    // Corrupt the database file in place, leaving a valid-looking path.
    writeFileSync(join(dataPath, DATABASE_FILE_NAME), Buffer.from('this is definitely not sqlite'));

    await assert.rejects(
      () => openDocumentStore(dataPath),
      (error: unknown) => {
        // The corrupt file is detected before the server can listen, which is the whole point
        // of the check, and it is a typed startup failure rather than a raw SQLite error.
        assert.ok(
          isSqliteCapabilityError(error),
          `expected a capability error, got ${String(error)}`,
        );
        if (!isSqliteCapabilityError(error)) return false;
        // M4 B6: a corrupt file is classified as an *integrity* failure (`PRAGMA quick_check`
        // rejects it), which is the code the entrypoint prints. It is still a refusal to start,
        // never an empty store.
        assert.equal(error.code, 'DATA_INTEGRITY_FAILED');
        return true;
      },
    );

    // The failed open must not leak the file handle: on Windows that would keep the corrupt
    // file locked, turning "refused to start" into "cannot even remove the bad file".
    rmSync(join(dataPath, DATABASE_FILE_NAME), { force: true });
    assert.deepEqual(
      readdirSync(dataPath).filter((name) => name === DATABASE_FILE_NAME),
      [],
      'the database file must be removable after a failed open',
    );
  });

  it('fails with DATA_PATH_UNAVAILABLE when the directory cannot be created', async () => {
    // A file where a directory is needed: `mkdirSync(recursive)` cannot create anything
    // under it, which is the "path is not writable" case without depending on permissions.
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'x');

    await assert.rejects(
      () => openDocumentStore(join(blocked, 'nested')),
      (error: unknown) => {
        assert.ok(
          isSqliteCapabilityError(error),
          `expected a capability error, got ${String(error)}`,
        );
        if (!isSqliteCapabilityError(error)) return false;
        assert.equal(error.code, 'DATA_PATH_UNAVAILABLE');
        // The diagnostic must name the unmet requirement, not just say "failed".
        assert.match(error.message, /directory/i);
        assert.ok(error.hint.length > 0, 'a startup failure must tell the operator what to do');
        return true;
      },
    );
  });

  it('leaves no probe artefacts in the data directory', async () => {
    const dataPath = join(root, 'data');
    const opened = await openDocumentStore(dataPath);
    await opened.store.close();

    // The probe creates a real database to test BLOB round-tripping; leaving one behind
    // would slowly accumulate junk in the operator's data directory.
    const leftovers = readdirSync(dataPath).filter((name) => name.includes('capability-probe'));
    assert.deepEqual(leftovers, [], `probe files must be removed, found: ${leftovers.join(', ')}`);
  });

  it('does not fall back to memory-only storage', async () => {
    // The failure mode being excluded: a broken path quietly producing a working-looking
    // server whose writes vanish. There is no successful return for an unusable path.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'x');

    let openedSuccessfully = false;
    try {
      const opened = await openDocumentStore(join(blocked, 'nested'));
      openedSuccessfully = true;
      await opened.store.close();
    } catch {
      openedSuccessfully = false;
    }
    assert.equal(openedSuccessfully, false, 'an unusable data path must not yield a store');
  });
});
