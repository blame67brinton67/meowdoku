'use strict';

const MIN_SIZE = 4;
const MAX_SIZE = 12;
// A board that still has extra answers after this many repairs is thrown away:
// a fresh board is cheaper than pushing a stubborn one further.
const REPAIR_BUDGET_PER_CELL = 1;

function clampSize(size) {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(size) || 7));
}
function randomInt(bound) { return Math.floor(Math.random() * bound); }
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function neighbors(index, size) {
  const row = Math.floor(index / size), col = index % size, result = [];
  if (row) result.push(index - size);
  if (row < size - 1) result.push(index + size);
  if (col) result.push(index - 1);
  if (col < size - 1) result.push(index + 1);
  return result;
}

// One cat per row and per column, and no two cats in the same 3 × 3 window,
// which for a one-cat-per-row board means neighbouring rows keep their columns
// at least two apart. Backtracking (instead of a greedy row scan) never fails.
function randomSolutionColumns(size) {
  const columns = new Array(size);
  const usedColumns = new Uint8Array(size);
  function place(row) {
    if (row === size) return true;
    const previous = row ? columns[row - 1] : -99;
    const candidates = [];
    for (let col = 0; col < size; col++) {
      if (!usedColumns[col] && Math.abs(previous - col) > 1) candidates.push(col);
    }
    shuffle(candidates);
    for (const col of candidates) {
      columns[row] = col; usedColumns[col] = 1;
      if (place(row + 1)) return true;
      usedColumns[col] = 0;
    }
    return false;
  }
  return place(0) ? columns : null;
}

// Every region grows from its own cat. Regions draw their own area target and
// their own "snakiness" (how strongly growth follows the most recent cell), so
// a board mixes fat blobs with narrow corridors instead of the near-identical
// patches a plain round-robin multi-source BFS produces.
function regionShape(size) {
  const average = size;
  return { floor: Math.max(2, Math.round(average / 2.5)), ceiling: Math.round(average * 2.5) };
}
function growRegions(size, cats, { floor, ceiling }) {
  const cells = size * size;
  const regions = new Int8Array(cells).fill(-1);
  const weights = cats.map(() => 0.5 + Math.random() * 1.3);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const targets = weights.map(weight => (weight / weightTotal) * cells);
  const snakiness = cats.map(() => Math.random() * 0.85);
  const frontiers = cats.map((cell, region) => {
    regions[cell] = region;
    return neighbors(cell, size).slice();
  });
  const areas = cats.map(() => 1);

  let unassigned = cells - cats.length;
  while (unassigned) {
    let weightSum = 0;
    const open = [];
    for (let region = 0; region < frontiers.length; region++) {
      const frontier = frontiers[region];
      while (frontier.length && regions[frontier[frontier.length - 1]] !== -1) frontier.pop();
      if (!frontier.length) continue;
      // Undersized regions are served first so nothing gets walled in at one
      // or two cells; oversized ones stay in the race with a token weight so
      // the board always fills even when every hungry region is boxed in.
      const appetite = areas[region] < floor ? 12
        : areas[region] >= ceiling ? 0.02
        : Math.max(0.05, targets[region] - areas[region]);
      weightSum += appetite;
      open.push({ region, appetite });
    }
    if (!open.length) return null;

    let pick = Math.random() * weightSum, chosen = open[open.length - 1].region;
    for (const entry of open) {
      pick -= entry.appetite;
      if (pick <= 0) { chosen = entry.region; break; }
    }
    const frontier = frontiers[chosen];
    const index = Math.random() < snakiness[chosen] ? frontier.length - 1 : randomInt(frontier.length);
    const cell = frontier[index];
    frontier[index] = frontier[frontier.length - 1]; frontier.pop();
    if (regions[cell] !== -1) continue;

    regions[cell] = chosen; areas[chosen]++; unassigned--;
    for (const next of neighbors(cell, size)) if (regions[next] === -1) frontier.push(next);
  }
  // A colour boxed in at its own cat would give that cat away for free.
  if (areas.some(area => area < 2)) return null;
  return Array.from(regions);
}

