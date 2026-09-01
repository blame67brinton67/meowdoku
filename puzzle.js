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

module.exports = { generatePuzzle, countSolutions, findSolutions, clampSize, MIN_SIZE, MAX_SIZE };
