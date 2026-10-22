/**
 * Structured logging (M4 B9, `docs/DECISIONS.md` D-082 §5).
 *
 * ## Shape: one JSON object per line
 *
 * Every record is a single line of JSON written to a stream, with three reserved fields:
 *
 * ```json
 * {"ts":"2026-10-22T14:03:12.345Z","level":"info","event":"http.request","requestId":"…","method":"GET","path":"/health","status":200,"durationMs":0.42}
 * ```
 *
 * - `ts` — ISO 8601 timestamp (UTC), so a collector never has to infer the zone;
 * - `level` — one of {@link LogLevel}, filtered by {@link createLogger}'s level;
 * - `event` — a stable dotted name (`http.request`, `ai.suggest`, `server.config`, …), which is
 *   what dashboards and alerts branch on. **Human prose is not the contract**;
 * - everything else is context (`requestId`, `userId`, `documentId`, `outcome`, …).
 *
 * `info` and `warn` go to **stdout**, `error` to **stderr** — the split the M4 task asks for.
 * A process supervisor can therefore treat stderr as the failure channel without parsing.
 *
 * ## Why a sink is injectable
 *
 * Tests must be able to assert on **exactly** what the server emitted — including what it must
 * *not* emit (cookies, tokens, instructions, document content). A {@link LogSink} is that seam;
 * `createLogger({ sink })` writes nowhere else. Production uses the default process-stream sink.
 *
 * ## Redaction is structural, not a promise
 *
 * Two independent rules keep sensitive values out of the log:
 *
 * 1. **Callers never pass them.** No event in `apps/server/src` logs a request body, a cookie,
 *    an `Authorization` header, an AI instruction or document content. The request middleware
 *    logs only method/path/status/duration and an error *code*.
 * 2. **The serializer drops them anyway.** A field whose (normalised) name is in
 *    {@link FORBIDDEN_FIELD_NAMES} is removed from the record wherever it appears, including
 *    inside a nested object. This is defence in depth against a future call site that makes a
 *    mistake — the failure mode is "a field is missing", never "a secret is on disk".
 *
 * An `Error` instance is rendered as its class name only: a message may contain SQL, a path or
 * provider output, which the operator log is not an appropriate place for (the stable code is).
 */

/** Severity levels, lowest to highest. `LOG_LEVEL` selects the minimum emitted. */
export type LogLevel = 'info' | 'warn' | 'error';

/** The three levels, in ascending severity order. */
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];

/** Context fields attached to a logger (or to one event). Values are JSON-serialisable. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Where a formatted line goes.
 *
 * The line is already complete (including the trailing newline is the sink's choice; the
 * default sink adds one). Tests implement this with an array; production uses
 * {@link createProcessSink}.
 */
export interface LogSink {
  write(line: string, level: LogLevel): void;
}

/** The logger handed to call sites. Immutable: `child()` returns a new binding. */
export interface Logger {
  /** The minimum level this logger emits. */
  readonly level: LogLevel;
  /** Emit one event at an explicit level (filtered by {@link Logger.level}). */
  log(level: LogLevel, event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /**
   * Bind extra context (e.g. `{ requestId }`, then `{ userId }`).
   *
   * Child fields win over the parent's on a collision; the level is inherited. A child never
   * mutates its parent, so one request's `userId` cannot leak into another's lines.
   */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level. Defaults to `LOG_LEVEL` (see {@link readLogLevel}). */
  readonly level?: LogLevel;
  /** Destination. Defaults to stdout/stderr. */
  readonly sink?: LogSink;
  /** Injected clock, so a test can assert `ts` without sleeping. */
  readonly now?: () => Date;
}

/**
 * Field names that are never emitted, matched after lower-casing and removing `-`/`_`.
 *
 * Deliberately exact names, not substrings: `contentLength` (metadata) stays useful while
 * `content` (document text) is dropped. The list covers the carriers named by the M4 B9 task
 * (cookie, Authorization, request body, AI instruction/content) plus the credential vocabulary
 * the rest of the server already refuses to print.
 */
const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
  'cookie',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'body',
  'instruction',
  'content',
  'text',
  'draft',
  'proposal',
  'secret',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'credential',
  'credentials',
  'sessiontoken',
]);

/** Reserved top-level keys: caller fields cannot override them. */
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['ts', 'level', 'event']);

/** Lower-case a field name and drop separators, for the {@link FORBIDDEN_FIELD_NAMES} match. */
function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

