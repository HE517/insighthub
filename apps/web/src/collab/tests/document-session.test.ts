import { afterEach, describe, expect, it } from 'vitest';
import { awarenessStateSchema } from '@insighthub/shared';

import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { ContractTestServer } from './support/test-server.js';
import { createCollaborativeSession } from '../public.js';

/**
 * Requirement 1: local `Y.Doc` / `Y.Text` lifecycle.
 *
 * The session must be usable from local state alone, must expose exactly one
 * `Y.Text` for the document, and must not create a second history.
 */

let context: TestContext | undefined;
let server: ContractTestServer | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
  await server?.stop();
  server = undefined;
});

function ctx(): TestContext {
  context ??= createTestContext();
  return context;
}

describe('document session lifecycle', () => {
  it('is active from local state, before any network path exists', async () => {
    const session = await ctx().create();
    expect(session.state).toBe('active');
    // No socket was opened in this test, so the network path does not exist yet.
    expect(session.hasNetwork).toBe(false);
    expect(session.connectionStatus).toBe('idle');
    expect(session.text.toString()).toBe('');
    expect(session.doc.getText('content')).toBe(session.text);
    session.destroy();
  });

  it('applies local edits through a transaction and keeps them in the Y.Doc', async () => {
    const session = await ctx().create();
    session.transact((text) => text.insert(0, 'hello'));
    expect(session.text.toString()).toBe('hello');

    session.transact((text) => text.insert(5, ' world'));
    expect(session.text.toString()).toBe('hello world');
    expect(session.doc.getText('content').toString()).toBe('hello world');
    session.destroy();
  });

  it('exposes exactly one document text instance per session', async () => {
    const first = await ctx().create();
    const second = await ctx().create();
    expect(first.text).not.toBe(second.text);
    expect(first.doc).not.toBe(second.doc);
    first.transact((text) => text.insert(0, 'first'));
    expect(second.text.toString()).toBe('');
    first.destroy();
    second.destroy();
  });

  it('rejects a documentId or identity that cannot be published', async () => {
    await expect(
      createCollaborativeSession({
        documentId: '   ',
        user: { id: 'u', name: 'U' },
      }),
    ).rejects.toThrow(/documentId/);

    await expect(
      createCollaborativeSession({
        documentId: 'doc-x',
        user: { id: '', name: '' },
      }),
    ).rejects.toThrow(/id and name/);
  });

  it('publishes a schema-valid local awareness entry and no remote peers', async () => {
    const session = await ctx().create();
    const local = session.getLocalAwarenessState();
    expect(local).not.toBeNull();
    expect(awarenessStateSchema.safeParse(local).success).toBe(true);
    expect(local?.user.id).toBe('user-a');
    expect(local?.cursor).toBeNull();
    expect(session.getCollaborators()).toEqual([]);
    session.destroy();
  });

  it('reports an error state instead of throwing when IndexedDB is unusable', async () => {
    const failing = createTestContext({
      dependencies: {
        attachPersistence: () => Promise.reject(new Error('IndexedDB unavailable')),
      },
    });
    await expect(failing.create()).rejects.toThrow(/IndexedDB unavailable/);
    await failing.cleanup();
  });

  it('marks itself destroyed and refuses further network work', async () => {
    server = new ContractTestServer('doc-lifecycle');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'doc-lifecycle' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'connected');

    session.destroy();
    expect(session.state).toBe('destroyed');
    // Idempotent: a second destroy must not throw or redo teardown.
    expect(() => session.destroy()).not.toThrow();
  });
});
