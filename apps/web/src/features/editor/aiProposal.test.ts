import type * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_TEXT_KEY,
  TRANSACTION_ORIGINS,
  type AiEditSuggestion,
  type TransactionOrigin,
} from '@insighthub/shared';

import { applySuggestion } from '../ai/apply.js';
import { createLocalProvider, LocalProviderError } from '../ai/localProvider.js';
import type { AiSuggestInput } from '../ai/provider.js';
import { RemoteProviderError } from '../ai/remoteProvider.js';
import { createLocalRevisionTracker } from '../ai/revision.js';
import { applyPort, createDocument, docText } from '../ai/testSupport.js';
import { APPLY_FAILURE_COPY, describeProviderFailure } from './aiProposalCopy.js';

/**
 * The two pieces of *UI-owned* AI logic that can be tested without a browser: the revision counter
 * (`features/ai/revision.ts`, the A0-approved exception file) and the copy map the panel renders.
 *
 * The point of the counter test is the **origin filter**, not arithmetic: it is the difference
 * between "a peer edited elsewhere and my proposal still applies" (acceptance criterion D) and
 * "any remote keystroke invalidates my proposal". The test drives the same three checks
 * `applySuggestion` runs, against a real `Y.Doc`, so the two halves are measured together.
 *
 * The panel's JSX is not tested here: there is no DOM environment in this workspace's Vitest
 * config, and the interaction itself is measured in a real browser (`tests/browser`). What is
 * tested here is the copy and the counter, so a sentence or an origin can never silently change.
 */

const REVISION = 0;

/** The deterministic provider, the same instance the panel uses by default. */
const provider = createLocalProvider();

/**
 * Generate a real anchored suggestion against `doc`.
 *
 * Anchors are minted from the live `Y.Text` (`AiSuggestInput.anchorText`), so the returned
 * suggestion is exactly what the panel would hold after clicking Generate.
 */
async function generate(
  doc: Y.Doc,
  instruction: string,
  selection?: { from: number; to: number },
): Promise<AiEditSuggestion> {
  const text = doc.getText(DOCUMENT_TEXT_KEY);
  const input: AiSuggestInput = {
    documentId: 'demo-document',
    instruction,
    text: text.toString(),
    ...(selection === undefined ? {} : { selection }),
    baseRevision: REVISION,
    anchorText: text,
  };
  return provider.suggest(input);
}

/** Apply one update on `doc` under `origin`, the way a peer (or the editor) would. */
function edit(doc: Y.Doc, origin: TransactionOrigin, mutate: (text: Y.Text) => void): void {
  doc.transact(() => mutate(doc.getText(DOCUMENT_TEXT_KEY)), origin);
}

describe('createLocalRevisionTracker', () => {
  it('counts local and ai updates, and nothing else', () => {
    const doc = createDocument('');
    const tracker = createLocalRevisionTracker(doc);
    expect(tracker.get()).toBe(0);

    edit(doc, TRANSACTION_ORIGINS.local, (text) => text.insert(0, 'a'));
    expect(tracker.get()).toBe(1);

    edit(doc, TRANSACTION_ORIGINS.ai, (text) => text.insert(0, 'b'));
    expect(tracker.get()).toBe(2);

    // A remote peer's edit — even one that lands inside a proposal's range — is *not* this
    // client's revision (CONTRACTS §11.1). If these two assertions ever invert, "a peer edited
    // elsewhere" starts reporting `revision` stale and acceptance criterion D breaks.
    edit(doc, TRANSACTION_ORIGINS.remote, (text) => text.insert(0, 'c'));
    expect(tracker.get()).toBe(2);

    edit(doc, TRANSACTION_ORIGINS.persistence, (text) => text.insert(0, 'd'));
    expect(tracker.get()).toBe(2);

    tracker.dispose();
    expect(docText(doc)).toBe('dcba');
  });

  it('stops counting after dispose', () => {
    const doc = createDocument('');
    const tracker = createLocalRevisionTracker(doc);
    edit(doc, TRANSACTION_ORIGINS.local, (text) => text.insert(0, 'a'));
    tracker.dispose();
    edit(doc, TRANSACTION_ORIGINS.local, (text) => text.insert(0, 'b'));
    expect(tracker.get()).toBe(1);
    // A second dispose is a no-op, not an error: React effects may clean up twice in StrictMode.
    tracker.dispose();
    expect(tracker.get()).toBe(1);
  });

  it('counts one revision per local transaction, not one per changed character', () => {
    const doc = createDocument('');
    const tracker = createLocalRevisionTracker(doc);
    edit(doc, TRANSACTION_ORIGINS.local, (text) => {
      text.insert(0, 'hello');
      text.insert(5, ' world');
    });
    expect(tracker.get()).toBe(1);
  });
});