// Rows are scanned top down, so only the previous row can hold a cat inside the
// same 3 × 3 window; columns and regions are tracked as bitmasks.
function findSolutions(regions, size, stopAt = 2) {
  const found = [];
  const columns = new Array(size);
  const regionBitOf = new Uint32Array(size * size), regionsFrom = new Uint32Array(size + 1);
  let allRegions = 0;
  for (let cell = 0; cell < regionBitOf.length; cell++) {
    regionBitOf[cell] = 1 << regions[cell]; allRegions |= regionBitOf[cell];
  }
  for (let row = size - 1; row >= 0; row--) {
    let rowRegions = 0;
    for (let col = 0; col < size; col++) rowRegions |= regionBitOf[row * size + col];
    regionsFrom[row] = regionsFrom[row + 1] | rowRegions;
  }
  let usedColumns = 0, usedRegions = 0;
  function search(row, previousCol) {
    if (found.length >= stopAt) return;
    if (row === size) { found.push(columns.slice()); return; }
    if ((allRegions & ~usedRegions) & ~regionsFrom[row]) return;
    for (let col = 0; col < size; col++) {
      if (usedColumns & (1 << col)) continue;
      if (previousCol >= 0 && Math.abs(previousCol - col) <= 1) continue;
      const regionBit = regionBitOf[row * size + col];
      if (usedRegions & regionBit) continue;
      usedColumns |= 1 << col; usedRegions |= regionBit; columns[row] = col;
      search(row + 1, col);
      usedColumns &= ~(1 << col); usedRegions &= ~regionBit;
      if (found.length >= stopAt) return;
    }
  }
  search(0, -1);
  return found;
}
function countSolutions(regions, size, stopAt = 2) {
  return findSolutions(regions, size, stopAt).length;
}

function regionStaysConnectedWithout(regions, size, region, removed) {
  const members = [];
  for (let cell = 0; cell < regions.length; cell++) if (regions[cell] === region && cell !== removed) members.push(cell);
  if (members.length < 2) return members.length === 1;
  const seen = new Set([members[0]]);
  const queue = [members[0]];
  while (queue.length) {
    for (const next of neighbors(queue.pop(), size)) {
      if (next === removed || regions[next] !== region || seen.has(next)) continue;
      seen.add(next); queue.push(next);
    }
  }
  return seen.size === members.length;
}

// Repairing beats resampling: moving one cell of an unwanted solution into a
// neighbouring colour destroys that solution — the colour it leaves keeps no
// cat, the colour it joins gets two — while the intended answer survives
// untouched, because none of its own cats ever move. Each step therefore makes
// real progress, whereas the previous generator threw the whole board away.
function breakAlternateSolution(regions, size, solutionColumns, alternate, { floor, ceiling }) {
  const areas = new Array(size).fill(0);
  for (const region of regions) areas[region]++;
  const candidates = [];
  for (let row = 0; row < size; row++) {
    if (alternate[row] !== solutionColumns[row]) candidates.push(row * size + alternate[row]);
  }
  for (const cell of shuffle(candidates)) {
    const region = regions[cell];
    // A one-cell colour would hand its cat to the player, so colours never
    // shrink past two cells.
    if (areas[region] <= 2 || !regionStaysConnectedWithout(regions, size, region, cell)) continue;
    const targets = [...new Set(neighbors(cell, size).map(next => regions[next]))].filter(next => next !== region);
    if (!targets.length) continue;
    // Prefer a home that keeps both colours inside the intended size band.
    const penalty = target => (areas[region] - 1 < floor ? 1 : 0) + (areas[target] + 1 > ceiling ? 1 : 0);
    regions[cell] = shuffle(targets).sort((a, b) => penalty(a) - penalty(b))[0];
    return true;
  }
  return false;
}

