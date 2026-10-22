import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DOCUMENT_TEXT_KEY, type CollaborativeSession } from '@insighthub/shared';
import { describe, expect, it } from 'vitest';

import { AiSuggestPanel } from '../editor/AiSuggestPanel.js';
import { AI_PANEL_PROVIDER_COPY } from '../editor/aiProposalCopy.js';
import type { CapabilityGate } from '../permissions/capabilityGate.js';
import type { AiProviderMode } from './aiProvider.js';
import { createLocalProvider } from './localProvider.js';
import type { AiProvider } from './provider.js';
import { createRemoteProvider } from './remoteProvider.js';
import { createDocument } from './testSupport.js';

/**
 * The panel's **remote-mode** wiring, rendered as static markup.
 *
 * There is no DOM in this workspace's Vitest config, but React's server renderer executes the same
 * component tree and emits the same testids. That is enough to pin the two things this round
 * changed in the panel: the local intent chips are absent in remote mode, and the remote copy makes
 * no local/offline claim. The interaction itself (Generate → proposal → Accept) stays in A6's real
 * browser suite.
 */
function panelMarkup(
  mode: AiProviderMode | undefined,
  provider: AiProvider = createLocalProvider(),
): string {
  const doc = createDocument('hello');
  const session = {
    documentId: 'demo-document',
    doc,
    text: doc.getText(DOCUMENT_TEXT_KEY),
    transact: (): void => undefined,
  } as unknown as CollaborativeSession;
  const gate = {
    capabilities: { canRead: true, canEdit: true },
  } as unknown as CapabilityGate;

  return renderToStaticMarkup(
    createElement(AiSuggestPanel, {
      session,
      gate,
      readSelection: () => null,
      onClose: (): void => undefined,
      onSelectDocument: (): void => undefined,
      provider,
      ...(mode === undefined ? {} : { providerMode: mode }),
    }),
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('AiSuggestPanel provider modes', () => {
  it('local mode keeps every existing testid and the five intent chips', () => {
    const html = panelMarkup('local');

    expect(html).toContain('data-testid="ai-panel"');
    expect(html).toContain('data-testid="ai-instruction"');
    expect(html).toContain('data-testid="ai-generate"');
    expect(html).toContain('data-testid="ai-status"');
    expect(html).toContain('data-testid="ai-empty"');
    expect(html).toContain('data-testid="ai-close"');
    expect(html).toContain('data-testid="ai-directory"');
    expect(html).toContain('data-testid="ai-directory-refresh"');
    expect(html).toContain('data-phase="idle"');
    expect(occurrences(html, 'data-testid="ai-intent"')).toBe(5);
    expect(html).toContain('Deterministic suggestion provider — no model.');
    expect(html).toContain('placeholder="e.g. uppercase"');
  });

  it('remote mode hides the local intent chips but keeps every testid and the abort-safe surface', () => {
    const html = panelMarkup('remote');

    expect(occurrences(html, 'data-testid="ai-intent"')).toBe(0);
    expect(html).not.toContain('class="ai-chips"');

    // The testids A6 and the existing browser suite depend on are unchanged.
    expect(html).toContain('data-testid="ai-panel"');
    expect(html).toContain('data-testid="ai-instruction"');
    expect(html).toContain('data-testid="ai-generate"');
    expect(html).toContain('data-testid="ai-status"');
    expect(html).toContain('data-testid="ai-empty"');
    expect(html).toContain('data-testid="ai-close"');
    expect(html).toContain('data-testid="ai-directory"');
    expect(html).toContain('data-testid="ai-directory-refresh"');
    expect(html).toContain('data-phase="idle"');

    // No local-only promise survives into the remote copy.
    expect(html).not.toContain('Deterministic');
    expect(html).not.toContain('no model');
    expect(html).not.toContain('local provider');
    expect(html).not.toContain('no network');
    expect(html).not.toContain('pick a chip');

    expect(html).toContain(AI_PANEL_PROVIDER_COPY.remote.note);
    expect(html).toContain('placeholder="e.g. Make the second paragraph more concise"');
    expect(html).toContain('No proposal yet — describe the edit you want and press Generate.');
  });

  it('infers remote from a provider created by createRemoteProvider, without a mode prop', () => {
    const remote = createRemoteProvider({
      endpoint: '/test/ai',
      fetchImpl: (async (): Promise<Response> => {
        throw new Error('the panel must not call the provider while rendering');
      }) as typeof fetch,
    });
    const html = panelMarkup(undefined, remote);

    expect(occurrences(html, 'data-testid="ai-intent"')).toBe(0);
    expect(html).toContain(AI_PANEL_PROVIDER_COPY.remote.note);
  });
});
