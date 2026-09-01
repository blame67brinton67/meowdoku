'use strict';

// A rater that scores a board by *how a human has to reason*, not by size. It
// solves the board the way a player does: at every step it looks for the
// cheapest technique that still yields a new deduction, applies everything that
// technique sees in that pass, and pays its price. Never reaching for an
// expensive technique while a cheap one still has work to do is what makes the
// total meaningful — a 6 × 6 that forces contradiction hunting outranks a
// 10 × 10 that falls to single candidates alone.
//
// Techniques (unit = a row, a column or a colour region; each holds one cat):
//   R1 propagation   free bookkeeping after a placement, never scored
//   R2 唯一格        a unit has one candidate left → place                    1
//   R3 色塊鎖行      confinement with x = 1 (region ↔ line)                    5
//   R4 區塊排除      confinement with x ≥ 2 (Hall/subset)        5 + 8·(x − 1)
//   R5 矛盾排除      tentative placement leaves a unit empty → eliminate      15
//   R6 交集排除      all y candidates of a unit kill z → eliminate z 10 + 5·(y − 2)
//   R7 需要試誤      nothing applies → branch                      80 · 2^(d − 1)
//
// A "pass" (one application) is charged once, no matter how many cells it
// resolves, because the hard part for a human is spotting the pattern, not
// crossing off the cells it implies.

const RULES = {
  2: { name: '唯一格', cost: () => 1 },
  3: { name: '色塊鎖行', cost: () => 5 },
  4: { name: '區塊排除', cost: x => 5 + 8 * (x - 1) },
  5: { name: '矛盾排除', cost: () => 15 },
  6: { name: '交集排除', cost: y => 10 + 5 * (y - 2) },
  7: { name: '需要試誤', cost: depth => 80 * Math.pow(2, depth - 1) }
};
const UNKNOWN = 0, CAT = 1, GONE = 2;
const MAX_GUESS_DEPTH = 6, MAX_STEPS = 4000;

// Empirical star cut points, read off the score distribution of 2400 generated
// boards (400 each for sizes 5–10; the per-size summary is in the PR). They are
// the pooled p20 / p40 / p65 / p88, so a random board is 1★ a fifth of the
// time, 2★ a fifth, 3★ a quarter, 4★ a quarter, and 5★ the top eighth. Nothing
// here is guessed: pooled min 10, median 58, p95 246, max 2578.
const STAR_THRESHOLDS = [38, 51, 71, 121];

function starsFor(score) {
  let stars = 1;
  for (const threshold of STAR_THRESHOLDS) if (score >= threshold) stars++;
  return stars;
}

// Placing a cat on a cell rules out the rest of its row, column and region plus
// its eight neighbours; the sets never change, so they are built once per board.
function buildBoard(size, regions) {
  const cells = size * size;
  const rows = [], cols = [], regionCells = [];
  for (let i = 0; i < size; i++) { rows.push([]); cols.push([]); regionCells.push([]); }
  for (let cell = 0; cell < cells; cell++) {
    rows[Math.floor(cell / size)].push(cell); cols[cell % size].push(cell); regionCells[regions[cell]].push(cell);
  }
  const elim = [];
  for (let cell = 0; cell < cells; cell++) {
    const row = Math.floor(cell / size), col = cell % size, set = new Set();
    for (const other of rows[row]) set.add(other);
    for (const other of cols[col]) set.add(other);
    for (const other of regionCells[regions[cell]]) set.add(other);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr, c = col + dc;
      if (r >= 0 && r < size && c >= 0 && c < size) set.add(r * size + c);
    }
    set.delete(cell);
    elim.push(Int16Array.from(set));
  }
  // Units are indexed rows, then columns, then regions, so a unit's kind is its
  // index divided by the board size.
  const units = [...rows, ...cols, ...regionCells].map(list => Int16Array.from(list));
  const unitsOfCell = [];
  for (let cell = 0; cell < cells; cell++) unitsOfCell.push([Math.floor(cell / size), size + (cell % size), 2 * size + regions[cell]]);
  return { size, cells, regions, elim, units, unitsOfCell };
}

