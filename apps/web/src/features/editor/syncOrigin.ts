/**
 * The marker that identifies an editor change as *derived from `Y.Text`*.
 *
 * ## Why this cannot just be "the binding did it"
 *
 * The binding drives the editor surface, and the surface reports editor changes
 * back to the binding. Without a way to tell the two directions apart, an editor
 * update raised by a reconcile looks exactly like a user keystroke, and the
 * surface reports it as a local edit — which the binding then writes back into
 * `Y.Text` as a *new*, undo-tracked change.
 *
 * That is not a theoretical hazard. `session.undo()` mutates `Y.Text`; the editor
 * follows; the change is misread as local; `flushLocalEdits()` immediately
 * reinserts the text that was just undone. Undo would appear to work once and
 * then never again, and every remote update would pollute the local undo stack.
 *
 * ## Shape
 *
 * A plain `symbol`, deliberately not a CodeMirror annotation: the binding must not
 * import CodeMirror (`EditorView` cannot even be constructed outside a DOM). The
 * CodeMirror adapter converts this sentinel into a real annotation
 * (`codeMirrorSurface.ts`), and this module is the only thing both sides share —
 * so the dependency direction stays `adapter → marker ← binding`.
 */
export const REMOTE_SYNC_ORIGIN: unique symbol = Symbol('insighthub.remote-sync');
