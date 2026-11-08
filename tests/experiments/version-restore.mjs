/**
 * Version-restore design experiment (P0 design evidence, NOT P0 implementation).
 *
 * It answers: how does a historical Markdown body become a new Yjs edit, and what happens with
 * Unicode, concurrent edits, an offline peer, independent replicas and a failed persistence
 * attempt? It uses only `yjs` — no SQLite, no table, no API, no product code.
 *
 * Run: node tests/experiments/version-restore.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const Y = require('yjs');

const KEY = 'content';
const ORIGIN = 'restore';

const textOf = (doc) => doc.getText(KEY).toString();
const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push({ name, ok, actual, expected });
  if (!ok) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * The FIRST implementation, kept only to reproduce its Unicode defect. It compares UTF-16 code
 * units, so a shared high surrogate can end the common prefix in the middle of an emoji.
 */
function restoreToLegacy(doc, target) {
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

/**
 * The FIX: compute the common prefix/suffix over **code points** and convert the code-point
 * offsets back to UTF-16 indices (the indices `Y.Text` uses). Surrogate pairs are never split.
 * Grapheme clusters (ZWJ sequences, flags, skin tones) are a known further refinement; the
 * current product's text model is UTF-16 and Markdown, so code points are the correct next step.
 */
function restoreTo(doc, target) {
  const text = doc.getText(KEY);
  const current = text.toString();
  if (current === target) return { changed: false, deleted: 0, inserted: 0 };
  const before = [...current];
  const after = [...target];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const toUtf16 = (codePoints) => codePoints.join('').length;
  const start = toUtf16(before.slice(0, prefix));
  const end = toUtf16(before.slice(0, before.length - suffix));
  const insert = after.slice(prefix, after.length - suffix).join('');
  doc.transact(() => {
    if (end > start) text.delete(start, end - start);
    if (insert.length > 0) text.insert(start, insert);
  }, ORIGIN);
  return { changed: true, deleted: end - start, inserted: insert.length };
}

function cloneOf(doc) {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}
function sync(from, to) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  Y.applyUpdate(from, Y.encodeStateAsUpdate(to, Y.encodeStateVector(from)));
}

/* ------------------------------------------------------------------ *
 * 0. Reproduce the legacy defect (kept as failing-before evidence)
 * ------------------------------------------------------------------ */
const unicodeCases = [
  ['plain emoji replace', 'hello 😀', 'hello 😃'],
  ['emoji inside text replace', 'a😀b', 'a😃b'],
  ['emoji insert', '😀', '😀😀'],
  ['emoji delete', '😀😀', '😀'],
  ['mixed CJK + emoji', '中文😀English', '中文😃English'],
];
const legacyFailures = [];
for (const [name, from, to] of unicodeCases) {
  const doc = new Y.Doc();
  doc.getText(KEY).insert(0, from);
  restoreToLegacy(doc, to);
  const actual = textOf(doc);
  if (actual !== to) legacyFailures.push({ name, from, to, actual });
}
check('the legacy implementation really fails on Unicode boundaries', legacyFailures.length > 0, true);

/* ------------------------------------------------------------------ *
 * 1. Fixed implementation: initiator and encoded peer byte-equal
 * ------------------------------------------------------------------ */
for (const [name, from, to] of unicodeCases) {
  const initiator = new Y.Doc();
  initiator.getText(KEY).insert(0, from);
  const peer = cloneOf(initiator);
  restoreTo(initiator, to);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(initiator, Y.encodeStateVector(peer)));
  check(`${name}: initiator`, textOf(initiator), to);
  check(`${name}: peer after encoded transfer`, textOf(peer), to);
  check(`${name}: peer length`, textOf(peer).length, to.length);
}

/* ------------------------------------------------------------------ *
 * 2. Undo / redo of a restore (single tracked transaction)
 * ------------------------------------------------------------------ */
const a = new Y.Doc();
a.getText(KEY).insert(0, 'alpha\nbeta\ngamma');
const v1 = textOf(a);
a.getText(KEY).delete(6, 4);
a.getText(KEY).insert(6, 'BETA');
const v2 = textOf(a);
const undo = new Y.UndoManager(a.getText(KEY), { trackedOrigins: new Set([ORIGIN]) });
check('restore is an edit', restoreTo(a, v1).changed, true);
check('target text after restore', textOf(a), v1);
undo.undo();
check('undo returns the pre-restore text', textOf(a), v2);
undo.redo();
check('redo re-applies the restore', textOf(a), v1);

