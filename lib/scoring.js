/**
 * Pure game logic for the 4-digit number-guessing game.
 *
 * A sequence is an array of 4 digits (0-9). Repeats are allowed.
 */

import { randomInt } from "node:crypto";

export const SEQUENCE_LENGTH = 4;

/**
 * Parse user input into a 4-digit sequence.
 * Accepts a string of exactly 4 digit characters (leading zeros kept).
 * Returns number[] or null when invalid.
 */
export function parseSequence(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!/^\d{4}$/.test(s)) return null;
  return [...s].map(Number);
}

/**
 * Generate a random 4-digit sequence (repeats allowed).
 * `random()` must return one integer digit 0-9 per call; the default is a
 * cryptographically strong RNG because the sequence is a game secret.
 */
export function randomSequence(random = () => randomInt(10)) {
  return Array.from({ length: SEQUENCE_LENGTH }, () => random());
}

/**
 * Score `guess` against `secret`.
 *
 * Classification per guessed position (multiset-correct for repeats):
 *  - "correct"   same digit in the same position
 *  - "misplaced" digit exists in the secret but the exact slot is already
 *                taken; counted only against leftover secret digits
 *  - "incorrect" digit not present in the secret beyond what is matched
 *
 * Returns { marks: string[4], counts: { correct, misplaced, incorrect } }.
 */
export function score(secret, guess) {
  if (!Array.isArray(secret) || !Array.isArray(guess)) {
    throw new TypeError("secret and guess must be arrays");
  }
  const marks = new Array(SEQUENCE_LENGTH);
  const leftoverSecret = [];
  const leftoverGuess = []; // { digit, index }

  for (let i = 0; i < SEQUENCE_LENGTH; i++) {
    if (secret[i] === guess[i]) {
      marks[i] = "correct";
    } else {
      leftoverSecret.push(secret[i]);
      leftoverGuess.push({ digit: guess[i], index: i });
    }
  }

  const available = new Map();
  for (const d of leftoverSecret) {
    available.set(d, (available.get(d) || 0) + 1);
  }

  const counts = { correct: 0, misplaced: 0, incorrect: 0 };
  for (const { digit, index } of leftoverGuess) {
    const left = available.get(digit) || 0;
    if (left > 0) {
      available.set(digit, left - 1);
      marks[index] = "misplaced";
      counts.misplaced++;
    } else {
      marks[index] = "incorrect";
      counts.incorrect++;
    }
  }
  for (const m of marks) if (m === "correct") counts.correct++;

  return { marks, counts };
}

/** True when the whole sequence was guessed (every position correct). */
export function isSolved(result) {
  return result.counts.correct === SEQUENCE_LENGTH;
}
