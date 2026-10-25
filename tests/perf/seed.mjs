/**
 * Server-side seed for the performance fixture.
 *
 * Run with `tsx` (the same TypeScript runtime the server uses) so this script
 * imports the **real** `openDocumentStore` implementation:
 *
 * ```text
 * node apps/server/node_modules/tsx/dist/cli.mjs tests/perf/seed.mjs \
 *   <dataPath> <documentId> <fixturePath>
 * ```
 *
 * It writes a normal Yjs update (`Y.Text` key `content`) through the production
 * persistence seam. Nothing in `apps/**` is modified and no test-only endpoint
 * is added: the bytes are exactly what a client would have produced, committed
 * to the same SQLite store the server opens a moment later.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { openDocumentStore } from '../../apps/server/src/persistence/open-store.ts';
import { loadYjs } from '../browser/lib/deps.mjs';

const [dataPath, documentId, fixtureFile] = process.argv.slice(2);
if (dataPath === undefined || documentId === undefined || fixtureFile === undefined) {
  console.error('usage: seed.mjs <dataPath> <documentId> <fixturePath>');
  process.exit(2);
}

const text = await readFile(path.resolve(fixtureFile), 'utf8');
if (text.length === 0) throw new Error('the fixture is empty');

const Y = await loadYjs();
const doc = new Y.Doc();
doc.getText('content').insert(0, text);
const update = Y.encodeStateAsUpdate(doc);

const opened = await openDocumentStore(dataPath);
let sequence;
try {
  sequence = await opened.store.append(documentId, update);
} finally {
  await opened.store.close();
  doc.destroy();
}

// Keep the output small and machine-readable. No document body is printed.
process.stdout.write(
  `${JSON.stringify({
    documentId,
    characters: text.length,
    updateBytes: update.byteLength,
    sequence,
    dataPath: opened.dataPath,
    journalMode: opened.journalMode,
  })}\n`,
);
