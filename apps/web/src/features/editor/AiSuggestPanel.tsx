/**
 * The AI proposal panel: instruction → proposal → **Diff Preview** → Accept / Reject.
 *
 * ## What this component is responsible for (and what it is not)
 *
 * It is the human-review half of the M3 loop (`docs/DECISIONS.md` D-075 §3). It renders a proposal
 * that A4's orchestration layer produced, shows the unified diff A4 computed, and — only when the
 * user explicitly accepts — calls `applySuggestion`. It owns **no document text**:
 *
 * | state | where it lives |
 * | --- | --- |
 * | document body | `session.text` (`Y.Text`), the only source of truth (R11) |
 * | the proposal, its diff, the UI phase | this component's React state — a proposal is not state (D-075 §3.2) |
 * | the revision counter | `createLocalRevisionTracker(session.doc)` (the A0-approved exception) |
 * | whether Accept is allowed | `capabilityGate` (`gate.capabilities.canEdit`) |
 *
 * `readDocumentText(session)` is called at Generate time and the string is passed straight into
 * `AiSuggestInput`. It is never assigned to state: a `text` field here would be the mirrored body
 * that R11 forbids, and it would go stale the moment a collaborator typed.
 *
 * ## The three states the brief calls out
 *
 * `generating` / `error` / *no proposal* are distinct, visible states (`data-phase` on the section,
 * `data-testid="ai-status"` text, and the `ai-empty` / `ai-stale` markers). "Empty suggestion" is
 * not a returned value in this design: both providers throw/reject with a typed reason instead of
 * inventing an empty diff (the local one `no-change`, see `features/ai/localProvider.ts`; the
 * remote one a `RemoteProviderError`), so what the user sees is an explanation, never a blank
 * preview.
 *
 * ## Two provider modes, one review surface (M3 round 2, D-080)
 *
 * `createAiProvider()` below selects the deterministic local provider by default, or the remote
 * provider that calls `POST /api/ai/suggest` when `VITE_AI_PROVIDER=remote`. The proposal, diff,
 * Accept/Reject and abort path are identical in both modes — only the source of the draft changes,
 * and anchoring/diffing/validation are still local. Remote mode hides the local intent chips:
 * `uppercase` / `add-todo` are the deterministic provider's private instruction syntax, not
 * natural language, so leaving them on screen would seed an instruction the endpoint cannot honour.
 *
 * ## Cancellation (R9)
 *
 * Every Generate aborts the previous request before starting a new one, and closing the panel
 * aborts the in-flight one. A late resolution is ignored twice: the provider itself checks the
 * signal, and this component re-checks `signal.aborted` before touching state, so a cancelled
 * request can never resurrect a proposal the user already dismissed.
 *
 * ## The read-only directory (M3 round 2, `docs/DECISIONS.md` D-078 §4 R2-1)
 *
 * `AiDirectory` sits in a right rail beside the review surface and lists the documents the current
 * identity may read. It calls the already-implemented `listDocuments(signal)` on mount (i.e.
 * whenever the panel opens) and on Refresh, and aborts on unmount. Selecting another document
 * calls `onSelectDocument`, which the workspace wires to the **existing** `documentSelected`
 * action:
 * no new route, no new action, and **no cross-document proposal/apply semantics**. The proposal
 * below always belongs to the active document. Because `App.tsx` keys the workspace by
 * `documentId`, the switch remounts the workspace and closes this panel — that is the intended
 * lifecycle, not a bug to route around.
 *
 * ## Why the panel is mounted only while open
 *
 * `[data-testid="ai-panel"]` therefore means "the panel is open", not "the panel exists but is
 * hidden" — a test (or a user) cannot mistake a closed panel for an open one. The cost is that
 * closing discards the proposal, which is the honest behaviour for a review surface whose premise
 * (a live revision counter) is scoped to the proposal's lifetime.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  AiEditSuggestion,
  CollaborativeSession,
  ValidationFailureReason,
} from '@insighthub/shared';

import { applySuggestion } from '../ai/apply.js';
import { createAiProvider, readAiProviderMode, type AiProviderMode } from '../ai/aiProvider.js';
import { LOCAL_INTENTS, type LocalIntent } from '../ai/localProvider.js';
import type { AiProvider, AiSuggestInput } from '../ai/provider.js';
import { isRemoteAiProvider } from '../ai/remoteProvider.js';
import { createLocalRevisionTracker, type LocalRevisionTracker } from '../ai/revision.js';
import { readDocumentText } from '../ai/tools.js';
import type { CapabilityGate } from '../permissions/capabilityGate.js';
import { AiDirectory } from './AiDirectory.js';
import {
  AI_PANEL_PROVIDER_COPY,
  APPLY_FAILURE_COPY,
  describeProviderFailure,
  type ProviderFailureCopy,
} from './aiProposalCopy.js';

/**
 * The configured provider (`aiProvider.ts`, `docs/DECISIONS.md` D-080).
 *
 * `createAiProvider()` reads `VITE_AI_PROVIDER` and returns either the deterministic local
 * provider (default) or the remote provider that calls `POST /api/ai/suggest`. The mode is read
 * once at module load for the same reason: it is build-time configuration, not runtime state.
 * The component also accepts a `provider`/`providerMode` pair, so a test or a future runtime
 * switch can inject one without changing the default.
 */
