import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DOCUMENT_TEXT_KEY, type CollaborativeSession } from '@insighthub/shared';
import { describe, expect, it } from 'vitest';

import {
  AiSuggestPanel,
  instructionForIntent,
  LOCAL_INTENT_HINT,
} from '../editor/AiSuggestPanel.js';
import { AI_PANEL_PROVIDER_COPY } from '../editor/aiProposalCopy.js';
import type { CapabilityGate } from '../permissions/capabilityGate.js';
import type { AiProviderMode } from './aiProvider.js';
import { createLocalProvider, LOCAL_INTENTS } from './localProvider.js';
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
    // UI-2 moved the read-only directory to the workspace's permanent left rail. The panel must
    // not mount a second directory (that would issue a second list request); the rail and its
    // test ids are asserted by the browser suite instead.
    expect(html).not.toContain('data-testid="ai-directory"');
    expect(html).not.toContain('data-testid="ai-directory-refresh"');
    expect(html).toContain('data-phase="idle"');
    expect(occurrences(html, 'data-testid="ai-intent"')).toBe(5);
    expect(html).toContain('确定性建议提供器——不使用语言模型。');
    expect(html).toContain('placeholder="例如：uppercase（转为大写）"');
    // The local preset actions are labelled in Chinese, and the hint tells the user to pick one.
    for (const label of ['转为大写', '去除行尾空格', '添加待办', '替换选区', '删除选区']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('data-testid="ai-local-hint"');
    expect(html).toContain(LOCAL_INTENT_HINT);
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
    // UI-2 moved the read-only directory to the workspace's permanent left rail. The panel must
    // not mount a second directory (that would issue a second list request); the rail and its
    // test ids are asserted by the browser suite instead.
    expect(html).not.toContain('data-testid="ai-directory"');
    expect(html).not.toContain('data-testid="ai-directory-refresh"');
    expect(html).toContain('data-phase="idle"');

    // No local-only promise survives into the remote copy.
    expect(html).not.toContain('确定性');
    expect(html).not.toContain('不使用语言模型');
    expect(html).not.toContain('本地提供器');
    expect(html).not.toContain('预设操作');
    // Remote mode has no preset chips, so it must not show the "pick a preset" hint either.
    expect(html).not.toContain('data-testid="ai-local-hint"');
    expect(html).not.toContain(LOCAL_INTENT_HINT);

    expect(html).toContain(AI_PANEL_PROVIDER_COPY.remote.note);
    expect(html).toContain('placeholder="例如：把第二段写得更简洁"');
    expect(html).toContain('尚无建议——描述你想要的修改，然后点击生成。');
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

describe('local preset chips: Chinese labels, frozen instruction tokens', () => {
  it('still sends the original provider prefixes, not the translated labels', () => {
    for (const intent of LOCAL_INTENTS) {
      const instruction = instructionForIntent(intent);
      if (intent === 'replace-selection') {
        expect(instruction).toBe('replace-selection: ');
      } else {
        expect(instruction).toBe(intent);
      }
      // The letter "uppercase" and friends must never be replaced by the Chinese chip label.
      expect(instruction).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
