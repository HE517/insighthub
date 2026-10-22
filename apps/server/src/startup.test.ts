/**
 * **M4 B3 — production config fail-fast** (`docs/CONTRACTS.md` §18.6,
 * `docs/DECISIONS.md` D-082 D2/D3).
 *
 * Two layers, because "the pure rule is right" and "the process actually refuses" are different
 * claims:
 *
 * 1. **Pure function** — `findStartupRefusal` is exercised for every rejection code, for a fully
 *    valid production configuration (no refusal), and for the same broken configuration under
 *    `NODE_ENV` unset/development/test (still no refusal: B3 changes nothing outside production).
 *    The messages are asserted to carry no configured value, only the code and a sentence.
 * 2. **Real process** — the actual entrypoint (`src/index.ts`) is spawned once per rejection
 *    code with a production environment. Each run must exit with code **1**, print the stable
 *    code on stderr, never reach `http ready`, and never echo a secret or the rejected value.
 *
 * No network, no Clerk call, no store is opened: the gate runs before all of that, which is the
 * property under test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEFAULT_CORS_ORIGIN,
  DEFAULT_DATA_PATH,
  loadConfig,
  type ServerConfig,
} from './config.js';
import {
  findStartupRefusal,
  type StartupEnvironment,
  type StartupRefusalCode,
} from './startup.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

/** An absolute path that is never opened: the gate only inspects it textually. */
const PRODUCTION_DATA_PATH = join(tmpdir(), 'insighthub-b3-production-data');
const PRODUCTION_ORIGIN = 'https://app.insighthub.example';

/** Distinctive placeholder values: if one reaches a log, the assertion below proves it. */
const CLERK_SECRET = 'sk_test_placeholder_clerk_secret_not_real';
const OPENAI_KEY = 'sk-test-placeholder-openai-key-not-real';

/** A complete production configuration, so each test varies exactly one field. */
function productionConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    wsPath: '/ws',
    nodeEnv: 'production',
    authMode: 'clerk',
    corsOrigin: PRODUCTION_ORIGIN,
    dataPath: PRODUCTION_DATA_PATH,
    ...overrides,
  };
}

/** A production environment that satisfies every rule, so each test varies one variable. */
function productionEnv(overrides: StartupEnvironment = {}): StartupEnvironment {
  return {
    AUTH_MODE: 'clerk',
    CLERK_SECRET_KEY: CLERK_SECRET,
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: OPENAI_KEY,
    ...overrides,
  };
}

/* ---------------------------------------------------------------- *
 * Pure function — every rejection code, the valid case, the dev regression
 * ---------------------------------------------------------------- */

