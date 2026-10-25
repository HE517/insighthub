# Flake log

Every observed flake gets one line here when it is first seen, with the evidence that it was a
flake rather than a product failure. A PASS that never flaked is stronger evidence than one that
did, and a reader must be able to tell which is which without digging through chat history.

| Date | Commit | Scenario / test | Symptom | Rerun | Classification |
| --- | --- | --- | --- | --- | --- |
| 2026-10-22 | `0d1b30d` | `f1/1-viewer-is-read-only-and-not-remounted` | editor probe not attached after 9.4 s (`cmEditorCount:0`) | full suite 73/73 PASS (`1807ea1`); filtered rerun 1/1 PASS | **closed at the observed rate**: 3/3 green since; cause not isolated, so a future red is still plausible |
| 2026-10-22 | `0d1b30d` | `m3/5-ai-proposal-and-accept` | editor text contained markers from earlier scenarios before Generate (cross-scenario state leak) | full suite 73/73 PASS (`1807ea1`); filtered runs 1/1 PASS twice consecutively (`1807ea1`) | **open (not reproduced)**: 3 green runs since, but the leak path was never identified, so the guard is empirical only |
| 2026-10-25 | `39854d4` | `origin-http.test.ts` (server) | one transient `fetch failed` in `bootstrapSessionCookie` | same command rerun: 500/500 PASS (`39854d4`, `1807ea1`) | harness/network transient, **open** — recorded instead of being called "flaky but fine" |

## Rules

- A flake is recorded even when the rerun is green. "Green the second time" is the definition of a
  flake, not proof that the first failure did not happen.
- The **rerun result** column says what was actually run, not what should have been run.
- A flake with no identified cause stays `open`; closing it requires either a deterministic fix
  with a regression test, or a recorded reason why the failure cannot affect the claim citing it.
- These entries do not change any PASS/FAIL elsewhere; they qualify how strong that PASS is.
