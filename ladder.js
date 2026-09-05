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
// Six chapters of eight rungs, calm to ferocious. Every adjective is used once
// across the ladder, so the 48 titles are distinct however the nouns rotate.
const CHAPTER_LENGTH = 8;
const CHAPTERS = [
  { title: '午後窗台', adjectives: ['曬太陽的', '打呵欠的', '軟綿綿的', '愛撒嬌的', '半夢半醒的', '踩奶的', '呼嚕嚕的', '翻肚肚的'] },
  { title: '後院探險', adjectives: ['好奇的', '躡手躡腳的', '追蝴蝶的', '躲貓貓的', '踩水窪的', '爬樹的', '偷魚乾的', '拆紙箱的'] },
  { title: '屋頂散步', adjectives: ['走鋼索的', '看星星的', '跳簷角的', '追月光的', '迎風的', '踏瓦片的', '盯著烏鴉的', '穿過煙囪的'] },
  { title: '深夜巷弄', adjectives: ['謎樣的', '低吼的', '瞇著眼的', '弓起背的', '豎起毛的', '狩獵的', '潛伏的', '閃著綠眼的'] },
  { title: '暴風雨夜', adjectives: ['閃電般的', '怒吼的', '不服輸的', '撲上來的', '狂奔的', '亮爪的', '無所畏懼的', '掀翻一切的'] },
  { title: '貓王殿堂', adjectives: ['傳說中的', '戴王冠的', '威震四方的', '睥睨眾生的', '無人能敵的', '千年一遇的', '掌管宇宙的', '終極的'] }
];
const NOUNS = ['橘貓', '毛球', '窗台', '紙箱', '魚乾', '腳印', '屋頂', '罐罐'];

function rung(index, round = 0, previous = 0) {
  const fraction = LADDER_LENGTH > 1 ? index / (LADDER_LENGTH - 1) : 0;
  const target = FIRST_TARGET * Math.pow(LAST_TARGET / FIRST_TARGET, fraction);
  // Each fruitless round widens the band; the floor never drops below the rung
  // underneath, so the ladder cannot lose its monotonicity.
  return {
    target: Math.round(target),
    lo: Math.max(previous + 1, Math.round(target * (0.8 - 0.15 * round))),
    hi: Math.max(previous + 1, Math.round(target * (1.25 + 0.45 * round))),
    sizes: fraction < 0.12 ? [5, 6] : fraction < 0.3 ? [6, 7] : fraction < 0.5 ? [7, 8] : fraction < 0.7 ? [8, 9] : fraction < 0.85 ? [9, 10] : [11, 12]
  };
}
function ratingOf(puzzle) {
  const rating = rate(puzzle);
  return { score: rating.score, stars: rating.stars, hardest: rating.hardest, hardestName: rating.hardestName, counts: rating.counts, steps: rating.steps };
}
// Purely a function of the rung index, so a rebooted server (and a renamed
// stored ladder) always lands on the same titles. The noun offset skews by
// chapter so the same noun never sits at the same position twice in a row.
function ladderTitle(index) {
  const chapterIndex = Math.floor(index / CHAPTER_LENGTH), stageInChapter = index % CHAPTER_LENGTH;
  const chapter = CHAPTERS[Math.min(chapterIndex, CHAPTERS.length - 1)];
  const noun = NOUNS[(stageInChapter + chapterIndex * 3) % NOUNS.length];
  return {
    name: `${chapter.adjectives[stageInChapter]}${noun}`,
    ladder: { stage: index + 1, chapter: chapter.title, chapterIndex: chapterIndex + 1, chapterStage: stageInChapter + 1, chapterLength: CHAPTER_LENGTH }
  };
}
// A stored ladder is only trusted when it was built by this version and every
// rung still carries a rating; anything else is rebuilt from scratch. Titles
// are re-derived on load, so renaming never touches ids, boards or ratings.
function validLadder(stored) {
  if (!stored || stored.version !== LADDER_VERSION || !Array.isArray(stored.levels)) return [];
  const levels = [];
  for (const level of stored.levels) {
    if (!level?.id || !Array.isArray(level.regions) || !Array.isArray(level.solution) || !level.rating || level.regions.length !== level.size * level.size) break;
    if (levels.length && level.rating.score <= levels[levels.length - 1].rating.score) break;
    levels.push({ ...level, ...ladderTitle(Number.isInteger(level.ladderIndex) ? level.ladderIndex : levels.length) });
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
    const level = { id: makeId(), ...ladderTitle(index), createdAt: Date.now(), ladderIndex: index, rating, ...puzzle };
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

module.exports = { buildLadder, validLadder, ratingOf, rung, ladderTitle, LADDER_VERSION, LADDER_LENGTH };
