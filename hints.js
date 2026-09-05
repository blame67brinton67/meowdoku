'use strict';

// Hints for a stuck solo player. The engine is the rater in difficulty.js: it
// rebuilds the solving state from the cats the player has placed and asks for
// the cheapest technique that still makes progress, exactly in the order the
// rater charges for them. What comes back is one concrete instance of that
// technique, told in three layers — the idea, where to look, the conclusion —
// so a player can stop reading as soon as the penny drops.
//
// The player's own crosses are never fed into the state as facts. A cross is a
// guess until proven, and one wrong cross would send every later deduction off
// the rails; instead a cross is only ever *checked* against the answer.

const { buildBoard, RULES, CELL, freshState, cloneState, place, candidatesOf, hasEmptyUnit, tiersFor, lineMasksFor, combinations, popcount } = require('./difficulty');
const { UNKNOWN } = CELL;

const KEY = /^(\d{1,2}):(\d{1,2})$/;

function cellIndex(key, size) {
  if (typeof key === 'string') {
    const match = KEY.exec(key);
    if (!match) return null;
    const row = Number(match[1]), col = Number(match[2]);
    return row < size && col < size ? row * size + col : null;
  }
  if (key && Number.isInteger(key.row) && Number.isInteger(key.col) && key.row >= 0 && key.col >= 0 && key.row < size && key.col < size) return key.row * size + key.col;
  return null;
}
function cellSet(list, size) {
  const set = new Set();
  if (!Array.isArray(list)) return set;
  for (const key of list.slice(0, size * size)) { const cell = cellIndex(key, size); if (cell !== null) set.add(cell); }
  return set;
}
const toCell = (size, cell) => ({ row: Math.floor(cell / size), col: cell % size });
const cellLabel = (size, cell) => `第 ${Math.floor(cell / size) + 1} 行第 ${(cell % size) + 1} 列`;
const listLabels = (size, cells) => cells.map(cell => cellLabel(size, cell)).join('、');
const rowLabel = row => `第 ${row + 1} 行`;
const colLabel = col => `第 ${col + 1} 列`;
const regionLabel = region => `${region + 1} 號色塊`;
const lineLabel = (axis, line) => (axis ? colLabel(line) : rowLabel(line));
function unitLabel(size, unit) {
  if (unit < size) return rowLabel(unit);
  if (unit < 2 * size) return colLabel(unit - size);
  return regionLabel(unit - 2 * size);
}
function unitFocus(size, unit) {
  if (unit < size) return { rows: [unit] };
  if (unit < 2 * size) return { cols: [unit - size] };
  return { regions: [unit - 2 * size] };
}
function mergeFocus(...parts) {
  const focus = { rows: [], cols: [], regions: [], cells: [] };
  for (const part of parts) for (const key of Object.keys(focus)) if (part?.[key]) focus[key].push(...part[key]);
  for (const key of Object.keys(focus)) focus[key] = [...new Set(focus[key])];
  return focus;
}
const cellsFocus = (size, cells) => ({ cells: cells.map(cell => toCell(size, cell)) });

