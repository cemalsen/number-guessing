/* Regression tests for the "my typed sequence disappears" defect.
 *
 * The client rebuilds the whole game board with innerHTML on every refresh, and
 * a refresh lands mid-typing in normal play: when the opponent submits their
 * secret the server pushes `game.updated` to BOTH players (server.js
 * pushToUserIds(game.playerIds, ...)), which makes the client refetch state and
 * re-render — recreating `#input-secret` empty and erasing the digits the
 * player had typed. `restoreInputs` is what carries that entry across the swap.
 *
 * These run against a hand-rolled input stub on purpose: the project is
 * zero-dependency, so there is no jsdom to borrow. What is covered here is the
 * preservation contract itself; the client's wiring is covered by the
 * structural test at the bottom. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createSubmitLock,
  focusLookup,
  restoreFocus,
  restoreInputs,
  snapshotFocus,
  snapshotInputs,
} from "../public/game-inputs.js";

/** Minimal stand-in for an <input type=text>: value, caret, focus. */
function makeInput(id, { value = "", start = null, end = null } = {}) {
  return {
    id,
    value,
    selectionStart: start,
    selectionEnd: end,
    focused: false,
    focus() {
      this.focused = true;
    },
    setSelectionRange(s, e) {
      this.selectionStart = s;
      this.selectionEnd = e;
    },
  };
}

/** Rebuild: new inputs with the same ids, everything blank, as innerHTML does. */
function rebuild(inputs) {
  return inputs.map((el) => makeInput(el.id));
}

function indexer(inputs) {
  const byId = new Map(inputs.map((el) => [el.id, el]));
  return (id) => byId.get(id);
}

test("typing the secret sequence survives a refresh triggered by the opponent", () => {
  // player has typed "12" of their 4-digit secret
  const secret = makeInput("input-secret", { value: "12", start: 2, end: 2 });
  const snap = snapshotInputs([secret], secret);

  // opponent submits their secret -> game.updated -> refetch -> re-render
  const after = rebuild([secret]);
  assert.equal(after[0].value, "", "precondition: the rebuilt field is empty");
  restoreInputs(snap, indexer(after));

  assert.equal(after[0].value, "12", "the half-typed secret must survive");
});

test("both the secret and the guess field are preserved, not just one", () => {
  const secret = makeInput("input-secret", { value: "7" });
  const guess = makeInput("input-guess", { value: "4821", start: 4, end: 4 });
  const snap = snapshotInputs([secret, guess], guess);

  const after = rebuild([secret, guess]);
  restoreInputs(snap, indexer(after));

  assert.equal(after[0].value, "7", "secret preserved");
  assert.equal(after[1].value, "4821", "guess preserved");
});

test("focus and caret position are restored, not only the text", () => {
  const secret = makeInput("input-secret", { value: "123", start: 1, end: 1 });
  const snap = snapshotInputs([secret], secret);

  const after = rebuild([secret]);
  restoreInputs(snap, indexer(after));

  assert.equal(after[0].focused, true, "the field the player was typing in keeps focus");
  assert.deepEqual(
    [after[0].selectionStart, after[0].selectionEnd],
    [1, 1],
    "the caret stays where it was, so continued typing lands in the right place"
  );
});

test("focus is not stolen by a field that did not have it", () => {
  const secret = makeInput("input-secret", { value: "9" });
  const other = makeInput("input-guess");
  const snap = snapshotInputs([secret, other], null); // nothing focused

  const after = rebuild([secret, other]);
  restoreInputs(snap, indexer(after));

  assert.equal(after[0].focused, false);
  assert.equal(after[1].focused, false);
  assert.equal(after[0].value, "9", "the text is still restored");
});

test("a field the phase change legitimately removed is skipped", () => {
  const secret = makeInput("input-secret", { value: "55", start: 2, end: 2 });
  const snap = snapshotInputs([secret], secret);

  // setup -> playing: the secret field is gone, only the guess exists now
  const guess = makeInput("input-guess");
  assert.doesNotThrow(() => restoreInputs(snap, indexer([guess])));
  assert.equal(guess.value, "", "the guess field must not receive the secret text");
});

