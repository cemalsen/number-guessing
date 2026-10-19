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
import { restoreInputs, snapshotInputs } from "../public/game-inputs.js";

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
