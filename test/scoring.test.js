import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSequence,
  randomSequence,
  score,
  isSolved,
} from "../lib/scoring.js";

test("parseSequence accepts exactly 4 digit strings", () => {
  assert.deepEqual(parseSequence("1234"), [1, 2, 3, 4]);
  assert.deepEqual(parseSequence(" 0079 "), [0, 0, 7, 9]);
  assert.equal(parseSequence(""), null);
  assert.equal(parseSequence("123"), null);
  assert.equal(parseSequence("12345"), null);
  assert.equal(parseSequence("12a4"), null);
  assert.equal(parseSequence(null), null);
  assert.equal(parseSequence(1234), null);
});

test("randomSequence always produces 4 digits", () => {
  for (let i = 0; i < 200; i++) {
    const s = randomSequence();
    assert.equal(s.length, 4);
    assert.ok(s.every((d) => Number.isInteger(d) && d >= 0 && d <= 9));
  }
  // deterministic injection: random() yields one integer digit per call
  assert.deepEqual(randomSequence(() => 0), [0, 0, 0, 0]);
  assert.deepEqual(randomSequence(() => 9), [9, 9, 9, 9]);
});

test("score: no duplicates, mixed result", () => {
  const r = score([1, 2, 3, 4], [1, 5, 2, 6]);
  assert.deepEqual(r.marks, ["correct", "incorrect", "misplaced", "incorrect"]);
  assert.deepEqual(r.counts, { correct: 1, misplaced: 1, incorrect: 2 });
  assert.equal(isSolved(r), false);
});

test("score: fully solved", () => {
  const r = score([4, 3, 2, 1], [4, 3, 2, 1]);
  assert.deepEqual(r.counts, { correct: 4, misplaced: 0, incorrect: 0 });
  assert.equal(isSolved(r), true);
});

test("score: all wrong", () => {
  const r = score([0, 1, 2, 3], [9, 8, 7, 6]);
  assert.deepEqual(r.counts, { correct: 0, misplaced: 0, incorrect: 4 });
});

test("score: duplicate digit in guess is not double-counted", () => {
  // secret [1,1,2,3], guess [1,2,2,2]:
  // pos0 correct(1), pos2 correct(2); leftover secret {1,3}, leftover guess {2,2}
  // -> neither 2 can match -> both incorrect
  const r = score([1, 1, 2, 3], [1, 2, 2, 2]);
  assert.deepEqual(r.marks, ["correct", "incorrect", "correct", "incorrect"]);
  assert.deepEqual(r.counts, { correct: 2, misplaced: 0, incorrect: 2 });
});

test("score: all four misplaced with mirrored duplicates", () => {
  // leftover secret {1,1,9,9}, guess digits 9,9,1,1 all find availability
  const r = score([1, 1, 9, 9], [9, 9, 1, 1]);
  assert.deepEqual(r.counts, { correct: 0, misplaced: 4, incorrect: 0 });
});

test("score: exact match wins over misplacement for same digit", () => {
  // secret [5,5,0,0]; guess [0,5,5,5]: pos1 correct(5).
  // leftover secret {5,0,0}, leftover guess {0,5,5}
  // 0 -> misplaced, first spare 5 -> misplaced, second spare 5 -> incorrect
  const r = score([5, 5, 0, 0], [0, 5, 5, 5]);
  assert.deepEqual(r.marks, ["misplaced", "correct", "misplaced", "incorrect"]);
  assert.deepEqual(r.counts, { correct: 1, misplaced: 2, incorrect: 1 });
});