// Each finder returns the first instance of its technique that still removes
// or places something, or null. `cells` are the conclusion; `focus` is what to
// stare at before reading it.
function findSingle(board, state) {
  for (let unit = 0; unit < board.units.length; unit++) {
    const candidates = candidatesOf(board, state, unit);
    if (candidates.length !== 1) continue;
    return { rule: 2, param: 1, action: 'cat', cells: candidates, focus: unitFocus(board.size, unit),
      texts: ['有一個單元（某一行、某一列或某個色塊）只剩一個可以放貓的格子了，先找找是哪一個。',
        `看看${unitLabel(board.size, unit)}：其他格子都已經被排除，只剩一個位置。`,
        `${cellLabel(board.size, candidates[0])}一定有貓，放下去吧。`] };
  }
  return null;
}
function findConfinement(board, state, x) {
  const size = board.size;
  for (let axis = 0; axis < 2; axis++) {
    const { regionToLine, lineToRegion } = lineMasksFor(board, state, axis);
    const liveRegions = [], liveLines = [];
    for (let i = 0; i < size; i++) {
      if (!state.solved[2 * size + i] && regionToLine[i]) liveRegions.push(i);
      if (!state.solved[axis * size + i] && lineToRegion[i]) liveLines.push(i);
    }
    const lineOf = cell => (axis ? cell % size : Math.floor(cell / size));
    const axisWord = axis ? '列' : '行';
    for (const group of combinations(liveRegions, x)) {
      let lines = 0;
      for (const region of group) lines |= regionToLine[region];
      if (popcount(lines) !== x) continue;
      const inGroup = group.reduce((mask, region) => mask | (1 << region), 0);
      const cells = [];
      for (let cell = 0; cell < board.cells; cell++) {
        if (state.cell[cell] === UNKNOWN && (lines & (1 << lineOf(cell))) && !(inGroup & (1 << board.regions[cell]))) cells.push(cell);
      }
      if (!cells.length) continue;
      const lineList = [];
      for (let line = 0; line < size; line++) if (lines & (1 << line)) lineList.push(line);
      const regionsText = group.map(regionLabel).join('與'), linesText = lineList.map(line => lineLabel(axis, line)).join('與');
      return { rule: x === 1 ? 3 : 4, param: x, action: 'mark', cells, focus: mergeFocus({ regions: group }, axis ? { cols: lineList } : { rows: lineList }),
        texts: [x === 1
          ? `有一個色塊的候選格全部落在同一${axisWord}裡，那一${axisWord}其他顏色的格子就不必考慮了。`
          : `有 ${x} 個色塊的候選格加起來只佔了 ${x} ${axisWord}，這幾${axisWord}被牠們包下了，其他顏色的格子可以劃掉。`,
        `${regionsText}的貓只能落在${linesText}，所以${linesText}上其他顏色的格子都可以劃掉。`,
        `可以劃掉：${listLabels(size, cells)}。`] };
    }
    for (const group of combinations(liveLines, x)) {
      let regionMask = 0;
      for (const line of group) regionMask |= lineToRegion[line];
      if (popcount(regionMask) !== x) continue;
      const inGroup = group.reduce((mask, line) => mask | (1 << line), 0);
      const cells = [];
      for (let cell = 0; cell < board.cells; cell++) {
        if (state.cell[cell] === UNKNOWN && (regionMask & (1 << board.regions[cell])) && !(inGroup & (1 << lineOf(cell)))) cells.push(cell);
      }
      if (!cells.length) continue;
      const regionList = [];
      for (let region = 0; region < size; region++) if (regionMask & (1 << region)) regionList.push(region);
      const regionsText = regionList.map(regionLabel).join('與'), linesText = group.map(line => lineLabel(axis, line)).join('與');
      return { rule: x === 1 ? 3 : 4, param: x, action: 'mark', cells, focus: mergeFocus({ regions: regionList }, axis ? { cols: group } : { rows: group }),
        texts: [x === 1
          ? `有一${axisWord}的候選格全部落在同一個色塊裡，那個色塊在其他地方的格子就不必考慮了。`
          : `有 ${x} ${axisWord}的候選格加起來只落在 ${x} 個色塊裡，這些色塊被牠們包下了，色塊在其他地方的格子可以劃掉。`,
        `${linesText}的貓一定在${regionsText}裡，所以${regionsText}在其他${axisWord}的格子都可以劃掉。`,
        `可以劃掉：${listLabels(size, cells)}。`] };
    }
  }
  return null;
}
function emptiedUnit(board, state) {
  for (let unit = 0; unit < board.units.length; unit++) {
    if (state.solved[unit]) continue;
    if (!board.units[unit].some(cell => state.cell[cell] === UNKNOWN)) return unit;
  }
  return null;
}
function findContradiction(board, state) {
  for (let cell = 0; cell < board.cells; cell++) {
    if (state.cell[cell] !== UNKNOWN) continue;
    const trial = cloneState(state);
    place(board, trial, cell);
    if (!trial.dead && !hasEmptyUnit(board, trial)) continue;
    const unit = emptiedUnit(board, trial);
    const size = board.size, row = Math.floor(cell / size);
    const victim = unit === null ? '某個單元' : unitLabel(size, unit);
    return { rule: 5, param: 1, action: 'mark', cells: [cell], focus: mergeFocus({ rows: [row] }, unit === null ? {} : unitFocus(size, unit)),
      texts: ['有一格如果放了貓，會讓某個單元完全沒地方放貓，所以這格其實可以劃掉。',
        `試著把貓依序放在${rowLabel(row)}的每一格，其中一格會讓${victim}無處可去。`,
        `${cellLabel(size, cell)}放貓會讓${victim}沒有位置，劃掉它。`] };
  }
  return null;
}
function findCommon(board, state, y) {
  const hits = new Uint8Array(board.cells);
  for (let unit = 0; unit < board.units.length; unit++) {
    const candidates = candidatesOf(board, state, unit);
    if (candidates.length !== y) continue;
    hits.fill(0);
    for (const candidate of candidates) for (const other of board.elim[candidate]) if (state.cell[other] === UNKNOWN) hits[other]++;
    const cells = [];
    for (let cell = 0; cell < board.cells; cell++) if (hits[cell] === y) cells.push(cell);
    if (!cells.length) continue;
    const size = board.size;
    return { rule: 6, param: y, action: 'mark', cells, focus: unitFocus(size, unit),
      texts: ['有一個單元不管貓放在哪個候選格，都會排除掉同樣的格子；那些格子可以直接劃掉。',
        `${unitLabel(size, unit)}只剩 ${y} 個候選格，牠們共同排除到的格子可以劃掉。`,
        `可以劃掉：${listLabels(size, cells)}。`] };
  }
  return null;
}
function findByTier(board, state, tier) {
  if (tier.rule === 2) return findSingle(board, state);
  if (tier.rule === 3) return findConfinement(board, state, 1);
  if (tier.rule === 4) return findConfinement(board, state, tier.param);
  if (tier.rule === 5) return findContradiction(board, state);
  return findCommon(board, state, tier.param);
}
function guessHint(board, state) {
  let best = null, bestUnit = -1;
  for (let unit = 0; unit < board.units.length; unit++) {
    const candidates = candidatesOf(board, state, unit);
    if (!candidates.length) continue;
    if (!best || candidates.length < best.length) { best = candidates; bestUnit = unit; }
  }
  if (!best) return null;
  const size = board.size;
  return { rule: 7, param: 1, action: 'try', cells: best, focus: unitFocus(size, bestUnit),
    texts: ['目前沒有可以直接套用的推論了，接下來只能試誤：先挑候選格最少的單元開始分支，最省力。',
      `${unitLabel(size, bestUnit)}只剩 ${best.length} 個候選格，從這裡開始假設最快。`,
      `候選格是：${listLabels(size, best)}。逐一假設放貓，看看哪一個不會走進死路。`] };
}

