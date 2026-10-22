/**
 * `logger.ts` / `startup.ts` — the structured logging contract (M4 B9).
 *
 * Every assertion here is made against an **injected sink**, i.e. the exact lines the server
 * would have written. That is what makes the negative half of the contract testable: not only
 * "the event was emitted" but "the cookie, the body, the instruction and the secret value were
 * not".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServerConfig } from '../config.js';
import {
  createLogger,
  readLogLevel,
  type LogLevel,
  type LogSink,
} from './logger.js';
import { logStartupSummary, readConfiguredAiModel } from './startup.js';

interface CapturedLine {
  readonly line: string;
  readonly level: LogLevel;
}

/** A sink that records exactly what a real process would have written. */
function capture(): { sink: LogSink; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  return {
    lines,
    sink: {
      write(line: string, level: LogLevel): void {
        lines.push({ line, level });
      },
    },
  };
}

/** Parse every captured line; a line that is not one JSON object fails here. */
function parsed(lines: readonly CapturedLine[]): Record<string, unknown>[] {
  return lines.map((captured, index) => {
    let value: unknown;
    try {
      value = JSON.parse(captured.line);
    } catch {
      assert.fail(`line ${index} is not JSON: ${captured.line}`);
    }
    assert.equal(typeof value, 'object');
    assert.notEqual(value, null);
    assert.equal(Array.isArray(value), false, 'one line must be one JSON object');
    return value as Record<string, unknown>;
  });
}

/** All records whose `event` is `event`. */
function byEvent(
  records: readonly Record<string, unknown>[],
  event: string,
): Record<string, unknown>[] {
  return records.filter((record) => record['event'] === event);
}

describe('structured logger', () => {
  it('writes one parseable JSON object per line, with ts/level/event and context', () => {
    const { sink, lines } = capture();
    const logger = createLogger({
      sink,
      now: () => new Date('2026-10-22T03:00:00.000Z'),
    });

    logger.info('http.request', { method: 'GET', path: '/health', status: 200 });
    logger.error('http.error', { errorCode: 'internal_error', errorClass: 'TypeError' });

    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.level, 'info');
    assert.equal(lines[1]?.level, 'error');

    const records = parsed(lines);
    assert.deepEqual(records[0], {
      ts: '2026-10-22T03:00:00.000Z',
      level: 'info',
      event: 'http.request',
      method: 'GET',
      path: '/health',
      status: 200,
    });
    assert.equal(records[1]?.['event'], 'http.error');
    assert.equal(records[1]?.['errorCode'], 'internal_error');
    assert.equal(records[1]?.['level'], 'error');
  });

  it('merges child context, lets the child override, and never mutates the parent', () => {
    const { sink, lines } = capture();
    const parent = createLogger({ sink });
    const request = parent.child({ requestId: 'req-1' });
    const session = request.child({ userId: 'user-1', documentId: 'doc-1' });

    session.info('ai.suggest', { outcome: 'ok', documentId: 'doc-2' });
    parent.info('server.config', { nodeEnv: 'test' });
    request.warn('http.request', { status: 404 });

    const records = parsed(lines);
    assert.equal(records[0]?.['requestId'], 'req-1');
    assert.equal(records[0]?.['userId'], 'user-1');
    assert.equal(records[0]?.['documentId'], 'doc-2', 'event field wins over child context');
    // The parent and the request-scoped child are unchanged by the deeper child.
    assert.equal(records[1]?.['requestId'], undefined);
    assert.equal(records[1]?.['documentId'], undefined);
    assert.equal(records[2]?.['requestId'], 'req-1');
    assert.equal(records[2]?.['documentId'], undefined);
  });

  it('filters info and warn when LOG_LEVEL=error', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ level: readLogLevel('error'), sink });

    logger.info('http.request', { status: 200 });
    logger.warn('ws.upgrade', { outcome: 'unauthenticated' });
    logger.error('backup.failed', { code: 'BACKUP_CREATE_FAILED' });

    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, 'error');
    assert.equal(parsed(lines)[0]?.['event'], 'backup.failed');
  });

  it('defaults LOG_LEVEL to info and ignores unknown values (never silences the server)', () => {
    assert.equal(readLogLevel(undefined), 'info');
    assert.equal(readLogLevel(''), 'info');
    assert.equal(readLogLevel('INFO'), 'info');
    assert.equal(readLogLevel('warn'), 'warn');
    assert.equal(readLogLevel(' error '), 'error');
    assert.equal(readLogLevel('verbose'), 'info');
  });

  it('redacts secrets by field name at any depth, including headers/body/instruction', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink });

    logger.info('http.request', {
      cookie: 'insighthub_session=LEAK_COOKIE',
      authorization: 'Bearer LEAK_AUTH',
      body: { demoUserId: 'LEAK_BODY' },
      instruction: 'LEAK_INSTRUCTION',
      content: 'LEAK_CONTENT',
      nested: { 'set-cookie': 'LEAK_SET_COOKIE', safe: 'kept' },
      safe: 'kept',
    });

    const output = lines.map((captured) => captured.line).join('\n');
    for (const leak of [
      'LEAK_COOKIE',
      'LEAK_AUTH',
      'LEAK_BODY',
      'LEAK_INSTRUCTION',
      'LEAK_CONTENT',
      'LEAK_SET_COOKIE',
      'cookie',
      'authorization',
    ]) {
      assert.equal(output.includes(leak), false, `the log contains ${JSON.stringify(leak)}`);
    }
    const record = parsed(lines)[0];
    assert.equal(record?.['safe'], 'kept');
    assert.deepEqual(record?.['nested'], { safe: 'kept' });
  });

  it('renders an Error as its class name, never its message', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink });

    logger.error('http.error', {
      error: new Error('LEAK_MESSAGE: SELECT * FROM document'),
      errorClass: 'Error',
    });

    const output = lines[0]?.line ?? '';
    assert.equal(output.includes('LEAK_MESSAGE'), false);
    assert.equal(output.includes('SELECT'), false);
    assert.deepEqual(parsed(lines)[0]?.['error'], { errorClass: 'Error' });
  });

  it('cannot be renamed or re-levelled through caller fields', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink });
    logger.info('real.event', { ts: 'not-a-date', level: 'error', event: 'forged.event' });

    const record = parsed(lines)[0];
    assert.equal(record?.['event'], 'real.event');
    assert.equal(record?.['level'], 'info');
    assert.notEqual(record?.['ts'], 'not-a-date');
  });
});