/** True when a field must never reach the log, whatever its value. */
function isForbiddenField(name: string): boolean {
  return FORBIDDEN_FIELD_NAMES.has(normaliseFieldName(name));
}

/**
 * The `JSON.stringify` replacer that enforces redaction at serialisation time.
 *
 * - a forbidden key is **omitted** (not replaced with a placeholder: an operator does not need
 *   to know that a cookie existed, and a placeholder can still leak its length);
 * - an `Error` becomes its class name;
 * - a `bigint` becomes a string (hashes/byte counts may arrive as bigint);
 * - functions/symbols/`undefined` are omitted by JSON itself.
 */
function redactingReplacer(key: string, value: unknown): unknown {
  if (key !== '' && isForbiddenField(key)) return undefined;
  if (value instanceof Error) return { errorClass: value.name };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** The default sink: stdout for `info`/`warn`, stderr for `error`, one line each. */
export function createProcessSink(): LogSink {
  return {
    write(line: string, level: LogLevel): void {
      const stream = level === 'error' ? process.stderr : process.stdout;
      try {
        stream.write(`${line}\n`);
      } catch {
        // A closed pipe (the supervisor went away) must never take the server down. Losing a
        // log line is acceptable; crashing on diagnostics is not.
      }
    },
  };
}

/**
 * Parse `LOG_LEVEL`.
 *
 * Case-insensitive and whitespace-tolerant; anything unrecognised falls back to `info` rather
 * than silencing the server. Silence is the one failure mode an operator cannot detect, so a
 * typo must be loud-by-default (the default level is the most verbose one we have).
 */
export function readLogLevel(value: string | undefined): LogLevel {
  const normalised = (value ?? '').trim().toLowerCase();
  return normalised === 'warn' || normalised === 'error' ? normalised : 'info';
}

/** True when `candidate` is one of {@link LOG_LEVELS}. */
export function isLogLevel(candidate: unknown): candidate is LogLevel {
  return candidate === 'info' || candidate === 'warn' || candidate === 'error';
}

/** Rank used for filtering; a lower-rank level is suppressed. */
function levelRank(level: LogLevel): number {
  switch (level) {
    case 'info':
      return 0;
    case 'warn':
      return 1;
    case 'error':
      return 2;
  }
}

/**
 * A logger that emits nothing.
 *
 * Used where a request-scoped logger was not installed (a hand-built Express app in a test, or a
 * route exercised in isolation). It keeps call sites unconditional, so "logging is off" can
 * never turn into a branch that changes behaviour.
 */
export const NOOP_LOGGER: Logger = {
  level: 'error',
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

/**
 * Build a logger.
 *
 * ```ts
 * const log = createLogger();                       // level from LOG_LEVEL, process streams
 * const capture = createLogger({ sink: recorder }); // tests assert on recorder.lines
 * const scoped = log.child({ requestId });           // context is merged into every line
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? readLogLevel(process.env['LOG_LEVEL']);
  const sink = options.sink ?? createProcessSink();
  const now = options.now ?? ((): Date => new Date());
  return makeLogger(level, {}, sink, now);
}

/** Construct one immutable logger with a context binding. */
function makeLogger(
  level: LogLevel,
  context: LogFields,
  sink: LogSink,
  now: () => Date,
): Logger {
  const emit = (eventLevel: LogLevel, event: string, fields: LogFields = {}): void => {
    if (levelRank(eventLevel) < levelRank(level)) return;

    const payload: Record<string, unknown> = { ...context, ...fields };
    // Reserved keys belong to the logger, not to a call site; drop any caller copy so
    // `{ event: "..." }` in fields cannot rename the record.
    for (const key of RESERVED_FIELD_NAMES) delete payload[key];

    const entry: Record<string, unknown> = {
      ts: now().toISOString(),
      level: eventLevel,
      event,
      ...payload,
    };

    let line: string;
    try {
      line = JSON.stringify(entry, redactingReplacer);
    } catch {
      // A circular or otherwise unserialisable value must not throw into a request path. Keep
      // the correlation fields that matter and say why the payload was dropped.
      line = JSON.stringify({
        ts: entry['ts'],
        level: eventLevel,
        event,
        logError: 'unserialisable_fields',
      });
    }
    sink.write(line, eventLevel);
  };

  return {
    level,
    log: emit,
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => makeLogger(level, { ...context, ...fields }, sink, now),
  };
}
