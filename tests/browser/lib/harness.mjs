/**
 * Scenario registry, assertions and reporting for the A6 browser suite.
 *
 * Design rules that matter for the report being trustworthy:
 *
 * - A scenario records **evidence** (`note(...)`) and its own assertions. A failure
 *   keeps the evidence, so a defect report can quote the measurement that proved it.
 * - Failures are never swallowed: one failing scenario does not stop the run, but
 *   the process exit code is non-zero.
 * - Nothing is retried. A deterministic failure must stay a failure
 *   (`docs/TASKS.md` M1-A6 and the A6 task brief both forbid masking it).
 * - A scenario may be tagged with `knownDefect: 'P0-1'`. That does **not** make it
 *   pass: a red scenario stays red and still fails the run. The tag only lets the
 *   report separate "a pinned product defect" from "a new, unexpected regression",
 *   and flags the day the defect is fixed (the pin starts passing).
 */

/** A failed assertion inside a scenario. */
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new AssertionError(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, what) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new AssertionError(`${what}: expected ${right}, got ${left}`);
}

export function assertIncludes(haystack, needle, what) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new AssertionError(`${what}: ${JSON.stringify(haystack)} does not include ${JSON.stringify(needle)}`);
  }
}

export class Runner {
  #scenarios = [];
  #results = [];
  #notes = [];

  /** Register one scenario. `fn` receives `(context)`. */
  scenario(id, title, fn, options = {}) {
    this.#scenarios.push({
      id,
      title,
      fn,
      knownDefect: options.knownDefect ?? null,
      timeoutMs: options.timeoutMs ?? 180_000,
    });
    return this;
  }

  get scenarioCount() {
    return this.#scenarios.length;
  }

  /** Registered scenario ids, in execution order. */
  get scenarioIds() {
    return this.#scenarios.map((scenario) => `${scenario.id} — ${scenario.title}`);
  }

  /** Record an evidence line for the scenario currently running. */
  note(label, value) {
    this.#notes.push(value === undefined ? label : `${label}: ${format(value)}`);
  }

  /** Record a structured measurement. */
  measure(label, value) {
    this.#notes.push(`${label} = ${format(value)}`);
    return value;
  }

  async run({ context, filter, onResult, afterEach } = {}) {
    const selected =
      filter === undefined
        ? this.#scenarios
        : this.#scenarios.filter(
            (scenario) => scenario.id.includes(filter) || scenario.title.includes(filter),
          );

    for (const scenario of selected) {
      this.#notes = [];
      const startedAt = Date.now();
      let status = 'pass';
      let error = null;
      try {
        // A hung await inside a scenario must not stall the whole suite: the suite is
        // the evidence, and a missing scenario is a bigger problem than a timed-out
        // one. The abandoned promise is left to settle on its own.
        await withTimeout(
          scenario.fn({
            ...context,
            note: this.note.bind(this),
            measure: this.measure.bind(this),
            runner: this,
          }),
          scenario.timeoutMs,
          scenario.id,
        );
      } catch (thrown) {
        status = thrown instanceof AssertionError ? 'fail' : 'error';
        error = {
          name: thrown?.name ?? 'Error',
          message: thrown?.message ?? String(thrown),
          stack: typeof thrown?.stack === 'string' ? thrown.stack.split('\n').slice(0, 6) : [],
        };
      }
      const result = {
        id: scenario.id,
        title: scenario.title,
        status,
        durationMs: Date.now() - startedAt,
        notes: [...this.#notes],
        error,
        knownDefect: scenario.knownDefect,
      };
      this.#results.push(result);
      onResult?.(result);
      // Always run the isolation hook, even when the scenario threw: a scenario that
      // stopped the backend must not leave it down for the next one.
      await afterEach?.(result);
    }

    return this.#results;
  }

  get results() {
    return [...this.#results];
  }

  /**
   * Counts that keep the two very different kinds of red apart:
   *
   * - `failures` — scenarios that fail and are **not** a pinned defect. A new
   *   regression, or the environment is broken.
   * - `pinnedOpen` — scenarios that fail and are a pinned defect that is still open.
   * - `pinnedFixed` — a pinned defect that now passes. The pin should be removed and
   *   the defect closed.
   */
  summary() {
    const counts = { pass: 0, fail: 0, error: 0 };
    for (const result of this.#results) counts[result.status] += 1;

    const pinned = this.#results.filter((result) => result.knownDefect !== null);
    const pinnedOpen = pinned.filter((result) => result.status !== 'pass');
    const pinnedFixed = pinned.filter((result) => result.status === 'pass');
    const unexpectedFailures = this.#results.filter(
      (result) => result.status !== 'pass' && result.knownDefect === null,
    );

    return {
      total: this.#results.length,
      ...counts,
      unexpectedFailures: unexpectedFailures.length,
      pinnedOpen: pinnedOpen.map((result) => result.knownDefect),
      pinnedFixed: pinnedFixed.map((result) => result.knownDefect),
      // Green only when nothing fails at all: a pinned open defect still fails the
      // run, because the product is still broken.
      ok: counts.fail === 0 && counts.error === 0,
    };
  }
}

function format(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Race a promise against a timeout, reporting a timeout as a scenario error. */
function withTimeout(promise, timeoutMs, label) {
  if (timeoutMs === undefined || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`scenario ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Median / p95 / max of a numeric sample, with the sample size. */
export function statistics(samples) {
  if (samples.length === 0) return { count: 0, median: null, p95: null, max: null, min: null };
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction) => {
    const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
    return sorted[index];
  };
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/** Render the human-readable report the task brief asks for. */
export function renderMarkdown({ results, environment, summary }) {
  const lines = [];
  lines.push('# M1-A6 browser suite results');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  for (const [key, value] of Object.entries(environment)) {
    lines.push(`- **${key}**: ${format(value)}`);
  }
  lines.push('');
  lines.push(
    `## Scenarios — ${summary.total} total, ${summary.pass} passed, ${summary.fail} failed, ${summary.error} errored`,
  );
  lines.push('');
  lines.push(`- unexpected failures (not a pinned defect): **${summary.unexpectedFailures}**`);
  lines.push(
    `- pinned defects still open: ${summary.pinnedOpen.length === 0 ? 'none' : summary.pinnedOpen.join(', ')}`,
  );
  if (summary.pinnedFixed.length > 0) {
    lines.push(
      `- **pinned defects that now pass — remove the pin:** ${summary.pinnedFixed.join(', ')}`,
    );
  }
  lines.push('');
  for (const result of results) {
    const icon = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'ERROR';
    const pin = result.knownDefect === null ? '' : ` — pinned defect ${result.knownDefect}`;
    lines.push(`### [${icon}] ${result.id} — ${result.title}${pin}`);
    lines.push('');
    lines.push(`Duration: ${result.durationMs} ms`);
    lines.push('');
    if (result.error !== null) {
      lines.push('```text');
      lines.push(`${result.error.name}: ${result.error.message}`);
      lines.push('```');
      lines.push('');
    }
    if (result.notes.length > 0) {
      lines.push('<details><summary>evidence</summary>');
      lines.push('');
      lines.push('```text');
      for (const note of result.notes) lines.push(note);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }
  return lines.join('\n');
}