function pack(size, found) {
  const { rule, param, action, cells, focus, texts } = found;
  return {
    rule, param, ruleName: RULES[rule]?.name || (rule === 0 ? '放錯的貓' : rule === 1 ? '劃錯的叉' : ''),
    tiers: [
      { level: 1, text: texts[0] },
      { level: 2, text: texts[1], focus: mergeFocus(focus) },
      { level: 3, text: texts[2], focus: mergeFocus(focus, cellsFocus(size, cells)), action, cells: cells.map(cell => toCell(size, cell)) }
    ]
  };
}

function findHint(puzzle, player = {}) {
  const size = puzzle.size;
  const board = buildBoard(size, puzzle.regions);
  const solution = new Set(puzzle.solution.map(cat => cat.row * size + cat.col));
  const cats = cellSet(player.cats, size), marks = cellSet(player.marks, size);
  // A misplaced cat is the one thing the solver cannot route around, so it is
  // always the first thing a hint says.
  for (const cell of cats) {
    if (solution.has(cell)) continue;
    const row = Math.floor(cell / size);
    return pack(size, { rule: 0, param: 1, action: 'remove', cells: [cell], focus: { rows: [row] },
      texts: ['盤面上有一隻貓咪放錯位置了，先把牠找出來。', `看看${rowLabel(row)}：這一行的貓不在你放的位置。`, `${cellLabel(size, cell)}的貓不在正解上，把牠移走再繼續。`] });
  }
  for (const cell of marks) {
    if (!solution.has(cell) || cats.has(cell)) continue;
    const row = Math.floor(cell / size);
    return pack(size, { rule: 1, param: 1, action: 'unmark', cells: [cell], focus: { rows: [row] },
      texts: ['有一個叉叉劃在其實住著貓的格子上，先檢查一下你的叉叉。', `看看${rowLabel(row)}的叉叉，其中一個劃錯了。`, `${cellLabel(size, cell)}其實有貓，把那個叉叉擦掉。`] });
  }
  const state = freshState(board);
  for (const cell of cats) place(board, state, cell);
  if (state.cats === size) return { rule: null, ruleName: '完成', tiers: [{ level: 1, text: '所有貓咪都已經就位了，沒有需要提示的地方。' }] };
  const tiers = tiersFor(size);
  // A step whose every conclusion the player has already crossed off is not
  // news; it is applied silently — the crosses were re-derived, not trusted —
  // and the search moves on to the next cheapest step.
  for (let guard = 0; guard < board.cells; guard++) {
    let found = null;
    for (const tier of tiers) { found = findByTier(board, state, tier); if (found) break; }
    if (!found) return pack(size, guessHint(board, state));
    if (found.action !== 'mark' || !found.cells.every(cell => marks.has(cell))) return pack(size, found);
    for (const cell of found.cells) state.cell[cell] = CELL.GONE;
  }
  return pack(size, guessHint(board, state));
}

// Two requests for the same position get the same hint, and only pay once.
function boardKey(levelId, player = {}) {
  const sorted = list => (Array.isArray(list) ? list.filter(item => typeof item === 'string').slice().sort() : []);
  return `${levelId}|${sorted(player.cats).join(',')}|${sorted(player.marks).join(',')}`;
}

module.exports = { findHint, boardKey };
