/**
 * The second diagnostic fixture: 100,000 lines with **real block boundaries** — headings,
 * blank-line-separated paragraphs, lists and fenced code blocks.
 *
 * It exists only to quantify how much of the pathological fixture's parser cost is caused by its
 * single 6.8 MB paragraph. The pathological fixture is kept unchanged and remains the official
 * baseline (`tests/perf/fixture.mjs`).
 *
 * Deterministic: no randomness, no timestamps. Same content every run, verified by sha256.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot } from './fixture.mjs';

export const BLOCK_LINE_COUNT = 100_000;
export const BLOCK_FIXTURE_RELATIVE_PATH = 'tests/perf/fixtures/100k-block.md';
export const blockFixturePath = path.join(repoRoot, BLOCK_FIXTURE_RELATIVE_PATH);

const PROSE_UNIT =
  'The quick brown fox jumps over the lazy dog while the deterministic benchmark records every block. ';
const PROSE = PROSE_UNIT.repeat(3).trim();

function blockLines(index) {
  return [
    `## Section ${String(index).padStart(5, '0')} — deterministic block`,
    '',
    `${PROSE} Section ${index}, paragraph one.`,
    `${PROSE} Section ${index}, paragraph two.`,
    '',
    `- list item one for section ${index}`,
    `- list item two for section ${index}`,
    '',
    '```js',
    `const section${index} = ${index};`,
    'export default section' + index + ';',
    '```',
  ];
}

export function buildBlockFixtureText() {
  const lines = [];
  let index = 0;
  while (lines.length < BLOCK_LINE_COUNT) {
    const block = blockLines(index);
    for (const line of block) {
      if (lines.length >= BLOCK_LINE_COUNT) break;
      lines.push(line);
    }
    index += 1;
  }
  return `${lines.join('\n')}\n`;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Write the block fixture if absent and return the same shape as `ensureFixture`. */
export async function ensureBlockFixture() {
  const text = buildBlockFixtureText();
  const buffer = Buffer.from(text, 'utf8');
  const digest = sha256(buffer);
  await mkdir(path.dirname(blockFixturePath), { recursive: true });
  let onDisk = null;
  try {
    onDisk = await readFile(blockFixturePath);
  } catch {
    await writeFile(blockFixturePath, buffer);
    onDisk = buffer;
  }
  return {
    absolutePath: blockFixturePath,
    characters: text.length,
    bytes: buffer.byteLength,
    lineCount: BLOCK_LINE_COUNT,
    sha256: digest,
    onDiskSha256: sha256(onDisk),
  };
}
