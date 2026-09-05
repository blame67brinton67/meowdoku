'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rate } = require('../difficulty');
const { findHint, boardKey } = require('../hints');
const { createHintQuota, memoryStore, dayKey } = require('../hint-quota');

// The same frozen boards difficulty.test.js uses, each stopping at one technique.
const FIXTURES = {
  singles: { size: 4, regions: [1, 1, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3] },
  confinement: { size: 4, regions: [2, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 3, 3, 3, 3, 3] },
  subset: { size: 5, regions: [1, 1, 1, 0, 0, 1, 1, 1, 0, 2, 4, 1, 1, 2, 2, 4, 4, 3, 3, 3, 4, 4, 4, 3, 3] },
  contradiction: { size: 4, regions: [1, 1, 0, 0, 1, 1, 2, 0, 3, 1, 2, 2, 3, 3, 3, 2] },
  common: { size: 4, regions: [2, 0, 0, 0, 2, 1, 1, 1, 2, 2, 1, 1, 2, 2, 3, 3] },
  guess: { size: 5, regions: [0, 0, 0, 0, 1, 3, 1, 1, 1, 1, 3, 2, 2, 2, 4, 3, 3, 3, 2, 4, 3, 3, 4, 4, 4] }
};
// rate() output captured on main before hints.js existed. The ladder and the
// persisted data/ladder.json depend on these numbers staying put.
const FROZEN_RATINGS = {
  singles: { score: 8, base: 1, extra: 7, counts: { 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, hardest: 2, steps: 1 },
  confinement: { score: 14, base: 6, extra: 8, counts: { 2: 1, 3: 1, 4: 0, 5: 0, 6: 0, 7: 0 }, hardest: 3, steps: 2 },
  subset: { score: 31, base: 15, extra: 16, counts: { 2: 2, 3: 0, 4: 1, 5: 0, 6: 0, 7: 0 }, hardest: 4, steps: 3 },
  contradiction: { score: 47, base: 29, extra: 18, counts: { 2: 1, 3: 0, 4: 1, 5: 1, 6: 0, 7: 0 }, hardest: 5, steps: 3 },
  common: { score: 33, base: 16, extra: 17, counts: { 2: 1, 3: 1, 4: 0, 5: 0, 6: 1, 7: 0 }, hardest: 6, steps: 3 },
  guess: { score: 324, base: 297, extra: 27, counts: { 2: 2, 3: 3, 4: 0, 5: 2, 6: 1, 7: 3 }, hardest: 7, steps: 11 }
};
const puzzles = Object.fromEntries(Object.entries(FIXTURES).map(([key, board]) => [key, { ...board, solution: rate(board).solution }]));
const key = cat => `${cat.row}:${cat.col}`;
const solutionKeys = puzzle => new Set(puzzle.solution.map(key));
const CELL_TEXT = /第 \d+ 行第 \d+ 列/;

test('rate() is unchanged by the hint work', () => {
  for (const [name, board] of Object.entries(FIXTURES)) {
    const { score, base, extra, counts, hardest, steps } = rate(board);
    assert.deepEqual({ score, base, extra, counts, hardest, steps }, FROZEN_RATINGS[name], name);
  }
});

test('an empty board gets a sound first step in three layers', () => {
  for (const [name, puzzle] of Object.entries(puzzles)) {
    const hint = findHint(puzzle, { cats: [], marks: [] });
    assert.ok(hint.rule >= 2 && hint.rule <= 7, `${name} uses a solving technique`);
    assert.equal(hint.tiers.length, 3);
    assert.deepEqual(hint.tiers.map(tier => tier.level), [1, 2, 3]);
    const solution = solutionKeys(puzzle), last = hint.tiers[2];
    assert.ok(last.cells.length > 0, `${name} names concrete cells`);
    for (const cell of last.cells) {
      if (last.action === 'cat') assert.ok(solution.has(key(cell)), `${name}: a placement hint must be a real cat`);
      if (last.action === 'mark') assert.ok(!solution.has(key(cell)), `${name}: an elimination hint must never cross off a cat`);
    }
  }
});

test('the cheapest technique wins, matching the rater\'s opening step', () => {
  assert.equal(findHint(puzzles.singles, {}).rule, 2);
  assert.equal(findHint(puzzles.confinement, {}).rule, 3);
  assert.equal(findHint(puzzles.subset, {}).rule, 4);
  assert.equal(findHint(puzzles.subset, {}).param, 2);
  assert.ok(!/R\d/.test(JSON.stringify(findHint(puzzles.subset, {}))), 'rule codes never leak into the text');
});

test('layer one never gives away a cell, layer two only a location', () => {
  for (const puzzle of Object.values(puzzles)) {
    const hint = findHint(puzzle, { cats: [], marks: [] });
    const [first, second, third] = hint.tiers;
    assert.ok(!('focus' in first) && !('cells' in first), 'layer one carries no board data');
    assert.ok(!CELL_TEXT.test(first.text), `layer one text names no cell: ${first.text}`);
    assert.ok(!('cells' in second), 'layer two has no conclusion cells');
    assert.equal(second.focus.cells.length, 0, 'layer two highlights units, not cells');
    assert.ok(third.cells.length > 0);
  }
});

test('a misplaced cat is reported before anything else, pointing at the cell', () => {
  const puzzle = puzzles.subset, solution = solutionKeys(puzzle);
  let wrong = null;
  for (let row = 0; row < puzzle.size && !wrong; row++) for (let col = 0; col < puzzle.size; col++) if (!solution.has(`${row}:${col}`)) { wrong = { row, col }; break; }
  const hint = findHint(puzzle, { cats: [key(puzzle.solution[0]), key(wrong)], marks: [] });
  assert.equal(hint.rule, 0);
  assert.equal(hint.tiers[2].action, 'remove');
  assert.deepEqual(hint.tiers[2].cells, [wrong]);
  assert.ok(!CELL_TEXT.test(hint.tiers[0].text));
  assert.deepEqual(hint.tiers[1].focus.rows, [wrong.row]);
});

test('a cross on a cat is flagged, but correct crosses are not trusted as facts', () => {
  const puzzle = puzzles.subset;
  const flagged = findHint(puzzle, { cats: [], marks: [key(puzzle.solution[1])] });
  assert.equal(flagged.rule, 1);
  assert.deepEqual(flagged.tiers[2].cells, [puzzle.solution[1]]);
  // Crossing off every non-cat cell would "solve" the board if crosses were
  // believed; the hint still reasons from the cats alone and never claims done.
  const solution = solutionKeys(puzzle), everyOther = [];
  for (let cell = 0; cell < puzzle.size * puzzle.size; cell++) { const k = `${Math.floor(cell / puzzle.size)}:${cell % puzzle.size}`; if (!solution.has(k)) everyOther.push(k); }
  const hint = findHint(puzzle, { cats: [], marks: everyOther });
  assert.notEqual(hint.rule, null);
  assert.ok(hint.rule >= 2, 'still a real deduction, not a completion');
});

test('a step the player already crossed off is skipped for the next one', () => {
  const puzzle = puzzles.subset;
  const first = findHint(puzzle, { cats: [], marks: [] });
  assert.equal(first.tiers[2].action, 'mark');
  const second = findHint(puzzle, { cats: [], marks: first.tiers[2].cells.map(key) });
  assert.notDeepEqual(second.tiers[2].cells, first.tiers[2].cells);
});

test('a finished board says so instead of inventing work', () => {
  const puzzle = puzzles.singles;
  const hint = findHint(puzzle, { cats: puzzle.solution.map(key), marks: [] });
  assert.equal(hint.rule, null);
  assert.equal(hint.tiers.length, 1);
});

test('when only trial and error remains, the hint points at the tightest unit', () => {
  const puzzle = puzzles.guess;
  // Walk the board with the engine's own advice until it has to guess.
  const cats = [], marks = [];
  let hint;
  for (let step = 0; step < 100; step++) {
    hint = findHint(puzzle, { cats, marks });
    if (hint.rule === 7 || hint.rule === null) break;
    const last = hint.tiers[2];
    if (last.action === 'cat') cats.push(...last.cells.map(key)); else marks.push(...last.cells.map(key));
  }
  assert.equal(hint.rule, 7, 'the guess fixture must reach a branch point');
  assert.equal(hint.tiers[2].action, 'try');
  assert.ok(hint.tiers[2].cells.length >= 2);
  assert.ok(hint.tiers[2].cells.some(cell => solutionKeys(puzzle).has(key(cell))), 'one branch is the truth');
  assert.ok(!CELL_TEXT.test(hint.tiers[0].text));
});

test('malformed player input is ignored rather than trusted', () => {
  const puzzle = puzzles.singles;
  const hint = findHint(puzzle, { cats: ['9:9', 'x', null, 42, { row: -1, col: 0 }, '0:0:0'], marks: 'not-a-list' });
  assert.deepEqual(hint, findHint(puzzle, { cats: [], marks: [] }));
  assert.equal(boardKey('L', { cats: ['1:1', '0:0'], marks: [7] }), boardKey('L', { cats: ['0:0', '1:1'], marks: [] }));
  assert.notEqual(boardKey('L', { cats: ['0:0'] }), boardKey('L', { cats: [] }));
});

// --- quota ---------------------------------------------------------------

const TAIPEI_NOON = Date.UTC(2026, 0, 1, 4, 0, 0);
function quotaAt() {
  let now = TAIPEI_NOON;
  const quota = createHintQuota({ store: memoryStore(), now: () => now });
  return { quota, set: value => { now = value; } };
}

test('three hints are granted on the first request of a day and not again', () => {
  const { quota } = quotaAt();
  assert.deepEqual([quota.get('cat').granted, quota.get('cat').remaining], [3, 3]);
  assert.equal(quota.consume('cat', 'L1').remaining, 2);
  assert.equal(quota.get('cat').remaining, 2, 'asking again does not refill');
  assert.equal(quota.get('cat').granted, 3);
  assert.deepEqual(quota.get('cat').hinted, ['L1']);
});

test('the fourth hint of a day is refused without touching the count', () => {
  const { quota } = quotaAt();
  for (let i = 0; i < 3; i++) assert.ok(quota.consume('cat').ok);
  const refused = quota.consume('cat');
  assert.equal(refused.ok, false);
  assert.equal(refused.remaining, 0);
  assert.match(refused.error, /明天再來領 3 次/);
  assert.equal(quota.get('cat').used, 3);
});

test('rapid repeated consumes charge exactly once each', () => {
  const { quota } = quotaAt();
  const results = [quota.consume('cat'), quota.consume('cat')];
  assert.deepEqual(results.map(result => result.remaining), [2, 1]);
});

test('a new Taipei day grants a fresh three, keeping the hinted list', () => {
  const { quota, set } = quotaAt();
  quota.consume('cat', 'L1'); quota.consume('cat', 'L2'); quota.consume('cat', 'L3');
  // 23:30 Taipei is still the same day; 00:30 the next is not.
  set(Date.UTC(2026, 0, 1, 15, 30));
  assert.equal(quota.get('cat').remaining, 0);
  set(Date.UTC(2026, 0, 1, 16, 30));
  const fresh = quota.get('cat');
  assert.equal(fresh.remaining, 3);
  assert.equal(fresh.day, '2026-01-02');
  assert.deepEqual(fresh.hinted, ['L1', 'L2', 'L3']);
});

test('the day key follows Asia/Taipei, not UTC', () => {
  assert.equal(dayKey(Date.UTC(2026, 0, 1, 15, 59)), '2026-01-01');
  assert.equal(dayKey(Date.UTC(2026, 0, 1, 16, 0)), '2026-01-02');
});

test('identities are validated and never used as-is', () => {
  const { quota } = quotaAt();
  assert.equal(quota.get('../etc/passwd'), null);
  assert.equal(quota.get(''), null);
  assert.equal(quota.consume({ toString: () => 'cat' }).ok, false);
  assert.equal(quota.get('a'.repeat(65)), null);
});

test('the ledger round-trips through the store on every change', () => {
  const store = memoryStore();
  const quota = createHintQuota({ store, now: () => TAIPEI_NOON });
  quota.consume('cat');
  assert.equal(store.read().cat.used, 1);
  const reopened = createHintQuota({ store, now: () => TAIPEI_NOON });
  assert.equal(reopened.get('cat').remaining, 2);
});
