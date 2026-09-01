'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validLadder, rung, ratingOf, LADDER_VERSION, LADDER_LENGTH } = require('../ladder');
const { generatePuzzle } = require('../puzzle');

const rungLevel = (id, score) => ({ id, size: 2, regions: [0, 0, 1, 1], solution: [], rating: { score, stars: 1 } });

test('a stored ladder is only trusted while it is intact and monotonic', () => {
  const levels = [rungLevel('a', 10), rungLevel('b', 20), rungLevel('c', 30)];
  assert.strictEqual(validLadder({ version: LADDER_VERSION, levels }).length, 3);
  assert.strictEqual(validLadder({ version: LADDER_VERSION + 1, levels }).length, 0);
  assert.strictEqual(validLadder(null).length, 0);
  // A rung that does not climb, or is missing its rating, truncates the ladder
  // there — the rungs below it are still good and are kept.
  assert.strictEqual(validLadder({ version: LADDER_VERSION, levels: [rungLevel('a', 10), rungLevel('b', 9)] }).length, 1);
  assert.strictEqual(validLadder({ version: LADDER_VERSION, levels: [rungLevel('a', 10), { ...rungLevel('b', 20), rating: null }] }).length, 1);
});

test('the target band climbs and never sinks below the rung underneath', () => {
  let previous = 0;
  for (let index = 0; index < LADDER_LENGTH; index++) {
    const band = rung(index, 0, previous);
    assert.ok(band.lo > previous, `rung ${index} floor ${band.lo} must beat ${previous}`);
    assert.ok(band.hi >= band.lo);
    assert.ok(band.sizes.every(size => size >= 5 && size <= 10));
    previous = band.target;
  }
  assert.ok(rung(0).target < rung(LADDER_LENGTH - 1).target);
  // Widening only ever loosens the band, so a stuck rung cannot get stricter.
  assert.ok(rung(20, 1, 0).hi > rung(20, 0, 0).hi);
});

test('a rung carries the rating fields the client renders', () => {
  const rating = ratingOf(generatePuzzle(6));
  assert.ok(rating.score > 0 && rating.stars >= 1 && rating.stars <= 5);
  assert.match(rating.hardestName, /\p{Script=Han}/u);
  assert.strictEqual(typeof rating.counts, 'object');
});
