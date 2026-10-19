/* Board input preservation.

 * The game view is re-rendered by replacing the board's innerHTML, which
 * destroys and recreates every input inside it. A refresh can land while a
 * player is mid-typing — choosing your own secret is exactly when it happens,
 * because the opponent submitting their sequence pushes `game.updated` to both
 * players — so each board input's text, focus and caret position has to
 * survive the swap or the player's entry is silently erased.
 *
 * Dependency-free and DOM-light on purpose: the browser loads it as an ES
 * module from /game-inputs.js, and node:test exercises it against plain
 * objects, so this rule stays under `npm test` without a browser harness. */

/**
 * Remember the current text/focus/caret of the given inputs.
 * @param {Array} inputs  the board's inputs, read *before* the rebuild
 * @param {*} activeElement  document.activeElement at that moment
 * @returns {Array} a snapshot for restoreInputs()
 */
export function snapshotInputs(inputs, activeElement) {
  return inputs.map((el) => ({
    id: el.id,
    value: el.value,
    focused: el === activeElement,
    start: el.selectionStart,
    end: el.selectionEnd,
  }));
}

/**
 * Re-apply a snapshot to the freshly rendered inputs.
 * @param {Array} snapshot  from snapshotInputs()
 * @param {(id: string) => (*)} getById  resolves an id to the new element
 */
export function restoreInputs(snapshot, getById) {
  for (const s of snapshot) {
    const el = getById(s.id);
    // A phase change legitimately removes a field (setup -> playing); that is
    // not a lost entry, so there is nothing to restore into.
    if (!el) continue;
    if (el.value !== s.value) el.value = s.value;
    if (!s.focused) continue;
    el.focus();
    // A caret position is only meaningful on a selectable, focused input, and
    // an input without selection support (e.g. a future type change) simply
    // reports no selection at snapshot time.
    if (typeof s.start === "number" && typeof s.end === "number") {
      el.setSelectionRange(s.start, s.end);
    }
  }
}
