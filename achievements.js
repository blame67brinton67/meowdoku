'use strict';
const { CHAPTERS } = require('./ladder');

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_AVATAR = '🐱', DEFAULT_FRAME = 'plain';
const AVATARS = ['🐱', '🐈', '🐈‍⬛', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🐯', '🦁', '🐾', '🎩'];
// Frames are drawn purely in CSS (`.frame-<id>` in styles.css); every frame but
// `plain` is the reward of exactly one achievement below.
const FRAMES = [
  { id: 'plain', name: '素面' },
  { id: 'wood', name: '木框' },
  { id: 'leaf', name: '綠葉' },
  { id: 'bronze', name: '青銅' },
  { id: 'silver', name: '白銀' },
  { id: 'gold', name: '黃金' },
  { id: 'ribbon', name: '緞帶' },
  { id: 'star', name: '星光' },
  { id: 'crown', name: '王冠' },
  { id: 'flame', name: '烈焰' },
  { id: 'lightning', name: '閃電' },
  { id: 'rainbow', name: '彩虹' },
  { id: 'moon', name: '月夜' }
];

const single = stats => stats.event.kind === 'single';
const match = stats => stats.event.kind === 'match';
const speed = (size, seconds) => stats => single(stats) && stats.event.size === size && stats.event.ms <= seconds * 1000;
const chapter = id => stats => stats.chaptersCleared.has(id);

const ACHIEVEMENTS = [
  { id: 'clear_1', name: '第一隻貓', description: '通關任意 1 個單人關卡', frame: 'wood', check: stats => stats.cleared >= 1 },
  { id: 'clear_5', name: '五隻貓', description: '通關 5 個單人關卡', frame: null, check: stats => stats.cleared >= 5 },
  { id: 'clear_10', name: '十隻貓', description: '通關 10 個單人關卡', frame: 'bronze', check: stats => stats.cleared >= 10 },
  { id: 'clear_25', name: '貓群領袖', description: '通關 25 個單人關卡', frame: 'silver', check: stats => stats.cleared >= 25 },
  { id: 'clear_48', name: '登頂', description: '通關 48 個單人關卡', frame: 'gold', check: stats => stats.cleared >= 48 },
  { id: 'chapter_kitten', name: '離開貓窩', description: '通關「新手貓窩」章節的所有關卡', frame: 'leaf', check: chapter('kitten') },
  { id: 'chapter_alley', name: '巷口熟客', description: '通關「巷口探險」章節的所有關卡', frame: null, check: chapter('alley') },
  { id: 'chapter_rooftop', name: '屋頂常客', description: '通關「屋頂漫步」章節的所有關卡', frame: null, check: chapter('rooftop') },
  { id: 'chapter_midnight', name: '夜行貓', description: '通關「深夜貓步」章節的所有關卡', frame: null, check: chapter('midnight') },
  { id: 'chapter_trial', name: '通過試煉', description: '通關「貓王試煉」章節的所有關卡', frame: null, check: chapter('trial') },
  { id: 'chapter_legend', name: '傳說貓王', description: '通關「傳說貓王」章節的所有關卡', frame: 'crown', check: chapter('legend') },
  { id: 'flawless_10', name: '零失誤', description: '在 10 個單人關卡中一次都沒點錯就通關', frame: null, check: stats => stats.flawless >= 10 },
  { id: 'nohint_20', name: '不靠提示', description: '不使用提示通關 20 個單人關卡', frame: null, check: stats => stats.noHint >= 20 },
  { id: 'big_11', name: '大盤面', description: '通關任一 11 × 11 單人關卡', frame: null, check: stats => single(stats) && stats.event.size === 11 },
  { id: 'big_12', name: '超大盤面', description: '通關任一 12 × 12 單人關卡', frame: 'rainbow', check: stats => single(stats) && stats.event.size === 12 },
  { id: 'speed_7_60', name: '快手', description: '在 60 秒內通關一個 7 × 7 單人關卡', frame: null, check: speed(7, 60) },
  { id: 'speed_9_120', name: '疾風', description: '在 120 秒內通關一個 9 × 9 單人關卡', frame: null, check: speed(9, 120) },
  { id: 'speed_12_300', name: '閃電貓', description: '在 300 秒內通關一個 12 × 12 單人關卡', frame: 'lightning', check: speed(12, 300) },
  { id: 'matches_1', name: '初次參賽', description: '參加 1 場多人對戰', frame: null, check: stats => stats.matches >= 1 },
  { id: 'matches_10', name: '常客', description: '參加 10 場多人對戰', frame: 'ribbon', check: stats => stats.matches >= 10 },
  { id: 'matches_50', name: '老將', description: '參加 50 場多人對戰', frame: null, check: stats => stats.matches >= 50 },
  { id: 'wins_1', name: '第一名！', description: '在多人對戰中拿下 1 次第一名', frame: 'star', check: stats => stats.wins >= 1 },
  { id: 'wins_10', name: '常勝貓', description: '在多人對戰中拿下 10 次第一名', frame: null, check: stats => stats.wins >= 10 },
  { id: 'streak_3', name: '三連霸', description: '連續 3 場多人對戰拿下第一名', frame: null, check: stats => stats.streak >= 3 },
  { id: 'streak_5', name: '五連霸', description: '連續 5 場多人對戰拿下第一名', frame: 'flame', check: stats => stats.streak >= 5 },
  { id: 'eliminated_1', name: '貓咪的尊嚴', description: '在多人對戰中被淘汰 1 次（沒關係，再來一場）', frame: null, check: stats => stats.eliminations >= 1 },
  { id: 'comeback', name: '久違回歸', description: '超過 7 天沒玩之後再通關或參賽', frame: null, check: stats => stats.event.sinceLast != null && stats.event.sinceLast >= 7 * DAY },
  { id: 'night_owl', name: '夜貓子', description: '在凌晨 0 點到 5 點之間通關或參賽', frame: 'moon', check: stats => stats.event.hour >= 0 && stats.event.hour < 5 }
];
const byId = new Map(ACHIEVEMENTS.map(achievement => [achievement.id, achievement]));
const publicAchievement = ({ id, name, description, frame }) => ({ id, name, description, frame });

// Pure judgement: which achievements does `stats` newly satisfy?
function evaluate(stats, unlocked = new Set()) {
  return ACHIEVEMENTS.filter(achievement => !unlocked.has(achievement.id) && achievement.check(stats));
}

function createAchievements(db, { now = Date.now } = {}) {
  const q = {
    upsert: db.prepare('INSERT INTO achievements (id, name, description, frame, position) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, frame = excluded.frame, position = excluded.position'),
    unlocked: db.prepare('SELECT achievement_id, unlocked_at FROM achievement_unlocks WHERE user_id = ?'),
    unlock: db.prepare('INSERT OR IGNORE INTO achievement_unlocks (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)'),
    progress: db.prepare('SELECT level_id, cleared_at, hints_used, mistakes FROM progress WHERE user_id = ?'),
    history: db.prepare('SELECT finished_at, record_json FROM match_history WHERE user_id = ? ORDER BY finished_at DESC'),
    lastActivity: db.prepare('SELECT MAX(at) AS at FROM (SELECT MAX(cleared_at) AS at FROM progress WHERE user_id = ? UNION ALL SELECT MAX(finished_at) FROM match_history WHERE user_id = ?)')
  };
  db.transaction(() => ACHIEVEMENTS.forEach((a, i) => q.upsert.run(a.id, a.name, a.description, a.frame, i)))();

  const unlockedMap = userId => new Map(q.unlocked.all(userId).map(row => [row.achievement_id, row.unlocked_at]));

  // `chapters` is ladderChapters() output; a chapter counts only when every
  // rung it expects has been built and cleared.
  function gather(userId, { chapters = [] }, event) {
    const rows = q.progress.all(userId);
    const cleared = new Set(rows.map(row => row.level_id));
    const chaptersCleared = new Set(chapters.filter(c => c.levelIds.length === c.total && c.levelIds.every(id => cleared.has(id))).map(c => c.id));
    let matches = 0, wins = 0, eliminations = 0, streak = 0, streakOpen = true;
    for (const row of q.history.all(userId)) {
      const outcome = JSON.parse(row.record_json).outcome || {};
      matches++;
      if (outcome.rank === 1) { wins++; if (streakOpen) streak++; } else streakOpen = false;
      if (outcome.status === 'eliminated') eliminations++;
    }
    return {
      cleared: cleared.size, chaptersCleared,
      flawless: rows.filter(row => row.mistakes === 0).length,
      noHint: rows.filter(row => (row.hints_used || 0) === 0).length,
      matches, wins, streak, eliminations, event
    };
  }

  // Applies the caller's write (progress or history), then judges the new
  // state so the event itself counts. Returns the achievements just unlocked.
  const record = db.transaction((userId, context, event, apply) => {
    const at = now();
    const last = q.lastActivity.get(userId, userId).at;
    apply?.();
    const stats = gather(userId, context, { ...event, hour: new Date(at).getHours(), sinceLast: last == null ? null : at - last });
    const fresh = evaluate(stats, new Set(unlockedMap(userId).keys()));
    for (const achievement of fresh) q.unlock.run(userId, achievement.id, at);
    return fresh.map(publicAchievement);
  });

  function unlockedFrames(userId) {
    const unlocked = userId ? unlockedMap(userId) : new Map();
    return new Set([DEFAULT_FRAME, ...[...unlocked.keys()].map(id => byId.get(id)?.frame).filter(Boolean)]);
  }

  function listFor(userId) {
    const unlocked = userId ? unlockedMap(userId) : new Map();
    const frames = unlockedFrames(userId);
    return {
      achievements: ACHIEVEMENTS.map(a => ({ ...publicAchievement(a), unlockedAt: unlocked.get(a.id) ?? null })),
      frames: FRAMES.map(frame => ({ ...frame, unlocked: frames.has(frame.id), achievement: ACHIEVEMENTS.find(a => a.frame === frame.id)?.name || null }))
    };
  }

  return { record, gather, listFor, unlockedFrames, frameUnlocked: (userId, frameId) => unlockedFrames(userId).has(frameId) };
}

module.exports = { ACHIEVEMENTS, AVATARS, FRAMES, DEFAULT_AVATAR, DEFAULT_FRAME, CHAPTERS, evaluate, createAchievements };
