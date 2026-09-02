'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generatePuzzle, formatBoardText, parseBoardText, countSolutions } = require('../puzzle');

const fixture = {
  size: 5,
  regions: [0, 0, 0, 0, 0, 0, 0, 2, 1, 3, 0, 2, 2, 1, 3, 2, 2, 3, 3, 3, 4, 4, 4, 4, 3],
  solution: [0, 3, 1, 4, 2]
};
const puzzle = {
  ...fixture,
  solution: fixture.solution.map((col, row) => ({ row, col }))
};
const text = () => formatBoardText(puzzle);

test('fresh puzzles round-trip through the board text format', () => {
  for (const size of [5, 7]) {
    const generated = generatePuzzle(size);
    const parsed = parseBoardText(formatBoardText(generated));
    assert.deepEqual(parsed, generated);
  }
});

test('bare digit rows are accepted for sizes up to nine', () => {
  const compact = text().split('\n').map(line => line.replaceAll(' ', '')).join('\n');
  assert.deepEqual(parseBoardText(compact), puzzle);
});

test('rejects invalid line counts and grid row shapes', () => {
  assert.throws(() => parseBoardText(text().split('\n').slice(0, 4).join('\n')), /需要/);
  const lines = text().split('\n'); lines[0] = '1 1 1 1';
  assert.throws(() => parseBoardText(lines.join('\n')), /第 1 行必須有 5/);
});

test('rejects out-of-range and skipped region numbers', () => {
  const zero = text().replace(/^1 /, '0 ');
  assert.throws(() => parseBoardText(zero), /區域編號必須介於/);
  const high = text().replace(/^1 /, '6 ');
  assert.throws(() => parseBoardText(high), /區域編號必須介於/);
  const skipped = text().replaceAll('5', '4');
  assert.throws(() => parseBoardText(skipped), /不能跳號/);
});

test('rejects disconnected regions', () => {
  const lines = text().split('\n');
  lines[4] = '5 3 5 5 4';
  assert.throws(() => parseBoardText(lines.join('\n')), /區域 5 必須是正交連通/);
});

test('rejects repeated and wrongly sized answer permutations', () => {
  const repeated = text().split('\n'); repeated[repeated.length - 1] = '1 4 2 5 2';
  assert.throws(() => parseBoardText(repeated.join('\n')), /不重複排列/);
  const short = text().split('\n'); short[short.length - 1] = '1 4 2 5';
  assert.throws(() => parseBoardText(short.join('\n')), /必須有 5 個數值/);
});

test('rejects answers with duplicate regions and diagonal neighbours', () => {
  const duplicateRegion = text().split('\n'); duplicateRegion[duplicateRegion.length - 1] = '2 4 1 5 3';
  assert.throws(() => parseBoardText(duplicateRegion.join('\n')), /每個區域各放一隻/);
  const diagonal = text().split('\n'); diagonal[diagonal.length - 1] = '1 4 2 3 5';
  assert.throws(() => parseBoardText(diagonal.join('\n')), /八方向相鄰/);
});

test('rejects a deterministic multi-solution board made by merging regions', () => {
  const merged = fixture.regions.map(region => region === 2 ? 1 : region);
  merged[10] = 2;
  assert.equal(countSolutions(merged, 5, 2), 2);
  const mergedText = formatBoardText({ size: 5, regions: merged, solution: [{ row: 0, col: 1 }, { row: 1, col: 3 }, { row: 2, col: 0 }, { row: 3, col: 4 }, { row: 4, col: 2 }] });
  assert.throws(() => parseBoardText(mergedText), /不唯一/);
});