function freshState(board) {
  return { cell: new Uint8Array(board.cells), solved: new Uint8Array(board.units.length), cats: 0, dead: false };
}
function cloneState(state) {
  return { cell: state.cell.slice(), solved: state.solved.slice(), cats: state.cats, dead: state.dead };
}
// R1: the free bookkeeping every placement drags along.
function place(board, state, cell) {
  if (state.cell[cell] === GONE) { state.dead = true; return 0; }
  if (state.cell[cell] === CAT) return 0;
  state.cell[cell] = CAT; state.cats++;
  for (const unit of board.unitsOfCell[cell]) state.solved[unit] = 1;
  let removed = 0;
  for (const other of board.elim[cell]) if (state.cell[other] === UNKNOWN) { state.cell[other] = GONE; removed++; }
  return removed;
}
function candidatesOf(board, state, unit) {
  const list = [];
  if (state.solved[unit]) return list;
  for (const cell of board.units[unit]) if (state.cell[cell] === UNKNOWN) list.push(cell);
  return list;
}
function hasEmptyUnit(board, state) {
  for (let unit = 0; unit < board.units.length; unit++) {
    if (state.solved[unit]) continue;
    let any = false;
    for (const cell of board.units[unit]) if (state.cell[cell] === UNKNOWN) { any = true; break; }
    if (!any) return true;
  }
  return false;
}

// R2 — single candidate. Everything visible in this pass is placed at once.
function applySingles(board, state) {
  let placements = 0;
  for (let unit = 0; unit < board.units.length; unit++) {
    if (state.solved[unit]) continue;
    const candidates = candidatesOf(board, state, unit);
    if (candidates.length !== 1) continue;
    place(board, state, candidates[0]); placements++;
    if (state.dead) return placements;
  }
  return placements;
}

// R3 / R4 — confinement. With x = 1 this is "a colour's candidates all sit in
// one line" (and its mirror); with x ≥ 2 it is Hall's argument: if x colours
// fit inside x lines, those lines belong to those colours and to nobody else.
function lineMasksFor(board, state, axis) {
  // axis 0 = rows, 1 = columns. Returns, per region, the mask of lines its
  // candidates touch, and per line the mask of regions its candidates touch.
  const size = board.size;
  const regionToLine = new Array(size).fill(0), lineToRegion = new Array(size).fill(0);
  for (let cell = 0; cell < board.cells; cell++) {
    if (state.cell[cell] !== UNKNOWN) continue;
    const region = board.regions[cell], line = axis ? cell % size : Math.floor(cell / size);
    regionToLine[region] |= 1 << line; lineToRegion[line] |= 1 << region;
  }
  return { regionToLine, lineToRegion };
}
function popcount(mask) { let n = 0; while (mask) { mask &= mask - 1; n++; } return n; }
function combinations(items, size) {
  const out = [];
  const walk = (start, picked) => {
    if (picked.length === size) { out.push(picked.slice()); return; }
    for (let i = start; i < items.length; i++) { picked.push(items[i]); walk(i + 1, picked); picked.pop(); }
  };
  walk(0, []);
  return out;
}
function applyConfinement(board, state, x) {
  const size = board.size;
  let removed = 0;
  for (let axis = 0; axis < 2; axis++) {
    const { regionToLine, lineToRegion } = lineMasksFor(board, state, axis);
    const liveRegions = [], liveLines = [];
    for (let i = 0; i < size; i++) {
      if (!state.solved[2 * size + i] && regionToLine[i]) liveRegions.push(i);
      if (!state.solved[axis * size + i] && lineToRegion[i]) liveLines.push(i);
    }
    // Regions confined to lines: the lines can hold no other colour's cat.
    for (const group of combinations(liveRegions, x)) {
      let lines = 0;
      for (const region of group) lines |= regionToLine[region];
      if (popcount(lines) !== x) continue;
      const inGroup = group.reduce((mask, region) => mask | (1 << region), 0);
      for (let cell = 0; cell < board.cells; cell++) {
        if (state.cell[cell] !== UNKNOWN) continue;
        const line = axis ? cell % size : Math.floor(cell / size);
        if (!(lines & (1 << line))) continue;
        if (inGroup & (1 << board.regions[cell])) continue;
        state.cell[cell] = GONE; removed++;
      }
    }
    // The mirror: lines confined to regions, so those colours live only there.
    for (const group of combinations(liveLines, x)) {
      let regionMask = 0;
      for (const line of group) regionMask |= lineToRegion[line];
      if (popcount(regionMask) !== x) continue;
      const inGroup = group.reduce((mask, line) => mask | (1 << line), 0);
      for (let cell = 0; cell < board.cells; cell++) {
        if (state.cell[cell] !== UNKNOWN) continue;
        if (!(regionMask & (1 << board.regions[cell]))) continue;
        const line = axis ? cell % size : Math.floor(cell / size);
        if (inGroup & (1 << line)) continue;
        state.cell[cell] = GONE; removed++;
      }
    }
  }
  return removed;
}