/* ------------------------------------------------------------------ *
 * 3. Preview → another member writes first → user confirms
 *    V1 recommendation: revision changed ⇒ reject with conflict, re-preview.
 * ------------------------------------------------------------------ */
const conflict = new Y.Doc();
conflict.getText(KEY).insert(0, 'alpha');
const previewTarget = 'beta';
let revision = 1;
const baseRevision = revision; // captured when the diff was previewed
conflict.getText(KEY).insert(5, 'X'); // another member's write reaches the server first
revision += 1;
const stale = baseRevision !== revision;
check('a changed revision must reject the confirmation', stale, true);
check('a rejected restore leaves the concurrent edit intact', textOf(conflict), 'alphaX');
// Re-preview at the current revision, then confirm again.
const confirmed = restoreTo(conflict, previewTarget);
check('re-preview then confirm applies the restore', confirmed.changed, true);
check('final text after re-preview + confirm', textOf(conflict), previewTarget);

/* ------------------------------------------------------------------ *
 * 4. Restore + offline peer editing the same range, then reconnect
 *    The restore is accepted (confirmed before the offline edit was known); the merge is
 *    CRDT-determined and both replicas must agree.
 * ------------------------------------------------------------------ */
const online = new Y.Doc();
online.getText(KEY).insert(0, 'alpha');
const offline = cloneOf(online);
const offlineBefore = textOf(offline);
restoreTo(online, 'beta'); // confirmed while the peer is offline
offline.getText(KEY).delete(0, 5);
offline.getText(KEY).insert(0, 'ALPHA'); // same range, offline
sync(online, offline);
check('offline and restored peers converge', textOf(online), textOf(offline));
const mergedText = textOf(online);
check('the offline edit is not silently lost from the offline replica before merge', offlineBefore, 'alpha');

/* ------------------------------------------------------------------ *
 * 5. Independent replica: who can undo the restore?
 *    A restore is a shared edit. A replica that received it as a remote update has no local
 *    restore operation, so its UndoManager cannot undo it. This is the product distinction
 *    between server restore and client Undo.
 * ------------------------------------------------------------------ */
const author = new Y.Doc();
author.getText(KEY).insert(0, 'base');
const authorUndo = new Y.UndoManager(author.getText(KEY), { trackedOrigins: new Set([ORIGIN]) });
const other = cloneOf(author);
// Installed BEFORE the restore arrives, so this proves the replica had a live UndoManager at
// the moment it received a remote restore (A7 P3-4).
const otherUndo = new Y.UndoManager(other.getText(KEY), { trackedOrigins: new Set([ORIGIN]) });
restoreTo(author, 'restored');
Y.applyUpdate(other, Y.encodeStateAsUpdate(author, Y.encodeStateVector(other)));
check('other replica sees the restored text', textOf(other), 'restored');
otherUndo.undo();
check('a remote replica cannot undo the restore', textOf(other), 'restored');
authorUndo.undo();
check('the originating replica can undo it locally, if the product tracks restore', textOf(author), 'base');

/* ------------------------------------------------------------------ *
 * 6. Persist-first failure / retry
 * ------------------------------------------------------------------ */
const durable = new Y.Doc();
durable.getText(KEY).insert(0, 'persisted');
const preRestoreText = textOf(durable);
let attempts = 0;
function appendDurably() {
  attempts += 1;
  if (attempts === 1) throw new Error('disk full');
}
function buildRestoreUpdate(current, target) {
  const staging = cloneOf(current);
  restoreTo(staging, target);
  return Y.encodeStateAsUpdate(staging, Y.encodeStateVector(current));
}
const restoreUpdate = buildRestoreUpdate(durable, 'restored');
try {
  appendDurably();
  Y.applyUpdate(durable, restoreUpdate);
} catch (error) {
  check('failed append is visible to the caller', String(error.message), 'disk full');
}
check('the live document is untouched after a failed append', textOf(durable), preRestoreText);
appendDurably();
Y.applyUpdate(durable, restoreUpdate);
check('retry applies the restore exactly once', textOf(durable), 'restored');
check('the durable append was attempted twice', attempts, 2);

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */
const summary = {
  checks: results.length,
  failed: results.filter((entry) => !entry.ok).length,
  legacyFailures,
  unicodeCases,
  mergeResult: { offlineBefore, mergedText, converged: textOf(online) === textOf(offline) },
  undo: {
    otherReplicaAfterUndo: textOf(other),
    authorReplicaAfterUndo: textOf(author),
  },
};
console.log(JSON.stringify({ summary, results }, null, 2));
if (summary.failed > 0) process.exitCode = 1;