describe('findStartupRefusal — production configuration (M4 B3)', () => {
  it('refuses demo auth in production (DEMO_AUTH_IN_PRODUCTION)', () => {
    const refusal = findStartupRefusal(productionConfig({ authMode: 'demo' }), {
      AUTH_MODE: 'demo',
    });
    assert.equal(refusal?.code, 'DEMO_AUTH_IN_PRODUCTION');
  });

  it('refuses an unknown AUTH_MODE (AUTH_MODE_INVALID), not silently as demo', () => {
    // `loadConfig` maps unknown values to demo; the gate inspects the raw variable so the
    // operator is told the value is unsupported instead of being told demo is banned. A padded
    // `clerk` is still clerk (the raw value is trimmed, like every other selector).
    const refusal = findStartupRefusal(productionConfig({ authMode: 'demo' }), {
      AUTH_MODE: 'clerk-ish',
    });
    assert.equal(refusal?.code, 'AUTH_MODE_INVALID');

    assert.equal(
      findStartupRefusal(productionConfig(), { AUTH_MODE: 'unexpected' })?.code,
      'AUTH_MODE_INVALID',
    );
  });

  it('refuses clerk mode without a secret key (CLERK_SECRET_KEY_MISSING)', () => {
    assert.equal(findStartupRefusal(productionConfig(), {})?.code, 'CLERK_SECRET_KEY_MISSING');
    assert.equal(
      findStartupRefusal(productionConfig(), { CLERK_SECRET_KEY: '   ' })?.code,
      'CLERK_SECRET_KEY_MISSING',
    );
  });

  it('refuses a development or non-https CORS origin (CORS_ORIGIN_INVALID)', () => {
    const auth = { AUTH_MODE: 'clerk', CLERK_SECRET_KEY: CLERK_SECRET } as const;

    // Missing: `loadConfig` resolves the development default, which is exactly what the
    // production gate must refuse.
    assert.equal(
      findStartupRefusal(loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'clerk' }), auth)?.code,
      'CORS_ORIGIN_INVALID',
    );

    for (const corsOrigin of [
      DEFAULT_CORS_ORIGIN,
      '',
      'http://app.insighthub.example',
      'app.insighthub.example',
      'https://',
    ]) {
      assert.equal(
        findStartupRefusal(productionConfig({ corsOrigin }), auth)?.code,
        'CORS_ORIGIN_INVALID',
        `CORS origin ${JSON.stringify(corsOrigin)} must be refused`,
      );
    }
  });

  it('refuses a missing, default or relative data path (DATA_PATH_INVALID)', () => {
    const env = productionEnv();

    // Missing resolves to the development default through `loadConfig`. The CORS origin is
    // valid here so the data-path rule is the first one that fires.
    assert.equal(
      findStartupRefusal(
        loadConfig({
          NODE_ENV: 'production',
          AUTH_MODE: 'clerk',
          CORS_ORIGIN: PRODUCTION_ORIGIN,
        }),
        env,
      )?.code,
      'DATA_PATH_INVALID',
    );

    for (const dataPath of [DEFAULT_DATA_PATH, '', '   ', './relative-data', 'data']) {
      assert.equal(
        findStartupRefusal(productionConfig({ dataPath }), env)?.code,
        'DATA_PATH_INVALID',
        `data path ${JSON.stringify(dataPath)} must be refused`,
      );
    }

    // An absolute path is accepted regardless of platform shape (`join(tmpdir(), …)`).
    assert.equal(findStartupRefusal(productionConfig(), env), null);
  });

  it('refuses the deterministic AI stub (AI_PROVIDER_STUB_FORBIDDEN)', () => {
    for (const aiProvider of ['stub', 'STUB', '  Stub  ']) {
      assert.equal(
        findStartupRefusal(productionConfig(), productionEnv({ AI_PROVIDER: aiProvider }))?.code,
        'AI_PROVIDER_STUB_FORBIDDEN',
      );
    }
  });

  it('refuses openai without a key (OPENAI_API_KEY_MISSING)', () => {
    for (const apiKey of [undefined, '', '   ']) {
      assert.equal(
        findStartupRefusal(
          productionConfig(),
          productionEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: apiKey }),
        )?.code,
        'OPENAI_API_KEY_MISSING',
      );
    }
  });

  it('refuses an unknown AI_PROVIDER (AI_PROVIDER_INVALID)', () => {
    for (const aiProvider of ['gpt-5.6-luna', 'openai2', 'local', 'true']) {
      assert.equal(
        findStartupRefusal(productionConfig(), productionEnv({ AI_PROVIDER: aiProvider }))?.code,
        'AI_PROVIDER_INVALID',
      );
    }
  });

  it('does not refuse a complete production configuration', () => {
    assert.equal(findStartupRefusal(productionConfig(), productionEnv()), null);

    // The documented off states: unset and the explicit `disabled` value.
    assert.equal(
      findStartupRefusal(
        productionConfig(),
        productionEnv({ AI_PROVIDER: undefined, OPENAI_API_KEY: undefined }),
      ),
      null,
    );
    assert.equal(
      findStartupRefusal(productionConfig(), productionEnv({ AI_PROVIDER: 'disabled' })),
      null,
    );
    // Case/whitespace-insensitive, matching `ai/openai.ts`.
    assert.equal(
      findStartupRefusal(productionConfig(), productionEnv({ AI_PROVIDER: ' OpenAI ' })),
      null,
    );
  });

  it('applies none of the production rules when NODE_ENV is not production', () => {
    // The same broken combination that is refused above must start in dev/test: demo auth, the
    // localhost origin, the development data path and the stub are all the normal dev setup.
    const development = loadConfig({ NODE_ENV: 'development', AUTH_MODE: 'demo' });
    assert.equal(findStartupRefusal(development, { AI_PROVIDER: 'stub' }), null);

    const testEnv = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'demo' });
    assert.equal(findStartupRefusal(testEnv, { AI_PROVIDER: 'stub' }), null);

    // No NODE_ENV at all is development (`CONTRACTS.md` §18.6; D-082 D2).
    const unset = loadConfig({ AUTH_MODE: 'demo' });
    assert.equal(unset.nodeEnv, undefined);
    assert.equal(
      findStartupRefusal(unset, {
        AUTH_MODE: 'demo',
        AI_PROVIDER: 'stub',
      }),
      null,
    );
    // Even a *relative* data path and a non-https origin are fine outside production.
    assert.equal(
      findStartupRefusal(
        { ...unset, corsOrigin: 'http://localhost:5173', dataPath: './.insighthub-data' },
        { AI_PROVIDER: 'stub' },
      ),
      null,
    );
  });

  it('keeps the B2 clerk-secret guard outside production', () => {
    // Preserved, not new: a clerk server that cannot verify anything is misconfigured in any
    // environment, so this refusal is not production-gated.
    const development = loadConfig({ NODE_ENV: 'development', AUTH_MODE: 'clerk' });
    assert.equal(
      findStartupRefusal(development, { AUTH_MODE: 'clerk' })?.code,
      'CLERK_SECRET_KEY_MISSING',
    );
  });

  it('never puts a configured value in the refusal message', () => {
    const refusals = [
      findStartupRefusal(productionConfig({ authMode: 'demo' }), {
        AUTH_MODE: 'demo',
      }),
      findStartupRefusal(productionConfig({ authMode: 'demo' }), { AUTH_MODE: 'unexpected' }),
      findStartupRefusal(productionConfig(), {}),
      findStartupRefusal(productionConfig({ corsOrigin: 'http://insecure.example:5173' }), {
        AUTH_MODE: 'clerk',
        CLERK_SECRET_KEY: CLERK_SECRET,
      }),
      findStartupRefusal(productionConfig({ dataPath: './ephemeral-data' }), productionEnv()),
      findStartupRefusal(productionConfig(), productionEnv({ AI_PROVIDER: 'stub' })),
      findStartupRefusal(productionConfig(), productionEnv({ OPENAI_API_KEY: undefined })),
      findStartupRefusal(
        productionConfig(),
        productionEnv({ AI_PROVIDER: 'gpt-5.6-luna' }),
      ),
    ];

    for (const refusal of refusals) {
      assert.ok(refusal !== null, 'each case must refuse');
      for (const value of [
        CLERK_SECRET,
        OPENAI_KEY,
        'insecure.example',
        'ephemeral-data',
        'gpt-5.6-luna',
        'unexpected',
      ]) {
        assert.ok(
          !refusal.message.includes(value),
          `the refusal for ${refusal.code} leaked the configured value ${JSON.stringify(value)}`,
        );
      }
    }
  });
});