// R5 — placement contradiction: put a cat down, look only at what it rules out,
// and throw the cell away if some unit is left with nowhere to go.
function applyContradiction(board, state) {
  const doomed = [];
  for (let cell = 0; cell < board.cells; cell++) {
    if (state.cell[cell] !== UNKNOWN) continue;
    const trial = cloneState(state);
    place(board, trial, cell);
    if (trial.dead || hasEmptyUnit(board, trial)) doomed.push(cell);
  }
  for (const cell of doomed) if (state.cell[cell] === UNKNOWN) state.cell[cell] = GONE;
  return doomed.length;
}

// R6 — common elimination: if every candidate of a unit kills the same cell,
// that cell is dead whichever candidate turns out to be the cat.
function applyCommonElimination(board, state, y) {
  const hits = new Uint8Array(board.cells);
  let removed = 0;
  for (let unit = 0; unit < board.units.length; unit++) {
    if (state.solved[unit]) continue;
    const candidates = candidatesOf(board, state, unit);
    if (candidates.length !== y) continue;
    hits.fill(0);
    for (const candidate of candidates) for (const other of board.elim[candidate]) if (state.cell[other] === UNKNOWN) hits[other]++;
    for (let cell = 0; cell < board.cells; cell++) {
      if (hits[cell] === y && state.cell[cell] === UNKNOWN) { state.cell[cell] = GONE; removed++; }
    }
  }
  return removed;
}

// Techniques are tried strictly in price order, so R6 with four candidates
// (cost 20) really does come before a triple confinement (cost 21).
function tiersFor(size) {
  const tiers = [{ rule: 2, param: 1, cost: RULES[2].cost() }, { rule: 3, param: 1, cost: RULES[3].cost() }];
  for (let x = 2; x <= Math.min(4, size - 1); x++) tiers.push({ rule: 4, param: x, cost: RULES[4].cost(x) });
  tiers.push({ rule: 5, param: 1, cost: RULES[5].cost() });
  for (let y = 2; y <= size; y++) tiers.push({ rule: 6, param: y, cost: RULES[6].cost(y) });
  return tiers.sort((a, b) => a.cost - b.cost || a.rule - b.rule);
}
function runTier(board, state, tier) {
  if (tier.rule === 2) return applySingles(board, state);
  if (tier.rule === 3) return applyConfinement(board, state, 1);
  if (tier.rule === 4) return applyConfinement(board, state, tier.param);
  if (tier.rule === 5) return applyContradiction(board, state);
  return applyCommonElimination(board, state, tier.param);
}

function emptyCounts() { return { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }; }

// Solves `state`, charging every technique it needs. Failed guess branches only
// cost their guess; the work wasted inside them is not charged, because a human
// abandons a line as soon as it breaks.
function solve(board, state, depth, budget) {
  const result = { ok: false, score: 0, counts: emptyCounts(), steps: [], cats: null };
  const tiers = budget.tiers;
  for (;;) {
    if (budget.steps++ > MAX_STEPS) { budget.exhausted = true; return result; }
    if (state.dead || hasEmptyUnit(board, state)) return result;
    if (state.cats === board.size) {
      result.ok = true;
      result.cats = [];
      for (let cell = 0; cell < board.cells; cell++) if (state.cell[cell] === CAT) result.cats.push({ row: Math.floor(cell / board.size), col: cell % board.size });
      return result;
    }
    let fired = null;
    for (const tier of tiers) {
      const before = state.cats;
      const deductions = runTier(board, state, tier);
      if (!deductions) continue;
      fired = { rule: tier.rule, param: tier.param, cost: tier.cost, deductions, placements: state.cats - before };
      break;
    }
    if (fired) {
      result.score += fired.cost; result.counts[fired.rule]++;
      result.steps.push(fired);
      continue;
    }
    // R7 — nothing left but a guess.
    if (depth >= MAX_GUESS_DEPTH) { budget.exhausted = true; return result; }
    let best = null;
    for (let unit = 0; unit < board.units.length; unit++) {
      if (state.solved[unit]) continue;
      const candidates = candidatesOf(board, state, unit);
      if (!best || candidates.length < best.length) best = candidates;
    }
    if (!best || !best.length) return result;
    const guessCost = RULES[7].cost(depth + 1);
    for (const candidate of best) {
      const branch = cloneState(state);
      place(board, branch, candidate);
      result.score += guessCost; result.counts[7]++;
      result.steps.push({ rule: 7, param: depth + 1, cost: guessCost, deductions: 1, placements: 1 });
      const nested = solve(board, branch, depth + 1, budget);
      if (!nested.ok) continue;
      result.ok = true; result.cats = nested.cats;
      result.score += nested.score;
      for (const rule of Object.keys(nested.counts)) result.counts[rule] += nested.counts[rule];
      result.steps.push(...nested.steps);
      return result;
    }
    return result;
  }
}