const defaultProviderMode = readAiProviderMode();
const defaultProvider = createAiProvider({ mode: defaultProviderMode });

/** Where the panel is in the generation/review lifecycle. Rendered as `data-phase`. */
type PanelPhase =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'proposal' }
  | { kind: 'stale'; reason: ValidationFailureReason }
  | { kind: 'applied' }
  | { kind: 'rejected' }
  | { kind: 'error'; failure: ProviderFailureCopy };

/** Hover text for each chip; the chip *label* is the literal instruction, so it is what you type. */
const INTENT_HINTS: Readonly<Record<LocalIntent, string>> = {
  uppercase: 'Uppercase the selection, or the whole document.',
  'trim-trailing-space': 'Remove trailing spaces from each selected line, or the whole document.',
  'add-todo': 'Prefix each selected non-blank line with "- [ ] " (a Markdown task).',
  'replace-selection': 'Replace the selection with the text you type after the colon.',
  'delete-selection': 'Delete the selection.',
};

export interface AiSuggestPanelProps {
  /** An `active` session; the caller narrows `CollaborativeSessionResult` first. */
  session: CollaborativeSession;
  /** The one permission decision (`capabilityGate`); Accept is gated on `canEdit`. */
  gate: CapabilityGate;
  /**
   * Read-only access to the editor's current selection, or `null` when the editor is not mounted.
   * The panel never writes the selection and never talks to CodeMirror directly.
   */
  readSelection: () => { anchor: number; head: number } | null;
  /** Close the panel. The panel aborts any in-flight generation before calling this. */
  onClose: () => void;
  /**
   * Open another readable document. Wired by the workspace to the existing `documentSelected`
   * action; the panel itself never dispatches and never owns routing.
   */
  onSelectDocument: (documentId: string) => void;
  /** Test seam / future real provider. Defaults to the provider selected by the factory. */
  provider?: AiProvider;
  /**
   * Which provider the panel is talking to.
   *
   * Omitted means: infer remote from a provider created by `createRemoteProvider`, otherwise use
   * the compile-time `VITE_AI_PROVIDER` mode. Remote mode hides the local intent chips (they are
   * the deterministic provider's instruction syntax) and swaps the local-only copy; every testid
   * and the abort discipline stay identical.
   */
  providerMode?: AiProviderMode;
}