test("an empty snapshot is a no-op", () => {
  const guess = makeInput("input-guess", { value: "1111" });
  restoreInputs([], () => guess);
  assert.equal(guess.value, "1111", "restoring nothing must not clear a field");
});

test("an input without selection support does not break restoration", () => {
  // inputs that carry no selection report null selectionStart in a real DOM
  const plain = { id: "input-secret", value: "42" };
  const snap = snapshotInputs([plain], plain);

  const after = {
    id: "input-secret",
    value: "",
    focusCalls: 0,
    focus() {
      this.focusCalls += 1;
    },
  };
  assert.doesNotThrow(() => restoreInputs(snap, () => after));
  assert.equal(after.value, "42", "the text is still restored");
  assert.equal(after.focusCalls, 1, "still refocused, just with no caret to place");
});

test("app.js preserves every board input, not a hard-coded one", async () => {
  // Structural guard: the original defect was a special case for #input-guess
  // that silently left #input-secret behind. Snapshotted generically over the
  // board's inputs is the property that must hold.
  const src = await readFile(
    fileURLToPath(new URL("../public/app.js", import.meta.url)),
    "utf8"
  );
  assert.match(
    src,
    /querySelectorAll\("input"\)/,
    "renderGame must snapshot all inputs in the board"
  );
  assert.match(src, /restoreInputs\(typedInputs, \$\)/, "the snapshot must be restored");
  assert.doesNotMatch(
    src,
    /typedGuess/,
    "the per-field special case must not come back"
  );
});

/* ---------- structural guards: the rest of the lost-on-re-render class ---------- */

async function readApp() {
  return readFile(
    fileURLToPath(new URL("../public/app.js", import.meta.url)),
    "utf8"
  );
}