/* ---------------------------------------------------------------- *
 * Real process — exit code 1, stable code on stderr, no value leaked
 * ---------------------------------------------------------------- */

interface SubprocessRejectionCase {
  readonly code: StartupRefusalCode;
  readonly overrides: Readonly<Record<string, string | undefined>>;
  /** Values that must not appear in either stream (secrets and rejected values). */
  readonly forbidden: readonly string[];
}

/**
 * One case per rejection code. `overrides` is applied to a complete, valid production
 * environment, so each child fails for exactly the rule under test and not an earlier one.
 */
const SUBPROCESS_CASES: readonly SubprocessRejectionCase[] = [
  {
    code: 'DEMO_AUTH_IN_PRODUCTION',
    overrides: { AUTH_MODE: 'demo' },
    forbidden: [CLERK_SECRET, OPENAI_KEY],
  },
  {
    code: 'AUTH_MODE_INVALID',
    overrides: { AUTH_MODE: 'clerk-ish' },
    forbidden: [CLERK_SECRET, OPENAI_KEY, 'clerk-ish'],
  },
  {
    code: 'CLERK_SECRET_KEY_MISSING',
    overrides: { CLERK_SECRET_KEY: undefined },
    forbidden: [OPENAI_KEY],
  },
  {
    code: 'CORS_ORIGIN_INVALID',
    overrides: { CORS_ORIGIN: 'http://insecure.example:5173' },
    forbidden: [CLERK_SECRET, OPENAI_KEY, 'insecure.example'],
  },
  {
    code: 'DATA_PATH_INVALID',
    overrides: { INSIGHTHUB_DATA_PATH: './ephemeral-data' },
    forbidden: [CLERK_SECRET, OPENAI_KEY, 'ephemeral-data'],
  },
  {
    code: 'AI_PROVIDER_STUB_FORBIDDEN',
    overrides: { AI_PROVIDER: 'stub' },
    forbidden: [CLERK_SECRET, OPENAI_KEY],
  },
  {
    code: 'OPENAI_API_KEY_MISSING',
    overrides: { AI_PROVIDER: 'openai', OPENAI_API_KEY: undefined },
    forbidden: [CLERK_SECRET],
  },
  {
    code: 'AI_PROVIDER_INVALID',
    overrides: { AI_PROVIDER: 'gpt-5.6-luna' },
    forbidden: [CLERK_SECRET, OPENAI_KEY, 'gpt-5.6-luna'],
  },
];

