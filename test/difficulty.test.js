'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rate, starsFor, STAR_THRESHOLDS } = require('../difficulty');
const { generatePuzzle, findSolutions, countSolutions } = require('../puzzle');

// Fixed boards, each one the cheapest board found that *stops* at one technique.
// `唯一格 only` is hand-built (a one-cell colour, which the generator never
// makes, is the only way a unit can have a single candidate on an empty board);
// the rest were harvested from the generator and frozen here.
const FIXTURES = {
  singles: { size: 4, regions: [1, 1, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3], hardest: 2 },
  confinement: { size: 4, regions: [2, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3], hardest: 3 },
  subset: { size: 5, regions: [1, 1, 1, 0, 0, 1, 1, 1, 0, 2, 4, 1, 1, 2, 2, 4, 4, 3, 3, 3, 4, 4, 4, 3, 3], hardest: 4, peak: 2 },
  contradiction: { size: 4, regions: [1, 1, 0, 0, 1, 1, 2, 0, 3, 1, 2, 2, 3, 3, 3, 2], hardest: 5 },
  common: { size: 4, regions: [2, 0, 0, 0, 2, 1, 1, 1, 2, 2, 1, 1, 2, 2, 3, 3], hardest: 6 },
  guess: { size: 5, regions: [0, 0, 0, 0, 1, 3, 1, 1, 1, 1, 3, 2, 2, 2, 4, 3, 3, 3, 2, 4, 3, 3, 4, 4, 4], hardest: 7 }
};
const ratings = Object.fromEntries(Object.entries(FIXTURES).map(([key, board]) => [key, rate(board)]));

test('every fixture is a real single-solution board the rater solves', () => {
  for (const [key, board] of Object.entries(FIXTURES)) {
    assert.equal(countSolutions(board.regions, board.size, 3), 1, `${key} must have exactly one solution`);
    const rating = ratings[key];
    assert.ok(rating.solved, `${key} must be solved`);
    assert.ok(!rating.exhausted, `${key} must not exhaust the budget`);
    // The rater may never contradict puzzle.js.
    const expected = findSolutions(board.regions, board.size, 1)[0].map((col, row) => ({ row, col }));
    assert.deepEqual(rating.solution, expected, `${key} solution must match puzzle.js`);
  }
});

test('each fixture stops at the technique it was chosen for', () => {
  for (const [key, board] of Object.entries(FIXTURES)) {
    assert.equal(ratings[key].hardest, board.hardest, `${key} hardest technique`);
    if (board.peak) assert.equal(ratings[key].peak.param, board.peak, `${key} peak subset size`);
    assert.ok(ratings[key].counts[board.hardest] > 0, `${key} must actually use rule ${board.hardest}`);
  }
});

test('scores rise with the technique the board demands', () => {
  const { singles, confinement, subset, contradiction, common, guess } = ratings;
  assert.ok(singles.score < confinement.score, 'single candidates are the easiest');
  assert.ok(confinement.score < common.score, 'common elimination costs more than confinement');
  assert.ok(confinement.score < subset.score, 'subset confinement costs more than x = 1');
  assert.ok(confinement.score < contradiction.score, 'contradiction hunting costs more than confinement');
  assert.ok(guess.score > Math.max(subset.score, contradiction.score, common.score), 'guessing is the most expensive');
  assert.equal(singles.stars, 1);
  assert.ok(guess.stars >= 4, 'a board that forces a guess is at least 4 stars');
});

test('stars follow the committed thresholds', () => {
  assert.equal(starsFor(0), 1);
  assert.equal(starsFor(STAR_THRESHOLDS[0]), 2);
  assert.equal(starsFor(STAR_THRESHOLDS[3]), 5);
  assert.equal(starsFor(STAR_THRESHOLDS[3] + 10_000), 5);
  for (let score = 0; score < 400; score++) assert.ok(starsFor(score) <= starsFor(score + 1), 'stars never fall as the score rises');
});

test('the rater agrees with puzzle.js on 200 generated boards', () => {
  for (let i = 0; i < 200; i++) {
    const size = 5 + (i % 6);
    const puzzle = generatePuzzle(size);
    const rating = rate(puzzle);
    assert.ok(rating.solved && !rating.exhausted, `board ${i} (${size}×${size}) must be solved within budget`);
    assert.deepEqual(rating.solution, puzzle.solution, `board ${i} (${size}×${size}) must reach the unique solution`);
    assert.ok(rating.score > 0 && rating.stars >= 1 && rating.stars <= 5);
  }
});

test('rating stays fast enough for the ladder builder', () => {
  const boards = Array.from({ length: 20 }, () => generatePuzzle(10));
  const started = process.hrtime.bigint();
  for (const board of boards) rate(board);
  const perBoard = Number(process.hrtime.bigint() - started) / 1e6 / boards.length;
  assert.ok(perBoard < 50, `10 × 10 rating averaged ${perBoard.toFixed(2)} ms, budget is 50 ms`);
});
