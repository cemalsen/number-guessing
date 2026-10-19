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

/* ---------------- focus across a rebuild ----------------
 *
 * The lobby and the header chip are also rebuilt (each <ul> is emptied and its
 * rows recreated), and they contain buttons rather than inputs, so
 * snapshotInputs() does not cover them. A player who has tabbed to Invite /
 * Accept / Cancel / Open loses their place on any refresh — and refreshes are
 * not rare: `lobby.updated` is broadcast on every registration.
 *
 * A control that must survive declares a stable `data-focus-key`; the key (not
 * the node) is what carries across the swap. Key lookup is injected so this
 * stays testable without a DOM, and so focus is never stolen when nothing had
 * it. */

/**
 * The focus key of the currently focused element, if it declared one.
 * @param {*} activeElement  document.activeElement before the rebuild
 * @returns {string|null}
 */
export function snapshotFocus(activeElement) {
  return activeElement?.dataset?.focusKey ?? null;
}

/**
 * Give focus back to the control recreated under the same key.
 * @param {string|null} key  from snapshotFocus()
 * @param {(key: string) => (*)} getByKey
 */
export function restoreFocus(key, getByKey) {
  if (!key) return; // nothing was focused: do not grab the keyboard
  getByKey(key)?.focus?.();
}

/**
 * Find a keyed control inside a rebuilt subtree by its data-focus-key.
 * Reads the attribute instead of building a selector, so keys never need
 * escaping, and works for any container.
 * @param {*} root  element whose descendants carry data-focus-key
 */
export function focusLookup(root) {
  return (key) =>
    [...(root?.querySelectorAll("[data-focus-key]") ?? [])].find(
      (el) => el.dataset.focusKey === key
    ) ?? null;
}

/* ---------------- single-flight submits ----------------
 *
 * A submit used to disable the button node the click came from. That node is
 * replaced by the next re-render, so the replacement was enabled again while
 * the request was still in flight, and `btn.disabled = false` in a finally
 * block wrote to a detached node. The lock keeps "a submit is running" in
 * JavaScript instead: the re-render reads it and renders the buttons disabled,
 * and a second call is dropped rather than racing the first.
 *
 * `onChange` lets the app reflect the state onto whatever controls exist right
 * now (the register button is static markup and never re-rendered). */
export function createSubmitLock(onChange = () => {}) {
  let running = false;
  // The callback only mirrors state onto the DOM. A throw there must not strand
  // `running` (a stuck lock silently drops every later submit) nor mask what fn
  // did, so it is best-effort in both directions.
  const notify = () => {
    try {
      onChange();
    } catch {
      /* reflecting state is best-effort */
    }
  };
  return {
    get pending() {
      return running;
    },
    /** Run `fn`, or return undefined if a submit is already running. */
    async run(fn) {
      if (running) return undefined;
      running = true;
      try {
        notify();
        return await fn();
      } finally {
        running = false;
        notify();
      }
    },
  };
}
