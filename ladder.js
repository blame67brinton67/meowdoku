'use strict';

// The single-player ladder: a fixed sequence of boards whose *rating* — how a
// human has to reason, see difficulty.js — climbs from rung to rung. Boards are
// found by generate-and-filter: generate a candidate, rate it, keep it if it
// lands in the rung's band and is strictly harder than the rung below,
// otherwise throw it away. Size follows a loose plan only, so an easy 9 × 9 can
// sit below a nasty 7 × 7.

const { rate } = require('./difficulty');

// Bumping the version rebuilds the ladder on the next boot.
const LADDER_VERSION = 2;
const LADDER_LENGTH = 48;
// The band ends were picked from the score distribution: a 5 × 5 bottoms out
// around 11 and 10 × 10 boards reach ~230 at p90, so a 22 → 230 sweep spans
// almost the whole realistic range without asking for lottery tickets. Scores
// have a long tail, so the top rungs land wherever the tail allows — the target
// is a guide, monotonicity is the guarantee.
const FIRST_TARGET = 22, LAST_TARGET = 230;
function triesPerRound(size) {
  return size <= 8 ? 150 : size <= 10 ? 40 : 15;
}
const FLAVOURS = ['曬太陽的午後', '滾來滾去的毛球', '謎樣的貓腳印', '深夜的貓步', '傳說中的貓王'];
// Chapters slice the ladder by position; each chapter also fixes the board
// sizes its rungs are drawn from.
const CHAPTERS = [
  { id: 'kitten', name: '新手貓窩', until: 0.12, sizes: [5, 6] },
  { id: 'alley', name: '巷口探險', until: 0.3, sizes: [6, 7] },
  { id: 'rooftop', name: '屋頂漫步', until: 0.5, sizes: [7, 8] },
  { id: 'midnight', name: '深夜貓步', until: 0.7, sizes: [8, 9] },
  { id: 'trial', name: '貓王試煉', until: 0.85, sizes: [9, 10] },
  { id: 'legend', name: '傳說貓王', until: Infinity, sizes: [11, 12] }
];
const fractionOf = index => LADDER_LENGTH > 1 ? index / (LADDER_LENGTH - 1) : 0;
function chapterOf(index) {
  const fraction = fractionOf(index);
  return CHAPTERS.find(chapter => fraction < chapter.until);
}
// Every chapter with its expected rung count and the rungs built so far, so a
// chapter only counts as cleared once all of its rungs exist and are cleared.
function ladderChapters(levels) {
  return CHAPTERS.map(chapter => ({
    id: chapter.id, name: chapter.name,
    total: Array.from({ length: LADDER_LENGTH }, (_, index) => chapterOf(index)).filter(c => c === chapter).length,
    levelIds: levels.filter(level => Number.isInteger(level.ladderIndex) && chapterOf(level.ladderIndex) === chapter).map(level => level.id)
  }));
}

function rung(index, round = 0, previous = 0) {
  const fraction = fractionOf(index);
  const target = FIRST_TARGET * Math.pow(LAST_TARGET / FIRST_TARGET, fraction);
  // Each fruitless round widens the band; the floor never drops below the rung
  // underneath, so the ladder cannot lose its monotonicity.
  return {
    target: Math.round(target),
    lo: Math.max(previous + 1, Math.round(target * (0.8 - 0.15 * round))),
    hi: Math.max(previous + 1, Math.round(target * (1.25 + 0.45 * round))),
    sizes: chapterOf(index).sizes
  };
}
function ratingOf(puzzle) {
  const rating = rate(puzzle);
  return { score: rating.score, stars: rating.stars, hardest: rating.hardest, hardestName: rating.hardestName, counts: rating.counts, steps: rating.steps };
}
function ladderName(index, rating) {
  return `第 ${String(index + 1).padStart(3, '0')} 階 · ${FLAVOURS[Math.min(FLAVOURS.length, rating.stars) - 1]}`;
}
// A stored ladder is only trusted when it was built by this version and every
// rung still carries a rating; anything else is rebuilt from scratch.
function validLadder(stored) {
  if (!stored || stored.version !== LADDER_VERSION || !Array.isArray(stored.levels)) return [];
  const levels = [];
  for (const level of stored.levels) {
    if (!level?.id || !Array.isArray(level.regions) || !Array.isArray(level.solution) || !level.rating || level.regions.length !== level.size * level.size) break;
    if (levels.length && level.rating.score <= levels[levels.length - 1].rating.score) break;
    levels.push(level);
  }
  return levels;
}

// Builds the missing rungs one candidate per tick, so the event loop — and with
// it every socket in a running match — is never held up by generation.
function buildLadder({ levels, generate, makeId, paused, onAccepted, onDone, onProgress }) {
  let index = levels.length;
  let previous = levels.length ? levels[levels.length - 1].rating.score : 0;
  let round = 0, tries = 0, best = null;
  const accept = (puzzle, rating) => {
    const level = { id: makeId(), name: ladderName(index, rating), createdAt: Date.now(), ladderIndex: index, rating, ...puzzle };
    levels.push(level); previous = rating.score; index++; round = 0; tries = 0; best = null;
    onAccepted?.(level);
    setImmediate(tick);
  };
  const tick = async () => {
    if (index >= LADDER_LENGTH) return onDone?.(levels);
    if (paused?.()) return setTimeout(tick, 1000);
    const band = rung(index, round, previous);
    const size = band.sizes[tries % band.sizes.length];
    let puzzle;
    try { puzzle = await generate(size); } catch { return setImmediate(tick); }
    tries++;
    const rating = ratingOf(puzzle);
    // The ceiling matters as much as the floor: accepting a wild outlier from
    // the tail would leave every remaining rung chasing a score it can never
    // reach, so a candidate above the band waits for the band to widen.
    if (rating.score > previous && rating.score <= band.hi) {
      if (rating.score >= band.lo) return accept(puzzle, rating);
      if (!best || rating.score > best.rating.score) best = { puzzle, rating };
    }
    if (tries >= triesPerRound(size)) {
      if (best) return accept(best.puzzle, best.rating);
      round++; tries = 0; onProgress?.({ index, round });
    }
    setImmediate(tick);
  };
  setImmediate(tick);
}

module.exports = { buildLadder, validLadder, ratingOf, rung, chapterOf, ladderChapters, CHAPTERS, LADDER_VERSION, LADDER_LENGTH };