describe('revision + applySuggestion: the two measured cases', () => {
  it('a LOCAL edit after generating fails check #1 and leaves the text untouched', async () => {
    const doc = createDocument('hello world');
    const tracker = createLocalRevisionTracker(doc);
    const suggestion = await generate(doc, 'uppercase');
    const baseRevision = suggestion.baseRevision;
    expect(baseRevision).toBe(tracker.get());

    // The user keeps typing while the proposal is on screen.
    edit(doc, TRANSACTION_ORIGINS.local, (text) => text.insert(0, 'X'));
    const before = docText(doc);

    const result = applySuggestion(applyPort(doc), suggestion, tracker.get());

    expect(result).toEqual({ ok: false, reason: 'revision' });
    // "Text unchanged" is the acceptance claim, not an implementation detail.
    expect(docText(doc)).toBe(before);
    expect(docText(doc)).toBe('Xhello world');
    expect(APPLY_FAILURE_COPY.revision).toBe('生成此建议后，文档已在本地被修改。');
  });

  it('a REMOTE edit outside the anchored range still applies (check #1 must NOT fire)', async () => {
    const doc = createDocument('hello world');
    const tracker = createLocalRevisionTracker(doc);
    // `uppercase` with no selection replaces the whole document, so target a sub-range instead:
    // the selection is where the proposal is anchored, and the peer edits outside it.
    const suggestion = await generate(doc, 'uppercase', { from: 6, to: 11 });
    expect(docText(doc)).toBe('hello world');

    edit(doc, TRANSACTION_ORIGINS.remote, (text) => text.insert(0, 'PREFIX '));

    // The counter did not move: the peer's edit is judged by anchor + expectedText, not by #1.
    expect(tracker.get()).toBe(0);
    const result = applySuggestion(applyPort(doc), suggestion, tracker.get());

    expect(result).toEqual({ ok: true, applied: 1 });
    expect(docText(doc)).toBe('PREFIX hello WORLD');
  });

  it('a REMOTE edit inside the anchored range is rejected by the anchor text, not by revision', async () => {
    const doc = createDocument('hello world');
    const tracker = createLocalRevisionTracker(doc);
    const suggestion = await generate(doc, 'uppercase', { from: 6, to: 11 });

    edit(doc, TRANSACTION_ORIGINS.remote, (text) => text.delete(6, 5));

    const before = docText(doc);
    const result = applySuggestion(applyPort(doc), suggestion, tracker.get());

    expect(result).toEqual({ ok: false, reason: 'text-mismatch' });
    expect(docText(doc)).toBe(before);
  });
});

describe('apply failure copy', () => {
  it('has the exact frozen sentence for every reason', () => {
    expect(APPLY_FAILURE_COPY).toEqual({
      revision: '生成此建议后，文档已在本地被修改。',
      'anchor-unresolved': '该建议所锚定的文本已不存在。',
      'text-mismatch': '你审阅过的文本已经改变。',
      malformed: '该建议无法直接应用。',
    });
  });
});

describe('describeProviderFailure', () => {
  it('keeps the typed provider kind and shows an actionable Chinese detail', () => {
    const copy = describeProviderFailure(
      new LocalProviderError('unknown-instruction', 'Unknown instruction "summarise".'),
    );
    expect(copy.kind).toBe('unknown-instruction');
    expect(copy.title).toBe('本地提供器无法识别该指令。');
    // The training step the user needs: pick a preset chip, or type a clearer instruction.
    expect(copy.detail).toBe('无法识别该指令，请点击上方预设操作，或输入更明确的指令后点击生成。');
    // The English diagnostic is not rendered.
    expect(copy.detail).not.toContain('Unknown instruction');
  });

  it('falls back to a generic Chinese headline without a stack trace', () => {
    const copy = describeProviderFailure(new TypeError('buildSuggestion: bad input'));
    expect(copy.kind).toBe('unexpected');
    expect(copy.title).toBe('无法生成建议。');
    expect(copy.detail).toBe('提供器失败，且没有给出可识别的原因。');
    expect(copy.detail).not.toContain('buildSuggestion');

    const unknown = describeProviderFailure('not an error');
    expect(unknown.detail).toBe('提供器失败，且没有给出可识别的原因。');
  });

  it('distinguishes session loss, permission denial, origin refusal and network loss', () => {
    const unauthorized = describeProviderFailure(new RemoteProviderError('unauthorized', 401));
    const notFound = describeProviderFailure(new RemoteProviderError('not-found', 404));
    const origin = describeProviderFailure(new RemoteProviderError('provider', 403));
    const network = describeProviderFailure(new RemoteProviderError('provider'));

    expect(unauthorized.title).toContain('会话已失效');
    expect(notFound.title).toContain('无权访问');
    expect(origin.title).toBe('AI 提供器未能生成建议。');
    expect(origin.detail).toContain('403');
    expect(origin.detail).toContain('请求来源不被允许');
    expect(network.detail).toContain('网络');
    // Distinct causes must not collapse into one sentence.
    const details = new Set([unauthorized.detail, notFound.detail, origin.detail, network.detail]);
    expect(details.size).toBe(4);
  });
});
