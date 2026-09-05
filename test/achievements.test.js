const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../db');
const { generatePuzzle } = require('../puzzle');
const { createAuth, sanitizeDisplayName, DISPLAY_NAME_MAX } = require('../auth');
const { createAchievements, evaluate, ACHIEVEMENTS, AVATARS, FRAMES, DEFAULT_FRAME } = require('../achievements');
const { ladderChapters, LADDER_LENGTH } = require('../ladder');

process.env.MEOWDOKU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meowdoku-achievements-'));
delete process.env.ADMIN_BOOTSTRAP_USER;
const LEVELS = [{ id: 'lvl-a', name: '關卡 A', createdAt: 1, ...generatePuzzle(4) }, { id: 'lvl-b', name: '關卡 B', createdAt: 2, ...generatePuzzle(4) }];
fs.writeFileSync(path.join(process.env.MEOWDOKU_DATA_DIR, 'levels.json'), JSON.stringify(LEVELS));
const { server, io, db: serverDb, rooms } = require('../server');

const PASSWORD = 'tuna-sashimi-42';
const DAY = 24 * 60 * 60 * 1000;
// A fixed clock at 10:00 local time keeps "night owl" out of unrelated tests.
const clock = () => { let t = new Date(2026, 0, 1, 10).getTime(); return { now: () => t, tick: ms => { t += ms; } }; };
const setup = async () => {
  const time = clock(), db = openDb();
  const auth = createAuth(db, { now: time.now }), achievements = createAchievements(db, { now: time.now });
  const { user } = await auth.register({ username: 'judge', password: PASSWORD });
  return { db, auth, achievements, time, userId: user.id };
};
const single = (overrides = {}) => ({ kind: 'single', levelId: 'x', size: 6, ms: 90_000, mistakes: 0, hints: 0, hour: 10, sinceLast: null, ...overrides });
const baseStats = (overrides = {}) => ({ cleared: 0, chaptersCleared: new Set(), flawless: 0, noHint: 0, matches: 0, wins: 0, streak: 0, eliminations: 0, event: single(), ...overrides });
const ids = list => list.map(a => a.id);

test('catalogue: at least 20 achievements, unique ids, every reward frame exists exactly once', () => {
  assert.ok(ACHIEVEMENTS.length >= 20);
  assert.equal(new Set(ids(ACHIEVEMENTS)).size, ACHIEVEMENTS.length);
  assert.ok(AVATARS.length >= 12);
  const frameIds = new Set(FRAMES.map(f => f.id));
  const rewarded = ACHIEVEMENTS.map(a => a.frame).filter(Boolean);
  assert.equal(new Set(rewarded).size, rewarded.length);
  for (const frame of rewarded) assert.ok(frameIds.has(frame), frame);
  assert.ok(frameIds.has(DEFAULT_FRAME));
  assert.ok(!rewarded.includes(DEFAULT_FRAME));
});

test('evaluate: count milestones fire exactly at the threshold, not one short', () => {
  for (const [id, key, threshold] of [['clear_5', 'cleared', 5], ['clear_10', 'cleared', 10], ['clear_25', 'cleared', 25], ['clear_48', 'cleared', 48],
    ['flawless_10', 'flawless', 10], ['nohint_20', 'noHint', 20], ['matches_10', 'matches', 10], ['matches_50', 'matches', 50], ['wins_10', 'wins', 10], ['streak_3', 'streak', 3], ['streak_5', 'streak', 5]]) {
    assert.ok(!ids(evaluate(baseStats({ [key]: threshold - 1 }))).includes(id), `${id} one short`);
    assert.ok(ids(evaluate(baseStats({ [key]: threshold }))).includes(id), `${id} exactly`);
  }
  assert.ok(!ids(evaluate(baseStats({ cleared: 5 }), new Set(['clear_5']))).includes('clear_5'));
});

test('evaluate: speed, size, comeback and night owl boundaries', () => {
  const on = (event, id) => ids(evaluate(baseStats({ event: single(event) }))).includes(id);
  assert.ok(on({ size: 7, ms: 60_000 }, 'speed_7_60'));
  assert.ok(!on({ size: 7, ms: 60_001 }, 'speed_7_60'));
  assert.ok(!on({ size: 8, ms: 10_000 }, 'speed_7_60'));
  assert.ok(on({ size: 12, ms: 300_000 }, 'speed_12_300'));
  assert.ok(on({ size: 11 }, 'big_11')); assert.ok(!on({ size: 10 }, 'big_11')); assert.ok(!on({ size: 11 }, 'big_12')); assert.ok(on({ size: 12 }, 'big_12'));
  assert.ok(on({ sinceLast: 7 * DAY }, 'comeback')); assert.ok(!on({ sinceLast: 7 * DAY - 1 }, 'comeback')); assert.ok(!on({ sinceLast: null }, 'comeback'));
  assert.ok(on({ hour: 4 }, 'night_owl')); assert.ok(!on({ hour: 5 }, 'night_owl'));
  assert.ok(!ids(evaluate(baseStats({ event: { kind: 'match', size: 12, rank: 1, status: 'solved', hour: 10, sinceLast: null } }))).includes('big_12'));
});

