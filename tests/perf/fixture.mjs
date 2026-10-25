/**
 * Deterministic 100,000-line Markdown fixture for the A6 Performance Evidence Gate.
 *
 * The fixture is generated from a **fixed** line template and a monotonically
 * increasing line number. There is no randomness, no clock read and no locale
 * formatting, so the same commit produces the same bytes on every run. The
 * generator is executed twice in-process before the benchmark and both SHA-256
 * digests are compared; a mismatch is a hard error, not a warning.
 *
 * The file is deliberately plain text rather than a compressed blob: the
 * benchmark must load the same UTF-8 Markdown an author would open, and the
 * digest in the report must identify bytes a reviewer can inspect directly.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 100,000 lines is the Gate B size (`docs/DECISIONS.md` D-086). */
export const LINE_COUNT = 100_000;

/** Relative to the repository root. */
export const FIXTURE_RELATIVE_PATH = 'tests/perf/fixtures/100k-lines.md';

/** The exact line template. `<i>` is 1-based and never padded or localized. */
export const LINE_TEMPLATE = 'line-<i>: The quick brown fox jumps over the lazy dog 0123456789.';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `<repo>` — this file is at `tests/perf/fixture.mjs`. */
export const repoRoot = path.resolve(here, '..', '..');

export const fixturePath = path.join(repoRoot, FIXTURE_RELATIVE_PATH);

/** Build the fixture text in memory. The only input is the fixed line count. */
export function buildFixtureText() {
  const lines = new Array(LINE_COUNT);
  for (let index = 0; index < LINE_COUNT; index += 1) {
    lines[index] = `line-${index + 1}: The quick brown fox jumps over the lazy dog 0123456789.`;
  }
  return `${lines.join('\n')}\n`;
}

/** SHA-256 of a Buffer, as lower-case hexadecimal. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Ensure the checked-in fixture exists and matches the current generator.
 *
 * Returns facts (not the 6+ MB text). `secondGenerationSha256` is the digest of
 * a second independent build, so the report can show determinism directly
 * rather than asserting it in prose.
 */
export async function ensureFixture({ writeIfMissing = true } = {}) {
  const first = buildFixtureText();
  const second = buildFixtureText();
  const firstBuffer = Buffer.from(first, 'utf8');
  const secondBuffer = Buffer.from(second, 'utf8');
  const firstSha = sha256(firstBuffer);
  const secondSha = sha256(secondBuffer);
  if (firstSha !== secondSha) {
    throw new Error(
      `the fixture generator is not deterministic: ${firstSha} !== ${secondSha}`,
    );
  }

  let observedSha = null;
  let wrote = false;
  if (existsSync(fixturePath)) {
    const onDisk = await readFile(fixturePath);
    observedSha = sha256(onDisk);
    if (observedSha !== firstSha) {
      throw new Error(
        `the fixture on disk does not match the generator: on-disk ${observedSha}, ` +
          `generated ${firstSha}. Delete ${FIXTURE_RELATIVE_PATH} and re-run.`,
      );
    }
  } else if (writeIfMissing) {
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, firstBuffer);
    wrote = true;
    observedSha = firstSha;
  } else {
    throw new Error(`the fixture is missing: ${FIXTURE_RELATIVE_PATH}`);
  }

  return {
    path: FIXTURE_RELATIVE_PATH,
    absolutePath: fixturePath,
    lineCount: LINE_COUNT,
    characters: first.length,
    bytes: firstBuffer.byteLength,
    sha256: firstSha,
    secondGenerationSha256: secondSha,
    deterministic: firstSha === secondSha,
    wroteFixture: wrote,
    observedOnDiskSha256: observedSha,
    lineTemplate: LINE_TEMPLATE,
    trailingNewline: true,
  };
}
