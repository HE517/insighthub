/**
 * Version-restore design experiment (UI-2 closeout, not P0 implementation).
 *
 * It answers the question the roadmap asks: **how does a historical Markdown body become a new
 * Yjs edit**, and what happens to concurrent edits, Undo, offline peers and a failed persistence
 * attempt? It uses only `yjs` — no SQLite, no new table, no production code.
 *
 * Run: node tests/experiments/version-restore.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const Y = require('yjs');

const KEY = 'content';
const ORIGIN = 'restore';

function textOf(doc) {
  return doc.getText(KEY).toString();
}

function sync(from, to) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  Y.applyUpdate(from, Y.encodeStateAsUpdate(to, Y.encodeStateVector(from)));
}

/**
 * Turn a historical string into one Yjs transaction: keep the common prefix/suffix, delete the
 * changed middle, insert the target middle. This is the same "edit, not snapshot" property the
 * design needs; a production restore can reuse a smarter diff, but the CRDT semantics do not
 * change.
 */
function restoreTo(doc, target) {
  const text = doc.getText(KEY);
  const current = text.toString();
  if (current === target) return false;
  let prefix = 0;
  while (prefix < current.length && prefix < target.length && current[prefix] === target[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < target.length - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const remove = current.length - prefix - suffix;
  const insert = target.slice(prefix, target.length - suffix);
  doc.transact(() => {
    if (remove > 0) text.delete(prefix, remove);
    if (insert.length > 0) text.insert(prefix, insert);
  }, ORIGIN);
  return true;
}

const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push({ name, ok, actual, expected });
  if (!ok) throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// 1. A version to restore: v1 -> v2, then restore v1 as a new edit.
const a = new Y.Doc();
a.getText(KEY).insert(0, 'alpha\nbeta\ngamma');
const v1 = textOf(a);
a.getText(KEY).delete(6, 4);
a.getText(KEY).insert(6, 'BETA');
const v2 = textOf(a);
check('the edited version is different', v2 !== v1, true);

const undo = new Y.UndoManager(a.getText(KEY), { trackedOrigins: new Set([ORIGIN]) });
const changed = restoreTo(a, v1);
check('restore is an edit (not a no-op)', changed, true);
check('target text after restore', textOf(a), v1);

// 2. Undo the restore: it returns to v2, because the restore is one tracked transaction.
undo.undo();
check('undo returns the pre-restore text', textOf(a), v2);
undo.redo();
check('redo re-applies the restore', textOf(a), v1);

// 3. Two peers: B edits while A restores; both must converge, and B's concurrent edit survives
//    at its own position (restore is an edit, not a destructive snapshot swap).
const a3 = new Y.Doc();
a3.getText(KEY).insert(0, 'alpha');
const a3v1 = textOf(a3);
a3.getText(KEY).insert(5, 'X');
const a3v2 = textOf(a3);
const b3 = new Y.Doc();
Y.applyUpdate(b3, Y.encodeStateAsUpdate(a3));
b3.getText(KEY).insert(b3.getText(KEY).length, '!'); // B appends while A restores
restoreTo(a3, a3v1);
sync(a3, b3);
check('concurrent append survives', textOf(a3), `${a3v1}!`);
check('peers converge after concurrent restore', textOf(a3), textOf(b3));
void a3v2;

// 4. Offline peer: C misses the restore, edits, reconnects; state-vector exchange converges and
//    the restore + the offline edit are both present exactly once.
const a4 = new Y.Doc();
a4.getText(KEY).insert(0, 'alpha');
const a4v1 = textOf(a4);
a4.getText(KEY).insert(5, 'X');
const c4 = new Y.Doc();
Y.applyUpdate(c4, Y.encodeStateAsUpdate(a4));
restoreTo(a4, a4v1); // A restores v1 while C is "offline"
c4.getText(KEY).insert(0, 'OFFLINE-');
sync(a4, c4);
check('offline edit survives the restore', textOf(c4), `OFFLINE-${a4v1}`);
check('restored peer converges', textOf(a4), textOf(c4));
check('reconnect applied the restore once', textOf(a4).includes(a4v1), true);

// 5. Persistence failure boundary (persist-first design): the restore is computed on a staging
//    replica, the resulting update is appended durably, and only then applied to the live doc.
//    If the append throws, the live document is untouched and the pre-restore text is still the
//    current text; the retry applies the same update exactly once.
const d = new Y.Doc();
d.getText(KEY).insert(0, 'persisted');
const before = textOf(d);
let appendAttempts = 0;

function buildRestoreUpdate(current, target) {
  const staging = new Y.Doc();
  Y.applyUpdate(staging, Y.encodeStateAsUpdate(current));
  restoreTo(staging, target);
  return Y.encodeStateAsUpdate(staging, Y.encodeStateVector(current));
}

const restoreUpdate = buildRestoreUpdate(d, 'restored');
function appendDurably() {
  appendAttempts += 1;
  if (appendAttempts === 1) throw new Error('disk full');
  return true;
}
try {
  appendDurably();
  Y.applyUpdate(d, restoreUpdate);
} catch (error) {
  check('failed append is visible to the caller', String(error.message), 'disk full');
}
check('the live document is untouched after a failed append', textOf(d), before);
check('pre-restore text is still the current text', textOf(d), 'persisted');
appendDurably();
Y.applyUpdate(d, restoreUpdate);
check('retry applies the restore exactly once', textOf(d), 'restored');
check('the durable append was attempted twice (one failure, one success)', appendAttempts, 2);

const failed = results.filter((entry) => !entry.ok);
console.log(JSON.stringify({ checks: results.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
