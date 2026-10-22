/**
 * Test-only preload: emit `SIGTERM` **inside** the built server process once it is ready.
 *
 * ## Why this exists (and what it is not)
 *
 * The B10 brief requires a graceful `SIGTERM` shutdown that exits `0`. On Windows there are no
 * POSIX signals: `child.kill('SIGTERM')` is `TerminateProcess`, the `process.on('SIGTERM')`
 * handler never runs, and the child's exit is reported as `signal: 'SIGTERM'` with
 * `code: null` (measured, see `docs/agent-governance/A6-m4-production-like.md`). No Node API
 * can deliver a POSIX signal to a Windows console child, so an OS-level `SIGTERM` is not
 * verifiable on this host.
 *
 * This preload closes the **handler** half of that gap without touching production code: it
 * runs in the same real process, waits until `GET /ready` answers `200`, then calls
 * `process.emit('SIGTERM')`. That invokes the exact listener `apps/server/src/index.ts`
 * registers after `listen`, which is the same code path an OS signal would take.
 *
 * It is **not** evidence that a Windows OS signal is delivered, and the gate labels the
 * resulting check accordingly. On POSIX the gate ALSO sends a real `SIGTERM` and asserts
 * `exit 0`; this probe is only the portable fallback.
 *
 * ## Contract with the gate
 *
 * - `PORT` must be the child's fixed listen port (the gate never uses `PORT=0`: `config.ts`
 *   treats `0` as invalid and falls back to `3001`).
 * - Exit codes: the child exits `0` through the product's own `shutdown()`; this module never
 *   calls `process.exit(0)` on the success path.
 * - If `/ready` never answers, the module exits `97` with a diagnostic, so a broken probe is a
 *   loud test failure rather than a hung gate.
 * - If no `SIGTERM` listener is registered, it exits `98`. That would mean the entrypoint changed
 *   and the graceful-shutdown contract is no longer wired.
 */

const port = process.env.PORT;
if (typeof port !== 'string' || port.trim() === '') {
  console.error('a6-b10 preload: PORT is required');
  process.exit(97);
}

const deadline = Date.now() + 20_000;

async function waitForReadyAndEmit() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(1_000),
      });
      // Drain the body so the socket cannot keep the process alive after shutdown.
      await response.text();
      if (response.status === 200) {
        // The `listen` promise resolved before `/ready` can answer, and `index.ts` registers its
        // signal listeners immediately afterwards. One turn of the event loop is enough for the
        // handler to exist; the brief delay makes that ordering explicit rather than assumed.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const delivered = process.emit('SIGTERM');
        if (!delivered) {
          console.error('a6-b10 preload: no SIGTERM listener was registered');
          process.exit(98);
        }
        return;
      }
    } catch {
      // Not listening yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error('a6-b10 preload: /ready did not answer 200 before the deadline');
  process.exit(97);
}

void waitForReadyAndEmit();