// Secondary human-difficulty signals. They are deliberately tiny (each capped
// well below the price of a single R4/R5 pass) so they only break ties between
// boards the rule ladder rates the same.
function extraTerms(board, steps) {
  // Opening width: how many cats fall out of R2 before any real technique is
  // needed. A board that hands you five free cats feels friendly even if the
  // endgame is nasty; one that forces thinking on move one does not. On an empty
  // board no cell is eliminated yet, so a unit can only have a single candidate
  // when a colour occupies a single cell — which the generator never produces.
  // The strict reading of the signal is therefore 0 for every generated board
  // and would only add a constant, so the scored term uses the width of the
  // *cheap* opening instead: the cats R2 hands over before the first pass that
  // costs more than a plain confinement.
  let opening = 0, cheapOpening = 0, cheapPhase = true;
  for (const step of steps) { if (step.rule !== 2) break; opening += step.placements; }
  for (const step of steps) {
    if (step.cost > 5) cheapPhase = false;
    if (cheapPhase && step.rule === 2) cheapOpening += step.placements;
  }
  // Average branching: a step offering one forced move is harder to *find* than
  // a step where ten cells are obviously dead.
  const branching = steps.length ? steps.reduce((sum, step) => sum + step.deductions, 0) / steps.length : 1;
  // Chain depth: the longest run of eliminations with no placement to confirm
  // you are still on track.
  let chain = 0, run = 0;
  for (const step of steps) { run = step.placements ? 0 : run + 1; chain = Math.max(chain, run); }
  // Region irregularity: a colour spanning many rows and columns for its area
  // is a snake, and snakes are harder to reason about than blobs.
  const size = board.size;
  const spans = new Array(size).fill(null).map(() => ({ area: 0, rows: new Set(), cols: new Set() }));
  for (let cell = 0; cell < board.cells; cell++) {
    const span = spans[board.regions[cell]];
    span.area++; span.rows.add(Math.floor(cell / size)); span.cols.add(cell % size);
  }
  const irregularity = spans.reduce((sum, span) => sum + (span.rows.size + span.cols.size) / (2 * Math.sqrt(span.area)), 0) / size;
  const terms = {
    opening: 2 * Math.max(0, 5 - cheapOpening),
    branching: Math.min(8, Math.round(12 / Math.max(1, branching))),
    chain: Math.min(10, chain),
    irregularity: Math.round(Math.min(8, Math.max(0, irregularity - 1) * 12))
  };
  return { terms, opening, cheapOpening, branching: Number(branching.toFixed(2)), chain, irregularity: Number(irregularity.toFixed(3)) };
}

function rate({ size, regions }) {
  const board = buildBoard(size, regions);
  const budget = { steps: 0, exhausted: false, tiers: tiersFor(size) };
  const solved = solve(board, freshState(board), 0, budget);
  const { terms, opening, cheapOpening, branching, chain, irregularity } = extraTerms(board, solved.steps);
  const base = solved.score;
  const extra = terms.opening + terms.branching + terms.chain + terms.irregularity;
  const score = base + extra;
  let hardest = 2;
  for (const rule of [2, 3, 4, 5, 6, 7]) if (solved.counts[rule]) hardest = Math.max(hardest, rule);
  // The single most expensive pass the board demanded, so a caller can tell a
  // pair-sized confinement from a quadruple one.
  const peak = solved.steps.reduce((worst, step) => (!worst || step.cost > worst.cost ? { rule: step.rule, param: step.param, cost: step.cost } : worst), null);
  return {
    peak,
    solved: solved.ok, exhausted: budget.exhausted, score, base, extra, terms,
    counts: solved.counts, hardest, hardestName: RULES[hardest].name, stars: starsFor(score),
    steps: solved.steps.length, signals: { opening, cheapOpening, branching, chain, irregularity },
    solution: solved.cats
  };
}

module.exports = { rate, starsFor, STAR_THRESHOLDS, RULES, buildBoard };
