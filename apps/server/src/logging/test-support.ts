/**
 * Test support for the structured-logging suites (M4 B9).
 *
 * A sink that records **exactly** the lines a real process would have written, plus the two
 * helpers every assertion needs: parse a line as one JSON object, and select events by name.
 *
 * Not a `*.test.ts` file, so the runner does not execute it (same convention as
 * `apps/server/src/authz/test-support.ts`).
 */
import assert from 'node:assert/strict';

import type { LogLevel, LogSink } from './logger.js';

export interface CapturedLine {
  readonly line: string;
  readonly level: LogLevel;
}

export interface LogCapture {
  readonly sink: LogSink;
  readonly lines: CapturedLine[];
  /** Every captured line joined by newline, for `doesNotContain` assertions. */
  readonly text: string;
  /** The parsed JSON records (throws if any line is not one JSON object). */
  records(): Record<string, unknown>[];
  /** The parsed records whose `event` is `event`. */
  events(event: string): Record<string, unknown>[];
}

/** Record emitted lines in memory. */
export function captureLogs(): LogCapture {
  const lines: CapturedLine[] = [];
  return {
    sink: {
      write(line: string, level: LogLevel): void {
        lines.push({ line, level });
      },
    },
    lines,
    get text() {
      return lines.map((captured) => captured.line).join('\n');
    },
    records(): Record<string, unknown>[] {
      return lines.map((captured, index) => {
        let value: unknown;
        try {
          value = JSON.parse(captured.line);
        } catch {
          assert.fail(`line ${index} is not JSON: ${captured.line}`);
        }
        assert.equal(typeof value, 'object', `line ${index} is not an object: ${captured.line}`);
        assert.notEqual(value, null);
        assert.equal(Array.isArray(value), false, `line ${index} is not one JSON object`);
        return value as Record<string, unknown>;
      });
    },
    events(event: string): Record<string, unknown>[] {
      return this.records().filter((record) => record['event'] === event);
    },
  };
}