/** The absolute server package root (`apps/server/`), independent of the test runner's cwd. */
const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The production environment the entrypoint is spawned with, before one-field overrides. */
function childEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '0',
    AUTH_MODE: 'clerk',
    CLERK_SECRET_KEY: CLERK_SECRET,
    // Public and not part of the gate; blank keeps the startup warning quiet and Clerk uncontacted.
    CLERK_PUBLISHABLE_KEY: '',
    VITE_CLERK_PUBLISHABLE_KEY: '',
    CORS_ORIGIN: PRODUCTION_ORIGIN,
    INSIGHTHUB_DATA_PATH: PRODUCTION_DATA_PATH,
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: OPENAI_KEY,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

describe('production entrypoint — real process (M4 B3)', () => {
  for (const testCase of SUBPROCESS_CASES) {
    it(`exits 1 with ${testCase.code}, before listening, without printing a value`, () => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: SERVER_ROOT,
        env: childEnvironment(testCase.overrides),
        encoding: 'utf8',
        timeout: 30_000,
      });

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';

      assert.equal(
        result.status,
        1,
        `expected exit code 1 for ${testCase.code}\nstdout=${stdout}\nstderr=${stderr}`,
      );
      assert.match(
        stderr,
        new RegExp(`refusing to start: ${testCase.code}`),
        `the stable code must be printed for ${testCase.code}`,
      );
      assert.doesNotMatch(stdout, /http\s+ready/, 'the server must not have listened');

      for (const forbidden of testCase.forbidden) {
        assert.ok(
          !stdout.includes(forbidden),
          `stdout leaked ${JSON.stringify(forbidden)} on ${testCase.code}`,
        );
        assert.ok(
          !stderr.includes(forbidden),
          `stderr leaked ${JSON.stringify(forbidden)} on ${testCase.code}`,
        );
      }
    });
  }
});