test('store: single clears are judged after the write, chapter clears need every rung', async () => {
  const { auth, achievements, userId, time } = await setup();
  const ladder = Array.from({ length: LADDER_LENGTH }, (_, ladderIndex) => ({ id: `r${ladderIndex}`, ladderIndex }));
  const chapters = ladderChapters(ladder);
  const kitten = chapters.find(c => c.id === 'kitten');
  assert.ok(kitten.total >= 2 && kitten.levelIds.length === kitten.total);
  let unlocked = [];
  for (const [index, levelId] of kitten.levelIds.entries()) {
    unlocked = achievements.record(userId, { chapters }, single({ levelId }), () => auth.clearLevel(userId, levelId, { ms: 90_000, mistakes: 0 }));
    if (index === 0) assert.deepEqual(ids(unlocked), ['clear_1']);
    if (index < kitten.levelIds.length - 1) assert.ok(!ids(unlocked).includes('chapter_kitten'));
  }
  assert.ok(ids(unlocked).includes('chapter_kitten'));
  // A chapter whose rungs are not all built yet cannot be cleared.
  const partial = ladderChapters(ladder.slice(0, kitten.total - 1));
  assert.equal(achievements.gather(userId, { chapters: partial }, single()).chaptersCleared.has('kitten'), false);
  // Replaying an already cleared level unlocks nothing twice.
  assert.deepEqual(achievements.record(userId, { chapters }, single({ levelId: kitten.levelIds[0] }), () => auth.clearLevel(userId, kitten.levelIds[0])), []);
  // Comeback: exactly 7 days of silence counts, a millisecond less does not.
  time.tick(7 * DAY - 1);
  assert.ok(!ids(achievements.record(userId, { chapters }, single({ levelId: 'late-1' }), () => auth.clearLevel(userId, 'late-1'))).includes('comeback'));
  time.tick(7 * DAY);
  assert.ok(ids(achievements.record(userId, { chapters }, single({ levelId: 'late-2' }), () => auth.clearLevel(userId, 'late-2'))).includes('comeback'));
  const list = achievements.listFor(userId);
  assert.ok(list.achievements.find(a => a.id === 'clear_1').unlockedAt);
  assert.equal(list.achievements.find(a => a.id === 'clear_48').unlockedAt, null);
  assert.ok(list.frames.find(f => f.id === 'wood').unlocked);
  assert.ok(!list.frames.find(f => f.id === 'gold').unlocked);
});

test('store: match streaks count consecutive wins from the latest match backwards', async () => {
  const { auth, achievements, userId, time } = await setup();
  const play = (rank, status = 'solved') => {
    time.tick(1000);
    const record = { matchId: `m${time.now()}`, finishedAt: time.now(), outcome: { rank, status } };
    return ids(achievements.record(userId, { chapters: [] }, { kind: 'match', size: 7, rank, status }, () => auth.recordMatch(userId, record)));
  };
  assert.deepEqual(play(1), ['matches_1', 'wins_1']);
  assert.ok(!play(1).includes('streak_3'));
  assert.ok(play(1).includes('streak_3'));
  assert.deepEqual(play(null, 'eliminated'), ['eliminated_1']);
  for (let i = 0; i < 4; i++) assert.ok(!play(1).includes('streak_5'));
  assert.ok(play(1).includes('streak_5'));
  const stats = achievements.gather(userId, { chapters: [] }, { kind: 'match' });
  assert.equal(stats.matches, 9); assert.equal(stats.wins, 8); assert.equal(stats.streak, 5); assert.equal(stats.eliminations, 1);
});

test('frames: only plain plus the rewards of unlocked achievements are selectable', async () => {
  const { auth, achievements, userId } = await setup();
  assert.equal(achievements.frameUnlocked(userId, DEFAULT_FRAME), true);
  assert.equal(achievements.frameUnlocked(userId, 'wood'), false);
  assert.equal(achievements.frameUnlocked(userId, 'not-a-frame'), false);
  achievements.record(userId, { chapters: [] }, single({ levelId: 'l1' }), () => auth.clearLevel(userId, 'l1'));
  assert.equal(achievements.frameUnlocked(userId, 'wood'), true);
  assert.equal(achievements.frameUnlocked(userId, 'gold'), false);
});

test('display names: control and zero-width characters go, whitespace is trimmed, 20 code points max', () => {
  assert.equal(sanitizeDisplayName('  Mochi\u0000 \u200b\t貓  '), 'Mochi 貓');
  assert.equal(sanitizeDisplayName('Mo\tchi\r\n'), 'Mochi');
  assert.equal(sanitizeDisplayName('\u0007\u200e'), '');
  assert.equal(sanitizeDisplayName(null), '');
  assert.equal(sanitizeDisplayName('a'.repeat(25)).length, DISPLAY_NAME_MAX);
  assert.equal([...sanitizeDisplayName('😺'.repeat(25))].length, DISPLAY_NAME_MAX);
  assert.equal(sanitizeDisplayName('x'.repeat(19) + ' y'), 'x'.repeat(19));
});

