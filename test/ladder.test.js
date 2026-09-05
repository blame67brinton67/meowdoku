'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validLadder, rung, ratingOf, ladderTitle, chapterOf, CHAPTERS, LADDER_VERSION, LADDER_LENGTH } = require('../ladder');
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
    assert.ok(band.sizes.every(size => size >= 5 && size <= 12));
    previous = band.target;
  }
  assert.ok(rung(0).target < rung(LADDER_LENGTH - 1).target);
  // Widening only ever loosens the band, so a stuck rung cannot get stricter.
  assert.ok(rung(20, 1, 0).hi > rung(20, 0, 0).hi);
});

test('the 48 rung titles are distinct, deterministic and chaptered', () => {
  const titles = Array.from({ length: LADDER_LENGTH }, (_, index) => ladderTitle(index));
  assert.strictEqual(new Set(titles.map(title => title.name)).size, LADDER_LENGTH);
  for (const [index, title] of titles.entries()) {
    assert.deepStrictEqual(ladderTitle(index), title);
    assert.match(title.name, /^\p{Script=Han}+$/u);
    assert.ok(!title.name.includes('階'));
    assert.strictEqual(title.ladder.stage, index + 1);
    assert.ok(title.ladder.chapterStage >= 1 && title.ladder.chapterStage <= title.ladder.chapterLength);
    assert.strictEqual(title.ladder.chapter, chapterOf(index).name);
    assert.strictEqual(title.ladder.chapterIndex, CHAPTERS.indexOf(chapterOf(index)) + 1);
  }
  assert.strictEqual(new Set(titles.map(title => title.ladder.chapter)).size, CHAPTERS.length);
  // Stage numbering restarts in every chapter and runs to that chapter's length.
  for (const chapter of CHAPTERS) {
    const stages = titles.filter(title => title.ladder.chapter === chapter.name).map(title => title.ladder.chapterStage);
    assert.deepStrictEqual(stages, stages.map((_, i) => i + 1));
    assert.strictEqual(stages.length, titles.find(title => title.ladder.chapter === chapter.name).ladder.chapterLength);
  }
  assert.notStrictEqual(titles[0].ladder.chapter, titles[LADDER_LENGTH - 1].ladder.chapter);
});

test('renaming a stored ladder keeps ids, boards and ratings intact', () => {
  const stored = [{ ...rungLevel('a', 10), name: '第 001 階 · 舊名', ladderIndex: 0 }, { ...rungLevel('b', 20), name: '第 002 階 · 舊名', ladderIndex: 1 }];
  const levels = validLadder({ version: LADDER_VERSION, levels: stored });
  assert.deepStrictEqual(levels.map(level => level.id), ['a', 'b']);
  assert.deepStrictEqual(levels.map(level => level.regions), stored.map(level => level.regions));
  assert.deepStrictEqual(levels.map(level => level.rating), stored.map(level => level.rating));
  assert.deepStrictEqual(levels.map(level => level.name), [ladderTitle(0).name, ladderTitle(1).name]);
  assert.strictEqual(levels[1].ladder.stage, 2);
  // Rungs stored before ladderIndex existed are titled by their position.
  assert.strictEqual(validLadder({ version: LADDER_VERSION, levels: [rungLevel('a', 10), rungLevel('b', 20)] })[1].name, ladderTitle(1).name);
});

test('a rung carries the rating fields the client renders', () => {
  const rating = ratingOf(generatePuzzle(6));
  assert.ok(rating.score > 0 && rating.stars >= 1 && rating.stars <= 5);
  assert.match(rating.hardestName, /\p{Script=Han}/u);
  assert.strictEqual(typeof rating.counts, 'object');
});