export function AiSuggestPanel({
  session,
  gate,
  readSelection,
  onClose,
  onSelectDocument,
  provider = defaultProvider,
  providerMode,
}: AiSuggestPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<AiEditSuggestion | null>(null);
  const [staleReason, setStaleReason] = useState<ValidationFailureReason | null>(null);
  const [phase, setPhase] = useState<PanelPhase>({ kind: 'idle' });

  /**
   * The revision counter, created once the panel is mounted.
   *
   * It is state, not a render-time ref, so the StrictMode double-mount (create → dispose → create)
   * disposes the intermediate tracker instead of leaking its `doc.on('update')` subscription.
   * `useLayoutEffect` rather than `useEffect` for one reason: a *painted* Generate button must
   * never be disabled "preparing". Generation needs a counter that is already listening, and a
   * layout effect runs before the browser paints, so the first frame the user (or a browser test)
   * can click already has one.
   */
  const [tracker, setTracker] = useState<LocalRevisionTracker | null>(null);
  useLayoutEffect(() => {
    const created = createLocalRevisionTracker(session.doc);
    setTracker(created);
    return () => created.dispose();
  }, [session]);

  /** The in-flight request, so a regenerate or a close can cancel it (R9). */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  const canRead = gate.capabilities.canRead;
  const canEdit = gate.capabilities.canEdit;
  const generating = phase.kind === 'generating';
  // Explicit mode wins; an injected provider from `createRemoteProvider` identifies itself; the
  // remaining case is the build-time `VITE_AI_PROVIDER` selection.
  const resolvedProviderMode =
    providerMode ?? (isRemoteAiProvider(provider) ? 'remote' : defaultProviderMode);
  const providerCopy = AI_PANEL_PROVIDER_COPY[resolvedProviderMode];
  const showLocalIntents = resolvedProviderMode === 'local';

  const generate = useCallback((): void => {
    // The button is disabled until the counter exists; this guard covers a programmatic click.
    if (tracker === null) return;

    // Regenerate: cancel the previous request first, so exactly one resolution can win.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setProposal(null);
    setStaleReason(null);
    setPhase({ kind: 'generating' });

    // Read the document and the selection in one synchronous block: the snapshot the provider sees
    // and the live `Y.Text` its anchors are minted from must describe the same document, which is
    // exactly what `buildSuggestion` re-checks. `text` is a local const, never state.
    const text = readDocumentText(session);
    const range = readSelection();
    const selection =
      range === null
        ? undefined
        : { from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head) };

    const input: AiSuggestInput = {
      documentId: session.documentId,
      instruction,
      text,
      ...(selection === undefined ? {} : { selection }),
      baseRevision: tracker.get(),
      signal: controller.signal,
      anchorText: session.text,
    };

    void provider.suggest(input).then(
      (suggestion) => {
        // R9: a cancelled request must not resurrect a proposal.
        if (controller.signal.aborted) return;
        setProposal(suggestion);
        setPhase({ kind: 'proposal' });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: 'error', failure: describeProviderFailure(error) });
      },
    );
  }, [instruction, provider, readSelection, session, tracker]);

  const accept = useCallback((): void => {
    if (proposal === null || tracker === null) return;
    // The button is disabled in this case; the guard keeps a programmatic click from writing.
    if (!canEdit) return;

    // `currentRevision` is *now*, not the revision the proposal was generated at: the gap between
    // the two is exactly what check #1 measures. The port is the narrow `{ documentId, doc,
    // transact }` slice, so this call cannot reach awareness, Redux or the session lifecycle; the
    // `documentId` lets `applySuggestion` refuse a proposal generated for another document.
    const result = applySuggestion(
      {
        documentId: session.documentId,
        doc: session.doc,
        transact: (fn, origin) => session.transact(fn, origin),
      },
      proposal,
      tracker.get(),
    );

    if (result.ok) {
      setProposal(null);
      setStaleReason(null);
      setPhase({ kind: 'applied' });
      return;
    }

    // `applySuggestion` validates before it writes, so the document is byte-for-byte unchanged.
    // Keep the proposal on screen, marked stale: the user can see what was rejected and why, and
    // Generate is available again.
    setStaleReason(result.reason);
    setPhase({ kind: 'stale', reason: result.reason });
  }, [canEdit, proposal, session, tracker]);

  const reject = useCallback((): void => {
    // Proposal state only: this never touches `Y.Text` and never publishes awareness
    // (`docs/DECISIONS.md` D-075 §3.4).
    setProposal(null);
    setStaleReason(null);
    setPhase({ kind: 'rejected' });
  }, []);

  const close = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    onClose();
  }, [onClose]);

  const applyIntent = (intent: LocalIntent): void => {
    // `replace-selection` needs a payload, so the chip seeds the prefix and leaves the caret's work
    // to the user; every other chip is the complete instruction.
    setInstruction(intent === 'replace-selection' ? 'replace-selection: ' : intent);
  };

  const acceptDisabled = !canEdit || phase.kind !== 'proposal';
  const acceptTitle = !canEdit
    ? 'Read-only for your role'
    : phase.kind === 'stale'
      ? 'This suggestion is stale — generate a new one'
      : 'Apply this suggestion to the document';

  return (
    <section
      id="ai-panel"
      className="ai-panel"
      data-testid="ai-panel"
      data-phase={phase.kind}
      aria-label="AI proposal"
    >
      <header className="ai-panel__head">
        <div className="ai-panel__heading">
          <h2 className="ai-panel__title">Ask AI</h2>
          <p className="ai-panel__note">{providerCopy.note}</p>
        </div>
        <button
          type="button"
          className="ai-panel__close"
          aria-label="Close AI panel"
          data-testid="ai-close"
          title="Close the AI panel"
          onClick={close}
        >
          Close
        </button>
      </header>

      <div className="ai-panel__body">
        <div className="ai-panel__main">
          <label className="ai-field">
            <span className="ai-field__label">Instruction</span>
            <textarea
              className="ai-instruction"
              data-testid="ai-instruction"
              aria-label="AI instruction"
              rows={2}
              spellCheck={false}
              value={instruction}
              placeholder={providerCopy.instructionPlaceholder}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>

          {/*
        The local provider is *not* a language model: an arbitrary sentence has no meaning to it.
        So the valid instructions are visible, clickable chips rather than documentation elsewhere.

        In remote mode this intent vocabulary does not exist — the endpoint takes natural
        language — so the chips are hidden rather than left as instructions that would fail.
      */}
          {showLocalIntents ? (
            <div className="ai-chips" role="group" aria-label="Supported instructions">
              {LOCAL_INTENTS.map((intent) => (
                <button
                  key={intent}
                  type="button"
                  className="ai-chip"
                  data-testid="ai-intent"
                  data-intent={intent}
                  title={INTENT_HINTS[intent]}
                  onClick={() => applyIntent(intent)}
                >
                  {intent === 'replace-selection' ? 'replace-selection: <text>' : intent}
                </button>
              ))}
            </div>
          ) : null}

          <div className="ai-actions">
            <button
              type="button"
              className="ai-primary"
              data-testid="ai-generate"
              aria-label="Generate suggestion"
              disabled={!canRead || tracker === null}
              title={
                !canRead
                  ? 'Your role may not read this document'
                  : tracker === null
                    ? 'Preparing the revision counter…'
                    : 'Generate a proposal from the current document and selection'
              }
              onClick={generate}
            >
              {generating ? 'Regenerating…' : 'Generate'}
            </button>
            <span className="ai-actions__hint">
              Target: the current selection, or the whole document when nothing is selected.
            </span>
          </div>

          <p
            className="ai-status"
            data-testid="ai-status"
            role="status"
            aria-live="polite"
            {...(phase.kind === 'error' ? { 'data-provider-error': phase.failure.kind } : {})}
          >
            {statusTextFor(phase)}
          </p>

          {proposal === null ? (
            <p className="ai-empty" data-testid="ai-empty">
              {emptyCopyFor(phase, resolvedProviderMode)}
            </p>
          ) : (
            <article
              className="ai-proposal"
              data-testid="ai-proposal"
              data-status={phase.kind === 'stale' ? 'stale' : 'pending'}
              data-base-revision={proposal.baseRevision}
            >
              <h3 className="ai-proposal__summary" data-testid="ai-summary">
                {proposal.summary}
              </h3>
              {/*
            The diff is rendered verbatim — it was computed by `unifiedDiff` inside the suggestion
            (A4). The panel must not recompute it: the authority for what gets applied is the
            operations + anchors, and a second diff could disagree with the preview.
          */}
              <pre
                className="ai-diff"
                data-testid="ai-diff"
                aria-label="Unified diff preview"
                tabIndex={0}
              >
                {proposal.diff}
              </pre>

              {staleReason === null ? null : (
                <p
                  className="ai-stale"
                  data-testid="ai-stale"
                  data-reason={staleReason}
                  role="alert"
                >
                  {APPLY_FAILURE_COPY[staleReason]}
                </p>
              )}

              <div className="ai-proposal__actions">
                <button
                  type="button"
                  className="ai-accept"
                  data-testid="ai-accept"
                  aria-label="Accept suggestion"
                  disabled={acceptDisabled}
                  title={acceptTitle}
                  onClick={accept}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="ai-reject"
                  data-testid="ai-reject"
                  aria-label="Reject suggestion"
                  title="Dismiss this suggestion without changing the document"
                  onClick={reject}
                >
                  Reject
                </button>
              </div>
            </article>
          )}
        </div>

        {/*
        Read-only directory (D-078 §4 R2-1), in a **right rail** beside the review surface.

        Placement is load-bearing. The permanent browser suite clicks the panel's controls by
        viewport coordinates; increasing the panel's height pushes the editor below the fold, so
        typing schedules a page scroll that can race the next click (measured: the Accept click
        landed on this section at `scrollY: 35`). A rail keeps the panel's outer height governed by
        the main column — the same geometry the existing scenarios were written against — while the
        directory still lists, refreshes and aborts independently.

        It fetches on mount (when the panel opens) and aborts on unmount. Selecting a different
        document goes through the existing switch action, which remounts the workspace — and
        therefore closes this panel — by design.
      */}
        <AiDirectory activeDocumentId={session.documentId} onSelectDocument={onSelectDocument} />
      </div>
    </section>
  );
}

