/**
 * Structural guard for M2-P0-2 step 2: **no production code under `features/**` may
 * write presence through the raw `Awareness` instance.**
 *
 * ## Why a source invariant instead of a behavioural test
 *
 * The acceptance criterion is a property of the call graph - "zero bare
 * `setLocalState` / `setLocalStateField` calls in A2 production code" - and the only
 * file that could break it is `CollaborativeMarkdownEditor.tsx`, which builds an
 * `EditorView` and therefore cannot be instantiated in this Node environment
 * (`@codemirror/view` needs a real DOM, and jsdom is explicitly not evidence for this
 * project: `agent-prompts/A2-editor-frontend.md` §5).
 *
 * A behavioural test written against a stub would only prove the stub was not called.
 * This test reads the actual production sources and proves there is no write path left
 * to call, which is the claim the task makes.
 *
 * The guard was verified red-before-green: re-introducing one
 * `session.awareness.setLocalStateField(...)` line into the editor fails this suite with
 * that file and line number, and removing it turns the suite green again.
 *
 * ## Scope
 *
 * - Scanned: `apps/web/src/features/**`, excluding test files and the `testing/`
 *   double. The double must *define* `setLocalState`/`setLocalStateField` because it
 *   structurally stands in for the real `Awareness` class; it is not production code and
 *   is never imported by the app.
 * - Comment lines are skipped, so a doc comment quoting the old three-call shape (see
 *   `editorPresence.ts`) does not trip the scan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const FEATURES_DIR = join(process.cwd(), 'apps', 'web', 'src', 'features');

/** Raw-instance write calls that are forbidden in A2 production code. */
const FORBIDDEN_CALLS = ['.setLocalStateField(', '.setLocalState('] as const;

interface SourceFile {
  path: string;
  source: string;
}

function collectSources(dir: string): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `testing/` is the session double: it must mirror the real `Awareness` surface.
      if (entry === 'testing') continue;
      found.push(...collectSources(full));
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    // Tests may legitimately describe the forbidden shape in prose and assertions.
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    found.push({
      path: relative(process.cwd(), full).split(sep).join('/'),
      source: readFileSync(full, 'utf8'),
    });
  }
  return found;
}

/** A line that is only prose, not code. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** Source with comment lines removed. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .join('\n');
}

describe('presence write path (M2-P0-2 step 2)', () => {
  const sources = collectSources(FEATURES_DIR);

  it('finds the production sources it is supposed to scan', () => {
    // Guards against a silently empty scan (wrong cwd, renamed tree) passing vacuously.
    expect(sources.length).toBeGreaterThan(10);
    expect(
      sources.some((file) => file.path.endsWith('/editor/CollaborativeMarkdownEditor.tsx')),
    ).toBe(true);
  });

  it('has no raw awareness write call in production code', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const lines = file.source.split('\n');
      lines.forEach((sourceLine, index) => {
        if (isCommentLine(sourceLine)) return;
        for (const forbidden of FORBIDDEN_CALLS) {
          if (sourceLine.includes(forbidden)) {
            // The real file and line, so the failure names the line to delete.
            offenders.push(`${file.path}:${index + 1} contains ${forbidden}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('lets the editor publish presence only through the seam', () => {
    const editor = sources.find((file) =>
      file.path.endsWith('/editor/CollaborativeMarkdownEditor.tsx'),
    );
    const presence = sources.find((file) => file.path.endsWith('/editor/editorPresence.ts'));
    expect(editor).toBeDefined();
    expect(presence).toBeDefined();

    const editorCode = codeOnly(editor!.source);
    // The positive half: the one legal write path is present, so "remove the guard by
    // deleting the capability" cannot pass this test either.
    expect(editorCode).toContain('publishEditorPresence(');
    // `awareness` is still handed to the binding - that is the allowed use - and never
    // written.
    expect(editorCode).toContain('awareness: session.awareness');

    // The seam call itself lives in exactly one module, next to its documented rules.
    const presenceCode = codeOnly(presence!.source);
    expect(presenceCode).toContain('session.publishPresence(');
    // The editor no longer reads the local state either: the session owns whether a
    // publish is a no-op, and a local guard would hide a broken wiring behind a check.
    expect(presenceCode).not.toContain('getLocalAwarenessState');
  });

  it('does not compute or send updatedAt from A2 production code', () => {
    const offenders = sources
      .filter((file) => codeOnly(file.source).includes('updatedAt'))
      .map((file) => file.path);
    // The collaboration layer owns the timestamp (`docs/CONTRACTS.md` §15.2 rule 1).
    expect(offenders).toEqual([]);
  });
});