// --- HTTP against the real server ---
let baseUrl;
test.before(async () => { await new Promise(resolve => server.listen(0, resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => {
  io.close(); await new Promise(resolve => server.close(resolve));
  for (const room of rooms.values()) { for (const timer of [room.timer, room.countdownTimer, room.broadcastTimer, room.spectatorTimer]) clearTimeout(timer); }
  serverDb.close();
});
const cookieOf = response => (response.headers.get('set-cookie') || '').split(';')[0];
async function call(method, route, { body, cookie } = {}) {
  const response = await fetch(baseUrl + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), cookie: cookieOf(response) };
}
async function signUp(username) {
  const guest = await call('GET', '/api/auth/me');
  const created = await call('POST', '/api/auth/register', { body: { username, password: PASSWORD }, cookie: guest.cookie });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return { cookie: created.cookie, user: created.data.user };
}

test('HTTP: guests get a clear 401 from the profile, but can read the achievement catalogue', async () => {
  const guest = await call('GET', '/api/auth/me');
  const profile = await call('GET', '/api/profile/me', { cookie: guest.cookie });
  assert.equal(profile.status, 401); assert.match(profile.data.error, /登入/);
  assert.equal((await call('GET', '/api/profile/me')).status, 401);
  assert.equal((await call('POST', '/api/profile', { body: { displayName: 'x' }, cookie: guest.cookie })).status, 401);
  const catalogue = await call('GET', '/api/achievements/me', { cookie: guest.cookie });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.data.achievements.length, ACHIEVEMENTS.length);
  assert.ok(catalogue.data.achievements.every(a => a.unlockedAt === null && !('check' in a) && !('solution' in a)));
  assert.deepEqual(catalogue.data.frames.filter(f => f.unlocked).map(f => f.id), [DEFAULT_FRAME]);
});

test('HTTP: locked frames are rejected server-side; a clear unlocks one and it becomes selectable', async () => {
  const { cookie, user } = await signUp('framer');
  assert.equal((await call('POST', '/api/profile', { body: { frame: 'wood' }, cookie })).status, 403);
  assert.equal((await call('POST', '/api/profile', { body: { frame: 'nope' }, cookie })).status, 403);
  assert.equal((await call('POST', '/api/profile', { body: { frame: 7 }, cookie })).status, 403);
  assert.equal((await call('GET', '/api/auth/me', { cookie })).data.user.frame, null);
  const first = (await call('GET', '/api/levels')).data[0];
  const done = await call('POST', '/api/single-complete', { body: { name: 'framer', levelId: first.id, ms: 12_345, mistakes: 0 }, cookie });
  assert.equal(done.status, 200);
  assert.deepEqual(done.data.unlocked.map(a => a.id), ['clear_1']);
  assert.equal((await call('POST', '/api/profile', { body: { frame: 'wood' }, cookie })).status, 200);
  assert.equal((await call('POST', '/api/profile', { body: { frame: 'gold' }, cookie })).status, 403);
  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal(me.data.user.frame, 'wood');
  const row = serverDb.prepare('SELECT ms, mistakes FROM progress WHERE user_id = ? AND level_id = ?').get(user.id, first.id);
  assert.deepEqual(row, { ms: 12345, mistakes: 0 });
  const profile = await call('GET', '/api/profile/me', { cookie });
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.data.cleared, [first.id]);
  assert.ok(profile.data.frames.find(f => f.id === 'wood').unlocked);
  assert.equal(profile.data.avatars.length, AVATARS.length);
  assert.ok(Array.isArray(profile.data.chapters));
  // Leaderboard rows carry the avatar and frame for rendering.
  const board = await call('GET', '/api/leaderboard');
  assert.deepEqual(board.data.find(r => r.name === 'framer'), { name: 'framer', cleared: 1, avatar: null, frame: 'wood' });
});

test('HTTP: display names are sanitized and avatars must be built in', async () => {
  const { cookie } = await signUp('namer');
  const saved = await call('POST', '/api/profile', { body: { displayName: '  貓\u0000咪\u200b' + 'x'.repeat(30) }, cookie });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.user.displayName, '貓咪' + 'x'.repeat(18));
  assert.equal((await call('POST', '/api/profile', { body: { displayName: '\u0001 \u200b' }, cookie })).status, 400);
  assert.equal((await call('POST', '/api/profile', { body: { avatar: '💩' }, cookie })).status, 400);
  const avatar = await call('POST', '/api/profile', { body: { avatar: AVATARS[3] }, cookie });
  assert.equal(avatar.status, 200); assert.equal(avatar.data.user.avatar, AVATARS[3]);
  assert.equal((await call('GET', '/api/auth/me', { cookie })).data.user.displayName, '貓咪' + 'x'.repeat(18));
});