/** The one-line state announcement (`ai-status`). Never claims the document changed unless it did. */
function statusTextFor(phase: PanelPhase): string {
  switch (phase.kind) {
    case 'idle':
      return 'No proposal yet.';
    case 'generating':
      return 'Generating a proposal…';
    case 'proposal':
      return 'Proposal ready — the document is unchanged until you accept.';
    case 'stale':
      return 'This suggestion is stale and was not applied. The document is unchanged.';
    case 'applied':
      return 'Suggestion applied through a Yjs transaction. Use Undo to revert it.';
    case 'rejected':
      return 'Suggestion dismissed — the document is unchanged.';
    case 'error':
      return phase.failure.title;
  }
}

/** The empty-preview copy: "nothing to review" has a reason, and the reason is shown. */
function emptyCopyFor(phase: PanelPhase, providerMode: AiProviderMode): string {
  switch (phase.kind) {
    case 'generating':
      return 'Generating…';
    case 'applied':
      return 'Applied. Generate another proposal to keep going.';
    case 'rejected':
      return 'Dismissed. Nothing was written to the document.';
    case 'error':
      return 'Nothing to review. Adjust the instruction and generate again.';
    case 'stale':
      // Unreachable in practice (a stale failure keeps the proposal), but honest if it ever is.
      return 'Nothing to review. Generate a new proposal.';
    case 'idle':
    case 'proposal':
      // The idle hint points at the affordance that exists: chips in local mode, free-form text
      // for a remote model. It never claims a chip the panel is not showing.
      return AI_PANEL_PROVIDER_COPY[providerMode].idleEmpty;
  }
}