/** A complete, production-shaped configuration for the startup summary. */
function startupConfig(): ServerConfig {
  return {
    port: 3001,
    host: '0.0.0.0',
    corsOrigin: 'https://app.example.test',
    wsPath: '/ws',
    authMode: 'clerk',
    nodeEnv: 'production',
    dataPath: '/var/data',
    staticDir: '/app/apps/web/dist',
    backupEnabled: true,
  };
}

describe('startup summary', () => {
  it('emits exactly the non-sensitive fields and never a secret value', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink });
    const env: NodeJS.ProcessEnv = {
      CLERK_SECRET_KEY: 'sk_test_LEAK_CLERK_SECRET',
      OPENAI_API_KEY: 'sk-proj-LEAK_OPENAI_KEY',
      AI_PROVIDER: 'openai',
      OPENAI_MODEL: 'gpt-test-luna',
    };

    logStartupSummary(logger, startupConfig(), env);

    const records = parsed(lines);
    assert.equal(records.length, 3, 'one config event and two secret-presence events');

    const config = byEvent(records, 'server.config');
    assert.equal(config.length, 1);
    assert.deepEqual(Object.keys(config[0] ?? {}).sort(), [
      'aiModel',
      'aiProvider',
      'authMode',
      'backupEnabled',
      'dataPath',
      'event',
      'host',
      'level',
      'nodeEnv',
      'port',
      'staticDir',
      'ts',
    ]);
    assert.equal(config[0]?.['nodeEnv'], 'production');
    assert.equal(config[0]?.['port'], 3001);
    assert.equal(config[0]?.['host'], '0.0.0.0');
    assert.equal(config[0]?.['authMode'], 'clerk');
    assert.equal(config[0]?.['aiProvider'], 'openai');
    assert.equal(config[0]?.['aiModel'], 'gpt-test-luna');
    assert.equal(config[0]?.['dataPath'], '/var/data');
    assert.equal(config[0]?.['staticDir'], '/app/apps/web/dist');
    assert.equal(config[0]?.['backupEnabled'], true);

    const secrets = byEvent(records, 'server.secret');
    assert.deepEqual(secrets, [
      {
        ts: secrets[0]?.['ts'],
        level: 'info',
        event: 'server.secret',
        name: 'CLERK_SECRET_KEY',
        present: true,
      },
      {
        ts: secrets[1]?.['ts'],
        level: 'info',
        event: 'server.secret',
        name: 'OPENAI_API_KEY',
        present: true,
      },
    ]);

    const output = lines.map((captured) => captured.line).join('\n');
    assert.equal(output.includes('sk_test_LEAK_CLERK_SECRET'), false);
    assert.equal(output.includes('sk-proj-LEAK_OPENAI_KEY'), false);
    // No cookie/header vocabulary either; the summary is configuration, not request material.
    for (const field of ['cookie', 'authorization', 'token']) {
      assert.equal(output.toLowerCase().includes(`"${field}"`), false);
    }
  });

  it('reports a missing credential as present:false without inventing a value', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ sink });

    logStartupSummary(logger, { ...startupConfig(), backupEnabled: false }, {});

    const secrets = byEvent(parsed(lines), 'server.secret');
    assert.deepEqual(
      secrets.map((record) => [record['name'], record['present']]),
      [
        ['CLERK_SECRET_KEY', false],
        ['OPENAI_API_KEY', false],
      ],
    );
    assert.equal(parsed(lines)[0]?.['aiProvider'], 'disabled');
    assert.equal(parsed(lines)[0]?.['backupEnabled'], false);
  });

  it('reads the configured model through the adapter default', () => {
    assert.equal(readConfiguredAiModel({}), 'gpt-5.6-luna');
    assert.equal(readConfiguredAiModel({ OPENAI_MODEL: '  gpt-custom  ' }), 'gpt-custom');
  });
});