function generatePuzzle(size = 7) {
  size = clampSize(size);
  const repairBudget = size * size * REPAIR_BUDGET_PER_CELL;
  for (let attempt = 0; attempt < 5000; attempt++) {
    const columns = randomSolutionColumns(size);
    if (!columns) continue;
    const cats = columns.map((col, row) => row * size + col);
    const shape = regionShape(size);
    const regions = growRegions(size, cats, shape);
    if (!regions) continue;

    // Every repair kills at least one unwanted solution, so the loop always
    // makes progress; a board that still has extras once the budget runs out is
    // abandoned in favour of a fresh one.
    for (let repair = 0; repair <= repairBudget; repair++) {
      const solutions = findSolutions(regions, size, 2);
      if (solutions.length === 1) {
        return { size, regions, solution: cats.map(cell => ({ row: Math.floor(cell / size), col: cell % size })) };
      }
      const alternate = solutions.find(candidate => candidate.some((col, row) => col !== columns[row]));
      if (!alternate || !breakAlternateSolution(regions, size, columns, alternate, shape)) break;
    }
  }
  throw new Error('無法產生唯一解關卡');
}

// The answer row is lightly obscured so nobody spoils a puzzle by glancing at
// shared text. It is not protection: anyone can decode it.
const ANSWER_PREFIX = 'answer:', ANSWER_NOTE = '# 下一行是 base64 編碼的答案，避免不小心瞄到；匯入時原樣貼上即可。';
function encodeAnswerLine(line) { return ANSWER_PREFIX + Buffer.from(line, 'utf8').toString('base64'); }
function decodeAnswerLine(line) {
  if (!line.startsWith(ANSWER_PREFIX)) return line;
  const encoded = line.slice(ANSWER_PREFIX.length).trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw new Error('答案行的編碼格式不正確。');
  return Buffer.from(encoded, 'base64').toString('utf8').trim();
}
// Every problem is reported, not just the first: an admin fixing a hand-typed
// board wants the whole list. Checks that depend on a broken earlier stage
// (a malformed row makes region checks meaningless) are skipped instead.
function validateBoardText(text) {
  const errors = [];
  if (typeof text !== 'string') return { errors: ['地圖文字必須是文字格式。'], puzzle: null };
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (lines.length < MIN_SIZE + 1 || lines.length > MAX_SIZE + 1) {
    return { errors: [`地圖需要 ${MIN_SIZE + 1} 至 ${MAX_SIZE + 1} 行非空文字（目前 ${lines.length} 行）。`], puzzle: null };
  }
  const size = lines.length - 1;
  function values(line, lineNumber) {
    const compact = line.match(/^\d+$/);
    const parts = compact && size <= 9 ? [...line] : line.split(/[ \t]+/);
    if (parts.length !== size) { errors.push(`第 ${lineNumber} 行必須有 ${size} 個數值（目前 ${parts.length} 個）。`); return null; }
    if (!parts.every(part => /^\d+$/.test(part))) { errors.push(`第 ${lineNumber} 行包含無效的整數。`); return null; }
    return parts.map(Number);
  }
  const grid = lines.slice(0, size).map((line, index) => values(line, index + 1));
  let answer = null;
  try { answer = values(decodeAnswerLine(lines[size]), size + 1); } catch (error) { errors.push(error.message); }
  let regions = null, solution = null, solvable = true;
  if (grid.every(Boolean)) {
    grid.forEach((row, r) => row.forEach((region, c) => {
      if (region < 1 || region > size) errors.push(`第 ${r + 1} 行第 ${c + 1} 格：區域編號必須介於 1 和 ${size} 之間（目前 ${region}）。`);
    }));
    if (!errors.some(error => error.includes('區域編號'))) {
      regions = grid.flat().map(region => region - 1);
      const used = new Set(regions);
      const missing = [];
      for (let region = 0; region < size; region++) if (!used.has(region)) missing.push(region + 1);
      if (missing.length) { errors.push(`地圖必須使用每一個區域編號，不能跳號（缺少區域 ${missing.join('、')}）。`); solvable = false; }
      for (let region = 0; region < size; region++) {
        const start = regions.indexOf(region);
        if (start < 0) continue;
        const seen = new Set([start]), queue = [start];
        while (queue.length) for (const next of neighbors(queue.pop(), size)) {
          if (regions[next] !== region || seen.has(next)) continue;
          seen.add(next); queue.push(next);
        }
        const total = regions.filter(value => value === region).length;
        if (seen.size !== total) {
          const stray = regions.map((value, cell) => value === region && !seen.has(cell) ? `第 ${Math.floor(cell / size) + 1} 行第 ${cell % size + 1} 格` : null).filter(Boolean);
          errors.push(`區域 ${region + 1} 必須是正交連通的（${stray.slice(0, 4).join('、')}${stray.length > 4 ? ' 等' : ''}與主體不相連）。`);
          solvable = false;
        }
      }
    }
  }
  if (answer) {
    const outOfRange = answer.map((column, row) => column < 1 || column > size ? row + 1 : null).filter(Boolean);
    const seenColumns = new Map();
    answer.forEach((column, row) => { if (!seenColumns.has(column)) seenColumns.set(column, []); seenColumns.get(column).push(row + 1); });
    const duplicates = [...seenColumns].filter(([, rows]) => rows.length > 1);
    if (outOfRange.length || duplicates.length) {
      const detail = [...outOfRange.map(row => `第 ${row} 行的數值超出範圍`), ...duplicates.map(([column, rows]) => `第 ${rows.join('、')} 行的貓都在第 ${column} 列`)];
      errors.push(`答案必須是 1 到 ${size} 的不重複排列（${detail.join('；')}）。`);
    } else {
      solution = answer.map((column, row) => ({ row, col: column - 1 }));
      for (let row = 0; row < size - 1; row++) {
        if (Math.abs(solution[row].col - solution[row + 1].col) <= 1) errors.push(`答案中的貓咪不能在八方向相鄰（第 ${row + 1} 行第 ${solution[row].col + 1} 格與第 ${row + 2} 行第 ${solution[row + 1].col + 1} 格）。`);
      }
      if (regions) {
        const catsIn = Array.from({ length: size }, () => []);
        solution.forEach(cat => catsIn[regions[cat.row * size + cat.col]].push(cat.row + 1));
        const wrong = catsIn.map((rows, region) => rows.length === 1 ? null : rows.length ? `區域 ${region + 1} 有 ${rows.length} 隻（第 ${rows.join('、')} 行）` : `區域 ${region + 1} 沒有貓`).filter(Boolean);
        if (wrong.length) errors.push(`答案必須在每個區域各放一隻貓（${wrong.join('；')}）。`);
      }
    }
  }
  // Counting solutions on a malformed region map would only echo the errors
  // already listed above.
  if (regions && solvable) {
    const solutions = countSolutions(regions, size, 2);
    if (!solutions) errors.push('地圖規則互相矛盾，沒有可行答案。');
    if (solutions > 1) errors.push('地圖不唯一，存在兩組以上可行答案。');
  }
  return { errors, puzzle: errors.length ? null : { size, regions, solution } };
}
function parseBoardText(text) {
  const { errors, puzzle } = validateBoardText(text);
  if (errors.length) throw new Error(errors[0]);
  return puzzle;
}
// Keep in sync with formatPuzzleText in public/app.js.
function formatBoardText(puzzle, { encodeAnswer = false } = {}) {
  const rows = [];
  for (let row = 0; row < puzzle.size; row++) rows.push(puzzle.regions.slice(row * puzzle.size, (row + 1) * puzzle.size).map(region => region + 1).join(' '));
  const answer = puzzle.solution.map(cat => cat.col + 1).join(' ');
  if (encodeAnswer) rows.push(ANSWER_NOTE, encodeAnswerLine(answer)); else rows.push(answer);
  return rows.join('\n');
}

module.exports = { generatePuzzle, countSolutions, findSolutions, clampSize, MIN_SIZE, MAX_SIZE, parseBoardText, validateBoardText, formatBoardText, encodeAnswerLine, decodeAnswerLine, ANSWER_PREFIX, ANSWER_NOTE };