test("lobby action controls are keyed so focus survives the rebuild", async () => {
  // renderLobby() empties all four <ul>s and recreates their rows, so the
  // keyboard focus a player had put on Invite/Accept/Cancel/Open is destroyed.
  // A stable key on each action control is what makes it restorable.
  const src = await readApp();
  assert.match(
    src,
    /dataset\.focusKey = /,
    "each lobby action control must carry a stable focus key"
  );
  assert.match(
    src,
    /snapshotFocus\(/,
    "the rebuild must remember which control had focus"
  );
  assert.match(
    src,
    /restoreFocus\(/,
    "and hand focus back to the recreated control"
  );
});

test("in-flight submits live in JS state, not on a DOM node", async () => {
  // `btn.disabled = true` guards only the node the click came from. A refresh
  // (lobby.updated broadcasts on every registration) rebuilds the board and the
  // replacement button is enabled again, while the request is still running.
  const src = await readApp();
  assert.match(
    src,
    /createSubmitLock\(/,
    "the client needs a submit lock that a re-render cannot reset"
  );
  assert.ok(
    (src.match(/submitLock\.run\(/g) || []).length >= 3,
    "setup, guess and register must all go through the lock"
  );
  assert.doesNotMatch(
    src,
    /btn\.disabled = false/,
    "re-enabling a captured node is a no-op once the board has been rebuilt"
  );
});

test("post-request writes go to the live node, never a captured one", async () => {
  // After `await api(...)` the board may have been rebuilt, so a node captured
  // before the await is detached: clearing it leaves the submitted digits in
  // the field the player is actually looking at.
  const src = await readApp();
  const start = src.indexOf("function submitGuess");
  assert.ok(
    start >= 0,
    "submitGuess must exist for this guard to assert anything (a -1 slice makes doesNotMatch vacuous)"
  );
  // Bound the slice to the function body. A slice to end-of-file lets a `$()`
  // call in *unrelated* later code satisfy the regex, which would report this
  // guard green while submitGuess itself still cleared a detached node. Every
  // nested block in this function is indented, so the first column-0 `}` ends it.
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, "the end of submitGuess() must be findable");
  const guess = src.slice(start, end);
  // Invariant, not spelling: the field must be resolved again *after* the
  // request was issued. Writing through a node captured before the await hits a
  // detached element whenever a refresh rebuilt the board mid-request.
  assert.match(
    guess,
    /await api\([\s\S]{0,600}\$\("input-guess"\)/,
    "the guess field must be looked up again by id after the request, before it is cleared"
  );
});

/* ---------- behaviour of the focus + submit-lock primitives ---------- */

/** Stand-in for a focusable control the lobby recreates (a button row). */
function makeControl(focusKey) {
  return {
    dataset: focusKey === null ? {} : { focusKey },
    focusCalls: 0,
    focus() {
      this.focusCalls += 1;
    },
  };
}

/** Stand-in container: only [data-focus-key] descendants are visible to it. */
function container(controls) {
  return {
    querySelectorAll: (selector) =>
      selector === "[data-focus-key]" ? controls : [],
  };
}

test("snapshotFocus reads the key off the focused control", () => {
  const btn = makeControl("invite:1002");
  assert.equal(snapshotFocus(btn), "invite:1002");
});

test("snapshotFocus is null when nothing usable had focus", () => {
  assert.equal(snapshotFocus(null), null, "no active element");
  assert.equal(snapshotFocus(undefined), null);
  assert.equal(
    snapshotFocus(makeControl(null)),
    null,
    "a control without a key (e.g. the focused input) is not our concern"
  );
});

test("focus on a lobby row returns to the recreated row, not the page top", () => {
  const before = makeControl("accept:7");
  const key = snapshotFocus(before);

  // refresh -> renderLobby() empties the <ul> and builds brand new rows
  const after = [makeControl("invite:1001"), makeControl("accept:7")];
  restoreFocus(key, focusLookup(container(after)));

  assert.equal(after[0].focusCalls, 0, "an unrelated row must not take focus");
  assert.equal(after[1].focusCalls, 1, "the row the player was on gets it back");
});

test("a null focus key never steals the keyboard", () => {
  const rows = [makeControl("open:1")];
  let lookedUp = 0;
  restoreFocus(snapshotFocus(null), (k) => {
    lookedUp += 1;
    return focusLookup(container(rows))(k);
  });
  assert.equal(lookedUp, 0, "nothing was focused, so nothing may be focused");
  assert.equal(rows[0].focusCalls, 0);
});

test("focus whose row legitimately disappeared is skipped", () => {
  const key = snapshotFocus(makeControl("cancel:9"));
  const rows = [makeControl("invite:1001")]; // that invite is gone now
  assert.doesNotThrow(() => restoreFocus(key, focusLookup(container(rows))));
  assert.equal(rows[0].focusCalls, 0);
});

test("focusLookup matches the attribute, so keys need no escaping", () => {
  const weird = makeControl('open:ab"cd:e');
  const rows = [makeControl("invite:1001"), weird];
  assert.equal(focusLookup(container(rows))('open:ab"cd:e'), weird);
  assert.equal(focusLookup(container(rows))("open:missing"), null);
  assert.equal(focusLookup(null)?.("anything"), undefined ?? null, "no root");
});

test("the submit lock drops a second request while one is in flight", async () => {
  const lock = createSubmitLock();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;

  const first = lock.run(async () => {
    started += 1;
    await gate;
    return "done";
  });
  assert.equal(lock.pending, true, "the lock reports the running request");

  const second = await lock.run(async () => {
    started += 1;
    return "second";
  });
  assert.equal(second, undefined, "the re-entrant submit is dropped, not queued");
  assert.equal(started, 1, "only the first request ran");

  release();
  assert.equal(await first, "done", "the first request returns its value");
  assert.equal(lock.pending, false, "the lock is released afterwards");
});

test("the lock releases even when the request throws", async () => {
  const lock = createSubmitLock();
  await assert.rejects(
    lock.run(async () => {
      throw new Error("guess rejected");
    }),
    /guess rejected/
  );
  assert.equal(lock.pending, false, "a failed submit must not wedge the lock");
  assert.equal(await lock.run(async () => "ok"), "ok", "submits still work");
});

test("a throwing state callback cannot wedge the lock", async () => {
  // The callback only mirrors state onto the DOM; if it throws (a detached
  // node, a future refactor) every later submit would otherwise be dropped.
  const lock = createSubmitLock(() => {
    throw new Error("reflect failed");
  });
  assert.equal(await lock.run(async () => "ok"), "ok");
  assert.equal(lock.pending, false);
  assert.equal(await lock.run(async () => "again"), "again");
});

test("the static register button opts into the derived disabled state", async () => {
  // It is the one submit control that no render ever rebuilds, so the lock has
  // to reach it where it sits in index.html.
  const html = await readFile(
    fileURLToPath(new URL("../public/index.html", import.meta.url)),
    "utf8"
  );
  assert.match(
    html,
    /<button type="submit" data-submit>/,
    "the register button must carry data-submit or it stays clickable mid-request"
  );
});

test("no mutating request is issued outside the submit lock", async () => {
  // A double-click on Invite used to fire a second POST, which the server
  // rejects with "You already have an unfinished game with X" — so the player
  // who had just succeeded was shown an error toast for their own success.
  // The lock is the only guard, so no mutating call may bypass it.
  const src = await readApp();
  assert.doesNotMatch(
    src,
    /guard\(async[^(]*\(\)\s*=>\s*\{\s*await api\("\/api\/(?!state)/,
    "a handler must not await a mutating endpoint without submitLock.run()"
  );
  const mutating = (src.match(/api\("\/api\/(?!state)/g) || []).length;
  const locked = (src.match(/submitLock\.run\(/g) || []).length;
  assert.ok(locked >= mutating, `every mutating call needs a lock (${locked} < ${mutating})`);
});

test("the keyboard place is armed before the submit disables its control", async () => {
  // A disabled control is not focusable, so applying `disabled` to the button
  // the player is standing on blurs it. If the focus key were only read during
  // the next render it would read `body`, the hand-back on release would have
  // nothing to restore, and the retry would exist while being provably inert.
  const src = await readApp();
  const start = src.indexOf("function syncSubmitControls");
  assert.ok(start >= 0, "syncSubmitControls must exist for this guard to mean anything");
  const end = src.indexOf("const submitLock", start);
  assert.ok(end > start, "the end of syncSubmitControls must be findable");
  const body = src.slice(start, end);

  const armedAt = body.indexOf("snapshotFocus(document.activeElement)");
  const disabledAt = body.indexOf("el.disabled = submitLock.pending");
  assert.ok(armedAt >= 0, "nothing arms the focus key, so focus can never come back");
  assert.ok(disabledAt >= 0, "the disabled assignment moved; re-read this guard");
  assert.ok(
    armedAt < disabledAt,
    "the focus key must be armed before the control is disabled, not after"
  );
});

test("a mid-flight render must not discard the armed keyboard place", async () => {
  // The refresh issued from inside a submit runs while the focused control is
  // disabled, so activeElement is `body`. An unconditional re-snapshot there
  // overwrites the armed key with null and silently un-fixes the case above.
  const src = await readApp();
  const start = src.indexOf("function render()");
  assert.ok(start >= 0, "render() must exist for this guard to mean anything");
  const end = src.indexOf("\n}", src.indexOf("syncSubmitControls();", start));
  assert.ok(end > start, "the end of render() must be findable");
  const body = src.slice(start, end);

  assert.doesNotMatch(
    body,
    /focusKey = snapshotFocus\(document\.activeElement\);/,
    "render() must not overwrite focusKey unconditionally: during an in-flight submit the blur it reads is expected, not empty"
  );
  assert.match(
    body,
    /if \(liveKey \|\| !submitLock\.pending\) focusKey = liveKey;/,
    "render() must keep the armed key while a submit is in flight"
  );
});
