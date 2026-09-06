const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const cookie = require('cookie');
const { openDb } = require('./db');
const { createAuth, sanitizeDisplayName, DISPLAY_NAME_MAX } = require('./auth');
const { createAchievements, AVATARS, DEFAULT_AVATAR, DEFAULT_FRAME } = require('./achievements');
const { generatePuzzle, countSolutions, clampSize, validateBoardText } = require('./puzzle');
const { generateAsync } = require('./generator');
const { clampSprintSeconds, clampSprintFactor, normalizeSprintMode, resolveSprintSeconds } = require('./sprint');
const { rate } = require('./difficulty');
const { buildLadder, validLadder, ladderChapters, chapterOf, LADDER_VERSION, LADDER_LENGTH } = require('./ladder');
const { findHint, boardKey } = require('./hints');
const { createHintQuota, jsonFileStore } = require('./hint-quota');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const IDLE_GRACE = 20_000;
const CHAT_MAX_LEN = 200, CHAT_HISTORY = 50, CHAT_WINDOW = 5_000, CHAT_WINDOW_MAX = 5, CHAT_MIN_GAP = 400;
const ALL_SPECTATOR_CLOSE = 10 * 60_000;
const DATA_DIR = process.env.MEOWDOKU_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'meowdoku.db');
const SESSION_COOKIE = 'meowdoku_sid';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const LEVELS_PATH = path.join(DATA_DIR, 'levels.json');
const SCORES_PATH = path.join(DATA_DIR, 'scores.json');
const PUZZLE_POOL_PATH = path.join(DATA_DIR, 'multiplayer-puzzle-pool.json');
const HISTORY_PATH = path.join(DATA_DIR, 'match-history.json');
// Records are keyed by the client's visitorId, so it is validated as an opaque
// id and never used to build a path.
const VISITOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HISTORY_PER_VISITOR = 50, HISTORY_VISITORS = 200;
const PASSWORD_MAX_LEN = 32, PASSWORD_FAIL_BASE = 500, PASSWORD_FAIL_CAP = 30_000;
const scrypt = promisify(crypto.scrypt);
const LADDER_PATH = path.join(DATA_DIR, 'ladder.json');
const HINT_QUOTA_PATH = path.join(DATA_DIR, 'hint-quota.json');
const LEVEL_ORDER_PATH = path.join(DATA_DIR, 'level-order.json');
const LEADERBOARD_TOP = 5;
const rooms = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_PATH);
const auth = createAuth(db);
const achievements = createAchievements(db);
auth.purgeExpired();
if (process.env.ADMIN_BOOTSTRAP_USER) {
  if (auth.bootstrapAdmin(process.env.ADMIN_BOOTSTRAP_USER)) console.log(`已將 ${process.env.ADMIN_BOOTSTRAP_USER} 設為管理員`);
  else console.log(`ADMIN_BOOTSTRAP_USER=${process.env.ADMIN_BOOTSTRAP_USER} 尚未註冊，請先在網頁註冊該帳號再重啟`);
}
// ngrok and similar tunnels run on this machine, so only loopback proxies get
// to tell us the client address and protocol.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const isSecure = req => req.secure || req.header('x-forwarded-proto') === 'https';
function setSessionCookie(req, res, token, persistent) {
  res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure: isSecure(req), ...(persistent ? { maxAge: SESSION_MAX_AGE } : {}) }));
}
function clearSessionCookie(req, res) {
  res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', secure: isSecure(req), maxAge: 0 }));
}
const cookieToken = header => cookie.parse(header || '')[SESSION_COOKIE];
// A cookie is resolved on every API call, but a guest is only minted where an
// identity is actually needed: anonymous hits on read-only routes must not be
// able to grow the guests/sessions tables.
app.use('/api', (req, res, next) => {
  req.sessionToken = cookieToken(req.header('cookie'));
  const resolved = auth.resolve(req.sessionToken, req.header('user-agent'));
  req.identity = resolved?.identity || null;
  if (resolved?.renewedToken) { req.sessionToken = resolved.renewedToken; setSessionCookie(req, res, resolved.renewedToken, true); }
  next();
});
function ensureIdentity(req, res, next) {
  if (!req.identity) {
    const guest = auth.createGuest(req.header('user-agent'));
    req.identity = guest.identity; req.sessionToken = guest.token;
    setSessionCookie(req, res, guest.token, false);
  }
  next();
}
const isUser = req => req.identity?.kind === 'user';
function requireUser(req, res, next) {
  if (!isUser(req)) return res.status(401).json({ error: '登入才能使用個人主頁' });
  next();
}
function requireAdmin(req, res, next) {
  if (!isUser(req)) return res.status(401).json({ error: '請先登入管理員帳號' });
  if (!req.identity.isAdmin) return res.status(403).json({ error: '只有管理員可以管理關卡' });
  next();
}
setInterval(() => auth.purgeExpired(), 60 * 60_000).unref();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// Temp file + rename: a crash mid-write leaves the previous file intact.
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function loadLevels() {
  const levels = readJson(LEVELS_PATH, []);
  // Existing boards from before the no-touching rule are transparently
  // regenerated, while their names and identifiers stay stable. The ladder
  // supplies the starter levels now, so an empty file is a normal state.
  const upgraded = levels.map(level => {
    if (level.name === '新手的第一盒罐罐' && level.size < 7) return { ...level, ...generatePuzzle(7), createdAt: Date.now(), rating: null };
    if (countSolutions(level.regions, level.size) === 1) return level;
    return { ...level, ...generatePuzzle(level.size), createdAt: Date.now(), rating: null };
  }).map(level => level.rating ? level : { ...level, rating: rate(level) });
  if (upgraded.some((level, index) => level !== levels[index])) writeJson(LEVELS_PATH, upgraded);
  return upgraded;
}
let levels = loadLevels();
const ladder = validLadder(readJson(LADDER_PATH, null));
let ladderBuilding = false;
// The ladder is generate-and-filter over thousands of candidates, so it is
// built once, in the background, and persisted after every accepted rung.
function startLadder() {
  if (ladderBuilding || ladder.length >= LADDER_LENGTH) return;
  ladderBuilding = true;
  buildLadder({
    levels: ladder, generate: generateAsync, makeId: () => nanoid(8),
    // The builder still consumes CPU, so it stands aside while a room is live.
    paused: () => [...rooms.values()].some(room => room.status === 'countdown' || room.status === 'playing'),
    onAccepted: () => writeJson(LADDER_PATH, { version: LADDER_VERSION, levels: ladder }),
    onDone: () => { ladderBuilding = false; console.log(`單人階梯完成 ${ladder.length} 關`); }
  });
}
// Ordered by rating, so an easy 9 × 9 may sit before a nasty 7 × 7, and admin
// levels take their place in the same order instead of trailing the ladder.
// An admin-saved order wins over the rating; levels the saved order does not
// know yet (new rungs, fresh imports) still slot in by rating.
let levelOrder = readJson(LEVEL_ORDER_PATH, []).filter(id => typeof id === 'string');
function singleLevels() {
  const byRating = [...ladder, ...levels].sort((a, b) => (a.rating?.score || 0) - (b.rating?.score || 0) || a.createdAt - b.createdAt);
  if (!levelOrder.length) return byRating;
  const byId = new Map(byRating.map(level => [level.id, level]));
  const ordered = levelOrder.filter(id => byId.has(id)).map(id => byId.get(id));
  const listed = new Set(ordered.map(level => level.id));
  for (const level of byRating) {
    if (listed.has(level.id)) continue;
    const score = level.rating?.score || 0;
    const at = ordered.findIndex(other => (other.rating?.score || 0) > score);
    ordered.splice(at < 0 ? ordered.length : at, 0, level);
  }
  return ordered;
}
function saveLevelOrder(ids) {
  levelOrder = ids; writeJson(LEVEL_ORDER_PATH, ids);
}
let multiplayerPuzzlePool = readJson(PUZZLE_POOL_PATH, []);
const refillingPoolSizes = new Set();
const MULTIPLAYER_POOL_PER_SIZE = 4;
function publicLevel(level) {
  const rating = level.rating ? { ...level.rating } : null;
  if (rating) delete rating.solution;
  return { id: level.id, name: level.name, ladder: level.ladder || null, size: level.size, regions: level.regions, createdAt: level.createdAt, rating, chapter: Number.isInteger(level.ladderIndex) ? chapterOf(level.ladderIndex).id : null };
}
const achievementContext = () => ({ chapters: ladderChapters(ladder) });
const clampCount = (value, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(0, Math.round(Number(value)))) : 0;
// One puzzle per tick: the pool is refilled without holding up the socket
// traffic of a match that is already running.
function refillMultiplayerPool(size) {
  if (refillingPoolSizes.has(size)) return;
  refillingPoolSizes.add(size);
  const addOne = async () => {
    if (multiplayerPuzzlePool.filter(puzzle => puzzle.size === size).length >= MULTIPLAYER_POOL_PER_SIZE) {
      refillingPoolSizes.delete(size);
      return;
    }
    try {
      multiplayerPuzzlePool.push(await generateAsync(size));
      writeJson(PUZZLE_POOL_PATH, multiplayerPuzzlePool);
    } catch (error) {
      console.error('補充多人題庫失敗', error);
      refillingPoolSizes.delete(size);
      return;
    }
    setImmediate(addOne);
  };
  setImmediate(addOne);
}
async function takeMultiplayerPuzzle(size) {
  const normalizedSize = clampSize(size);
  const index = multiplayerPuzzlePool.findIndex(puzzle => puzzle.size === normalizedSize);
  const puzzle = index < 0 ? await generateAsync(normalizedSize) : multiplayerPuzzlePool.splice(index, 1)[0];
  if (index >= 0) writeJson(PUZZLE_POOL_PATH, multiplayerPuzzlePool);
  refillMultiplayerPool(normalizedSize);
  return puzzle;
}
// Only the derived hash lives on the room, and no payload builder copies it.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return { salt, hash: await scrypt(password, salt, 32) };
}
async function passwordMatches(stored, password) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX_LEN) return false;
  const hash = await scrypt(password, stored.salt, 32);
  return crypto.timingSafeEqual(hash, stored.hash);
}
// Guesses at a room password back off per socket, doubling up to the cap.
async function checkRoomPassword(socket, room, password) {
  if (!room.password) return null;
  if (password === undefined) return '這間房需要密碼';
  const gate = socket.data.passwordGate || (socket.data.passwordGate = { fails: 0, lockedUntil: 0 });
  if (Date.now() < gate.lockedUntil) return '密碼錯誤太多次，請稍後再試';
  if (await passwordMatches(room.password, String(password ?? '').trim())) { gate.fails = 0; return null; }
  gate.fails++; gate.lockedUntil = Date.now() + Math.min(PASSWORD_FAIL_BASE * 2 ** (gate.fails - 1), PASSWORD_FAIL_CAP);
  return '房間密碼不正確';
}
const hintQuota = createHintQuota({ store: jsonFileStore(HINT_QUOTA_PATH, readJson, writeJson) });
// The last hint handed to each visitor, so re-asking about the same position
// (a double click, a page refresh) repeats the answer instead of charging again.
const lastHints = new Map();
function hintPuzzle(identity, { levelId, matchId }) {
  if (typeof levelId === 'string') return singleLevels().find(level => level.id === levelId) || null;
  if (typeof matchId === 'string') {
    const record = historyFor(identity).find(item => item.matchId === matchId);
    return record ? { id: record.matchId, size: record.size, regions: record.regions, solution: record.solution } : null;
  }
  return null;
}
function scoreRows() {
  const guests = Object.entries(readJson(SCORES_PATH, {})).map(([id, { name, cleared }]) => ({ key: `g:${id}`, name, cleared: cleared.length }));
  return [...auth.userLeaderboard().map(row => ({ key: `u:${row.id}`, name: row.name, cleared: row.cleared, avatar: row.avatar || DEFAULT_AVATAR, frame: row.frame || DEFAULT_FRAME })), ...guests].sort((a, b) => b.cleared - a.cleared || a.name.localeCompare(b.name, 'zh-Hant'));
}
// Competition ranking: equal scores share a rank and the next rank skips.
// Only accounts get a rank of their own; guests are told to sign in instead.
function leaderboardFor(identity) {
  const rows = scoreRows();
  const rankOf = cleared => rows.filter(row => row.cleared > cleared).length + 1;
  const myKey = identity?.kind === 'user' ? `u:${identity.id}` : null;
  const top = rows.slice(0, LEADERBOARD_TOP).map(row => ({ rank: rankOf(row.cleared), name: row.name, cleared: row.cleared, avatar: row.avatar, frame: row.frame, me: row.key === myKey }));
  let me = null;
  if (myKey) {
    const mine = rows.find(row => row.key === myKey);
    const cleared = mine ? mine.cleared : 0;
    me = { rank: rankOf(cleared), cleared, total: rows.length + (mine ? 0 : 1), inTop: top.some(row => row.me) };
  }
  return { top, total: rows.length, me };
}
function clearedFor(identity) {
  if (identity.kind === 'user') return auth.clearedLevels(identity.id);
  return readJson(SCORES_PATH, {})[identity.id]?.cleared || [];
}
function historyFor(identity) {
  if (identity.kind === 'user') return auth.matchHistory(identity.id, HISTORY_PER_VISITOR);
  return readJson(HISTORY_PATH, {})[identity.id] || [];
}
function publicIdentity(identity) {
  return identity.kind === 'user'
    ? { user: { id: identity.id, username: identity.username, displayName: identity.displayName, isAdmin: identity.isAdmin, avatar: identity.avatar, frame: identity.frame }, guest: null }
    : { user: null, guest: { id: identity.id, ephemeral: true, notice: '訪客資料在關閉網頁後不會保留，登入才能永久保存。' } };
}
// A guest who signs in keeps what they just played: the guest identity came
// from our own cookie, so it can be merged without asking.
function absorbGuest(identity, userId) {
  if (identity?.kind !== 'guest') return;
  const scores = readJson(SCORES_PATH, {}), history = readJson(HISTORY_PATH, {});
  auth.claimVisitor(userId, identity.id, { cleared: scores[identity.id]?.cleared || [], history: history[identity.id] || [] });
  if (identity.id in scores) { delete scores[identity.id]; writeJson(SCORES_PATH, scores); }
  if (identity.id in history) { delete history[identity.id]; writeJson(HISTORY_PATH, history); }
  auth.deleteGuestSessions(identity.id);
}

app.get('/api/auth/me', ensureIdentity, (req, res) => res.json(publicIdentity(req.identity)));
app.post('/api/auth/register', async (req, res) => {
  if (isUser(req)) return res.status(400).json({ error: '你已經登入了' });
  const { username, password } = req.body || {};
  const result = await auth.register({ username, password, userAgent: req.header('user-agent') });
  if (result.error) return res.status(400).json({ error: result.error });
  absorbGuest(req.identity, result.user.id);
  setSessionCookie(req, res, result.token, true);
  res.status(201).json({ user: result.user });
});
app.post('/api/auth/login', async (req, res) => {
  if (isUser(req)) return res.status(400).json({ error: '你已經登入了' });
  const { username, password } = req.body || {};
  const result = await auth.login({ username, password, ip: req.ip, userAgent: req.header('user-agent') });
  if (result.retryAfter) { res.set('Retry-After', String(result.retryAfter)); return res.status(429).json({ error: result.error, retryAfter: result.retryAfter }); }
  if (result.error) return res.status(401).json({ error: result.error });
  absorbGuest(req.identity, result.user.id);
  setSessionCookie(req, res, result.token, true);
  res.json({ user: result.user });
});
app.post('/api/auth/logout', (req, res) => {
  auth.logout(req.sessionToken);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/levels', (_req, res) => res.json(singleLevels().map(publicLevel)));
app.get('/api/levels/:id', (req, res) => {
  const level = singleLevels().find(item => item.id === req.params.id);
  if (!level) return res.status(404).json({ error: '找不到關卡' });
  res.json(level); // Single-player boards need the local answer for instant feedback.
});
app.get('/api/leaderboard', (req, res) => res.json(leaderboardFor(req.identity)));
app.get('/api/public-rooms', (_req, res) => {
  const visibleRooms = [...rooms.values()]
    .filter(room => room.visibility === 'public' && room.status !== 'finished')
    .map(room => ({
      code: room.code, name: room.name, size: room.puzzle.size, status: room.status, hasPassword: Boolean(room.password),
      players: [...room.players.values()].filter(player => !player.spectator).length,
      spectators: [...room.players.values()].filter(player => player.spectator).length
    }));
  res.json(visibleRooms);
});
app.get('/api/progress/me', ensureIdentity, (req, res) => res.json({ cleared: clearedFor(req.identity) }));
// Guests see the catalogue with nothing unlocked; nothing here needs a session.
app.get('/api/achievements/me', (req, res) => res.json(achievements.listFor(isUser(req) ? req.identity.id : null)));
app.get('/api/profile/me', requireUser, (req, res) => {
  res.json({
    ...publicIdentity(req.identity), avatars: AVATARS, chapters: ladderChapters(ladder), cleared: auth.clearedLevels(req.identity.id),
    ...achievements.listFor(req.identity.id), stats: achievements.matchStats(req.identity.id)
  });
});
// Raw input is bounded before sanitizing so a 1 MB name is refused, not scanned.
const PROFILE_FIELD_MAX = 200;
const applyProfile = db.transaction((userId, writes) => { for (const write of writes) write(); });
app.post('/api/profile', requireUser, (req, res) => {
  const { displayName, avatar, frame } = req.body || {};
  const writes = [];
  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.length > PROFILE_FIELD_MAX) return res.status(400).json({ error: `顯示名稱太長（最多 ${DISPLAY_NAME_MAX} 字）` });
    const clean = sanitizeDisplayName(displayName);
    if (!clean) return res.status(400).json({ error: `顯示名稱不能是空的（最多 ${DISPLAY_NAME_MAX} 字）` });
    writes.push(() => auth.setDisplayName(req.identity.id, clean));
  }
  if (avatar !== undefined) {
    if (typeof avatar !== 'string' || !AVATARS.includes(avatar)) return res.status(400).json({ error: '這不是內建的頭像' });
    writes.push(() => auth.setAvatar(req.identity.id, avatar));
  }
  if (frame !== undefined) {
    if (typeof frame !== 'string' || frame.length > PROFILE_FIELD_MAX || !achievements.frameUnlocked(req.identity.id, frame)) return res.status(403).json({ error: '這個相框尚未解鎖' });
    writes.push(() => auth.setFrame(req.identity.id, frame));
  }
  applyProfile(req.identity.id, writes);
  res.json({ user: auth.userById(req.identity.id) });
});
app.get('/api/history/me', ensureIdentity, (req, res) => res.json(historyFor(req.identity)));
// Legacy read-only paths keyed by the browser-generated visitorId, kept so the
// JSON records from before accounts can still be looked at.
app.get('/api/progress/:visitorId', (req, res) => {
  const scores = readJson(SCORES_PATH, {});
  const entry = scores[req.params.visitorId];
  res.json({ cleared: entry?.cleared || [] });
});
app.get('/api/history/:visitorId', (req, res) => {
  const visitorId = String(req.params.visitorId || '');
  if (!VISITOR_ID.test(visitorId)) return res.status(400).json({ error: '無效的玩家識別碼' });
  res.json(readJson(HISTORY_PATH, {})[visitorId] || []);
});
app.get('/api/hints/quota', ensureIdentity, (req, res) => res.json(hintQuota.get(req.identity.id)));
app.post('/api/hints', ensureIdentity, (req, res) => {
  const { levelId, matchId, cats, marks } = req.body || {};
  const visitorId = req.identity.id;
  const puzzle = hintPuzzle(req.identity, { levelId, matchId });
  if (!puzzle) return res.status(404).json({ error: '找不到關卡' });
  const player = { cats: Array.isArray(cats) ? cats : [], marks: Array.isArray(marks) ? marks : [] };
  const key = boardKey(puzzle.id, player);
  const previous = lastHints.get(visitorId);
  if (previous?.key === key) return res.json({ hint: previous.hint, quota: hintQuota.get(visitorId), charged: false });
  const quota = hintQuota.get(visitorId);
  if (!quota.remaining) return res.status(403).json({ error: '今天的提示用完了，明天再來領 3 次', quota });
  const hint = findHint(puzzle, player);
  const charge = hintQuota.consume(visitorId, puzzle.id);
  if (!charge.ok) return res.status(403).json({ error: charge.error, quota: charge });
  lastHints.set(visitorId, { key, hint });
  if (lastHints.size > 1000) lastHints.delete(lastHints.keys().next().value);
  res.json({ hint, quota: charge, charged: true });
});
app.post('/api/single-complete', ensureIdentity, (req, res) => {
  const { name, levelId, ms, mistakes } = req.body || {};
  const list = singleLevels();
  const levelIndex = list.findIndex(level => level.id === levelId);
  if (!name || levelIndex < 0) return res.status(400).json({ error: '資料不完整' });
  const cleared = clearedFor(req.identity);
  // Replaying something already cleared stays allowed even when a newly rated
  // level has since sorted in between it and the rung below.
  if (levelIndex > 0 && !cleared.includes(levelId) && !cleared.includes(list[levelIndex - 1].id)) return res.status(403).json({ error: '請先完成前一關' });
  if (isUser(req)) {
    // The board is solved client-side, so timing and mistakes can only come
    // from the client; they are bounded here and only feed achievements.
    const stats = { ms: Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.round(Number(ms)) : null, hints: 0, mistakes: clampCount(mistakes, 999) };
    const unlocked = achievements.record(req.identity.id, achievementContext(), { kind: 'single', levelId, size: list[levelIndex].size, ms: stats.ms ?? Infinity, mistakes: stats.mistakes, hints: stats.hints },
      () => auth.clearLevel(req.identity.id, levelId, stats));
    return res.json({ ok: true, cleared: auth.clearedLevels(req.identity.id).length, unlocked });
  }
  const scores = readJson(SCORES_PATH, {});
  const entry = scores[req.identity.id] || { name: '', cleared: [] };
  entry.name = String(name).slice(0, 20);
  if (!entry.cleared.includes(levelId)) entry.cleared.push(levelId);
  scores[req.identity.id] = entry;
  writeJson(SCORES_PATH, scores);
  res.json({ ok: true, cleared: entry.cleared.length });
});
app.post('/api/admin/levels', requireAdmin, async (req, res) => {
  try {
    const puzzle = await generateAsync(req.body?.size);
    const level = { id: nanoid(8), name: String(req.body?.name || `${puzzle.size} × ${puzzle.size} 新關卡`).slice(0, 40), createdAt: Date.now(), ...puzzle, rating: rate(puzzle) };
    levels = [...levels, level]; writeJson(LEVELS_PATH, levels);
    res.status(201).json(adminLevel(level));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
// Admins see the answer in the preview; the public catalogue never does.
const adminLevel = level => ({ ...publicLevel(level), solution: level.solution });
function checkBoardText(text, expectedSize) {
  if (typeof text !== 'string') return { errors: ['地圖文字必須是文字格式。'], puzzle: null };
  if (text.length > 8192) return { errors: ['地圖文字不得超過 8 KB。'], puzzle: null };
  const { errors, puzzle } = validateBoardText(text);
  const size = Number(expectedSize), found = text.split(/\r?\n/).filter(line => line.trim()).length - 1;
  if (size && found !== size) return { errors: [`尺寸不符：選擇的是 ${size} × ${size}，地圖卻是 ${found} × ${found}。`, ...errors], puzzle: null };
  return { errors, puzzle };
}
// Dry run: the same checks as import, every problem listed, nothing saved.
app.post('/api/admin/levels/validate', requireAdmin, (req, res) => {
  const { errors, puzzle } = checkBoardText(req.body?.text, req.body?.size);
  if (errors.length) return res.status(400).json({ ok: false, errors, error: errors[0] });
  const rating = rate(puzzle); delete rating.solution;
  res.json({ ok: true, errors: [], size: puzzle.size, regions: puzzle.regions, solution: puzzle.solution, rating });
});
app.post('/api/admin/levels/import', requireAdmin, (req, res) => {
  const { errors, puzzle } = checkBoardText(req.body?.text, req.body?.size);
  if (errors.length) return res.status(400).json({ errors, error: errors[0] });
  const level = { id: nanoid(8), name: String(req.body?.name || `${puzzle.size} × ${puzzle.size} 匯入關卡`).slice(0, 40), createdAt: Date.now(), ...puzzle, rating: rate(puzzle) };
  levels = [...levels, level]; writeJson(LEVELS_PATH, levels);
  res.status(201).json(adminLevel(level));
});
// The whole sequence is saved, so a level moved by hand stays put even when
// its neighbours are re-rated; unknown or missing ids are rejected outright.
app.put('/api/admin/levels/order', requireAdmin, (req, res) => {
  const ids = req.body?.ids;
  const current = singleLevels().map(level => level.id);
  if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every(id => typeof id === 'string' && current.includes(id))) {
    return res.status(400).json({ error: '關卡順序必須包含每一個現有關卡，且不能重複。' });
  }
  saveLevelOrder(ids);
  res.json(singleLevels().map(publicLevel));
});

function leaderboardRows(room) {
  const players = new Map();
  for (const record of room.leaderboard) {
    const current = players.get(record.playerId);
    if (!current) players.set(record.playerId, { playerId: record.playerId, name: record.name, avatar: record.avatar, frame: record.frame, ms: record.ms, round: record.round, wins: record.won ? 1 : 0 });
    else {
      current.wins += record.won ? 1 : 0;
      if (record.ms < current.ms) { current.ms = record.ms; current.round = record.round; current.name = record.name; }
    }
  }
  return [...players.values()].sort((a, b) => a.ms - b.ms || a.playerId.localeCompare(b.playerId)).slice(0, 10);
}
// Points: unfinished 0, finished N − rank + 1 with N the racers of that round.
// Spectators are neither counted in N nor scored, so a round's total is fixed
// by its roster and a mid-race joiner cannot dilute anyone.
function awardPoints(room) {
  const participants = racers(room);
  const finishers = participants.filter(p => p.completedAt).sort((a, b) => a.completedAt - b.completedAt);
  for (const player of participants) {
    const entry = room.stats.get(player.id) || { playerId: player.id, name: player.name, points: 0, streak: 0, bestStreak: 0, played: 0, completed: 0, totalMs: 0 };
    const rank = finishers.indexOf(player) + 1;
    entry.name = player.name; entry.avatar = player.avatar; entry.frame = player.frame; entry.played++;
    if (rank) {
      entry.points += participants.length - rank + 1; entry.completed++; entry.totalMs += player.completedAt - room.startedAt;
    }
    entry.streak = rank === 1 ? entry.streak + 1 : 0;
    entry.bestStreak = Math.max(entry.bestStreak, entry.streak);
    room.stats.set(player.id, entry);
  }
}
function statsRows(room) {
  return [...room.stats.values()].map(entry => ({ ...entry, averageMs: entry.completed ? Math.round(entry.totalMs / entry.completed) : null }))
    .sort((a, b) => b.points - a.points || (a.averageMs ?? Infinity) - (b.averageMs ?? Infinity) || a.playerId.localeCompare(b.playerId));
}
function compactRoom(room) {
  return {
    code: room.code, name: room.name, status: room.status, hostId: room.hostId, visibility: room.visibility, restartPending: Boolean(room.restartPending), hasPassword: Boolean(room.password),
    // Do not reveal the region arrangement to waiting players or spectators.
    puzzle: room.status === 'playing' || room.status === 'finished'
      // The answer rides along once play starts so eliminated players can export the map; cheating is not a concern here.
      ? { ...publicLevel(room.puzzle), solution: room.puzzle.solution }
      : { id: room.puzzle.id, name: room.puzzle.name, size: room.puzzle.size },
    countdownEnds: room.countdownEnds, deadline: room.deadline, sprintMode: room.sprintMode, sprintSeconds: room.sprintSeconds, sprintFactor: room.sprintFactor,
    leaderboard: leaderboardRows(room), stats: statsRows(room), kicked: [...room.kicked.values()],
    players: [...room.players.values()].map(player => ({
      id: player.id, name: player.name, avatar: player.avatar, frame: player.frame, host: player.id === room.hostId, spectator: player.spectator, idle: player.idle, alive: player.alive,
      found: player.found.size, completedAt: player.completedAt,
      cats: [...player.found], marks: [...player.marks], wrong: [...player.wrong]
    }))
  };
}
// A room state carries every player's board, so the frantic events — guesses
// and pencil marks — are coalesced into at most one broadcast per interval
// instead of one per keystroke. Lifecycle changes still go out at once.
const ROOM_BROADCAST_INTERVAL = 50;
function emitRoom(room) {
  clearTimeout(room.broadcastTimer); room.broadcastTimer = null;
  room.lastBroadcast = Date.now();
  io.to(room.code).emit('room-state', compactRoom(room));
}
function emitRoomSoon(room) {
  if (room.broadcastTimer) return;
  room.broadcastTimer = setTimeout(() => emitRoom(room), Math.max(0, ROOM_BROADCAST_INTERVAL - (Date.now() - (room.lastBroadcast || 0))));
}
function racers(room) { return [...room.players.values()].filter(p => !p.spectator); }
// Payload ids are client-supplied, so host-only actions are attributed to the
// seat this socket actually occupies.
function hostBySocket(room, socket) {
  const player = room && [...room.players.values()].find(p => p.socketId === socket.id);
  return player && player.id === room.hostId ? player : null;
}
function reassignHost(room) {
  const people = [...room.players.values()];
  room.hostId = (people.find(p => p.socketId && !p.spectator) || people.find(p => p.socketId) || people[0])?.id || null;
}
function closeRoom(room, reason) {
  clearTimeout(room.timer); clearTimeout(room.countdownTimer); clearTimeout(room.broadcastTimer); clearTimeout(room.spectatorTimer);
  for (const player of room.players.values()) clearTimeout(player.idleTimer);
  rooms.delete(room.code);
  if (reason) io.to(room.code).emit('room-closed', { reason });
}
// The 10 minute clock only runs while nobody is actually racing.
function checkAllSpectator(room) {
  if (!rooms.has(room.code)) return;
  if (racers(room).length) { clearTimeout(room.spectatorTimer); room.spectatorTimer = null; return; }
  if (room.spectatorTimer) return;
  room.spectatorTimer = setTimeout(() => closeRoom(room, '房間只剩觀戰者，已自動關閉'), ALL_SPECTATOR_CLOSE);
}
function makeIdleSpectator(room, player) {
  player.idleTimer = null;
  if (!rooms.has(room.code) || player.socketId) return;
  player.idle = true; player.spectator = true; player.alive = true;
  if (player.id === room.hostId) reassignHost(room);
  // Nobody left to notify, so the room does not need to linger.
  if (![...room.players.values()].some(p => p.socketId)) return closeRoom(room, null);
  if (room.status === 'countdown' && !racers(room).length) { clearTimeout(room.countdownTimer); room.status = 'lobby'; room.countdownEnds = null; }
  else if (room.status === 'playing' && (!racers(room).length || allPlayersResolved(room))) { finishRoom(room); checkAllSpectator(room); return; }
  emitRoom(room); checkAllSpectator(room);
}
function orderedResults(room) {
  return [...room.players.values()].filter(p => p.completedAt).sort((a, b) => a.completedAt - b.completedAt)
    .map((p, index) => ({ rank: index + 1, name: p.name, time: ((p.completedAt - room.startedAt) / 1000).toFixed(1) }));
}
// One record per racer, once per match, so a lost race can still be worked out
// afterwards. Accounts keep theirs in the database; guests go to the JSON file,
// where both the per-visitor list and the visitor count are capped.
function recordMatchHistory(room) {
  const participants = racers(room);
  if (!participants.length) return;
  const results = orderedResults(room);
  const finishers = [...room.players.values()].filter(p => p.completedAt).sort((a, b) => a.completedAt - b.completedAt).map(p => p.id);
  const shared = { matchId: nanoid(10), code: room.code, roomName: room.name, finishedAt: Date.now(),
    size: room.puzzle.size, regions: room.puzzle.regions, solution: room.puzzle.solution, results };
  const history = readJson(HISTORY_PATH, {});
  let guestsTouched = false;
  for (const player of participants) {
    if (!VISITOR_ID.test(String(player.id || ''))) continue;
    const record = { ...shared, outcome: {
      status: player.completedAt ? 'solved' : player.alive ? 'timeout' : 'eliminated',
      rank: finishers.indexOf(player.id) + 1 || null,
      time: player.completedAt ? ((player.completedAt - room.startedAt) / 1000).toFixed(1) : null,
      cats: player.found.size, wrong: [...player.wrong]
    } };
    if (player.kind === 'user') {
      const unlocked = achievements.record(player.id, achievementContext(), { kind: 'match', size: room.puzzle.size, rank: record.outcome.rank, status: record.outcome.status }, () => auth.recordMatch(player.id, record));
      if (unlocked.length && player.socketId) io.to(player.socketId).emit('achievements-unlocked', unlocked);
      continue;
    }
    guestsTouched = true;
    history[player.id] = [record, ...(history[player.id] || [])].slice(0, HISTORY_PER_VISITOR);
  }
  if (!guestsTouched) return;
  const visitors = Object.keys(history);
  if (visitors.length > HISTORY_VISITORS) {
    const keep = visitors.sort((a, b) => (history[b][0]?.finishedAt || 0) - (history[a][0]?.finishedAt || 0)).slice(0, HISTORY_VISITORS);
    for (const visitorId of visitors) if (!keep.includes(visitorId)) delete history[visitorId];
  }
  writeJson(HISTORY_PATH, history);
}
function finishRoom(room) {
  if (room.status !== 'playing') return;
  room.status = 'finished'; clearTimeout(room.timer); room.timer = null;
  awardPoints(room);
  try { recordMatchHistory(room); } catch (error) { console.error('寫入對戰紀錄失敗', error); }
  emitRoom(room); io.to(room.code).emit('game-finished', { results: orderedResults(room) });
}
function allPlayersResolved(room) {
  const racers = [...room.players.values()].filter(player => !player.spectator);
  return racers.length > 0 && racers.every(player => player.completedAt || !player.alive);
}
// Shared by leaving and being kicked: the round must still resolve when the
// seat that vanished was the last one keeping it alive.
function removePlayer(room, player) {
  clearTimeout(player.idleTimer); room.players.delete(player.id);
  if (player.id === room.hostId) reassignHost(room);
  if (![...room.players.values()].some(p => p.socketId)) return closeRoom(room, null);
  if (room.status === 'countdown' && !racers(room).length) { clearTimeout(room.countdownTimer); room.countdownTimer = null; room.status = 'lobby'; room.countdownEnds = null; emitRoom(room); }
  else if (room.status === 'playing' && (!racers(room).length || allPlayersResolved(room))) finishRoom(room);
  else emitRoom(room);
  checkAllSpectator(room);
}
// Aborting a live round is the host's call, so nothing from it may stick:
// no points, no fastest record, no history.
function resetRound(room) {
  const aborted = room.status === 'countdown' || room.status === 'playing';
  clearTimeout(room.timer); clearTimeout(room.countdownTimer); room.timer = null; room.countdownTimer = null;
  if (aborted) room.leaderboard = room.leaderboard.filter(record => record.round !== room.round);
  room.status = 'lobby'; room.startedAt = null; room.deadline = null; room.countdownEnds = null;
  for (const player of room.players.values()) {
    player.alive = true; player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null;
  }
  return aborted;
}

// The handshake carries the same cookie as the API, so the socket's identity
// is settled once here and every event below ignores any id in its payload.
io.use((socket, next) => {
  const resolved = auth.resolve(cookieToken(socket.request.headers.cookie), socket.request.headers['user-agent'], { renew: false });
  if (!resolved) return next(new Error('身分已失效，請重新整理頁面'));
  socket.data.identity = resolved.identity;
  next();
});
io.on('connection', socket => {
  const playerId = socket.data.identity.id, kind = socket.data.identity.kind;
  socket.on('create-room', async ({ name, roomName, levelId, size, visibility, sprintMode, sprintSeconds, sprintFactor } = {}, callback) => {
    let puzzle;
    try { puzzle = levelId ? singleLevels().find(level => level.id === levelId) : await takeMultiplayerPuzzle(size || 7); }
    catch (error) { return callback?.({ error: error.message }); }
    if (!socket.connected) return callback?.({ error: '建立房間時連線已中斷' });
    if (!puzzle) return callback({ error: '找不到關卡' });
    const code = nanoid(5).toUpperCase();
    const room = { code, name: String(roomName || '一起玩 MeowDoku').slice(0, 40), puzzle, status: 'lobby', hostId: playerId, round: 1, leaderboard: [],
      visibility: visibility === 'private' ? 'private' : 'public',
      players: new Map(), kicked: new Map(), stats: new Map(), password: null, startedAt: null, deadline: null, timer: null, spectatorTimer: null,
      sprintMode: normalizeSprintMode(sprintMode, 'fixed'), sprintSeconds: clampSprintSeconds(sprintSeconds), sprintFactor: clampSprintFactor(sprintFactor), chat: [] };
    rooms.set(code, room); joinRoom(socket, room, { name, playerId, kind, spectator: false }); callback({ code });
  });
  socket.on('join-room', async ({ code, name, spectator, password } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback({ error: '房間不存在或已關閉' });
    if (room.kicked.has(playerId)) return callback({ error: '你已被房主移出這個房間，無法再加入' });
    const denied = await checkRoomPassword(socket, room, password);
    if (denied) return callback({ error: denied, needsPassword: true });
    if (!socket.connected || rooms.get(room.code) !== room) return callback({ error: '房間不存在或已關閉' });
    // A match's player roster locks as soon as its countdown begins.
    joinRoom(socket, room, { name, playerId, kind, spectator: Boolean(spectator) || room.status !== 'lobby' });
    callback({ ok: true, spectator: room.status !== 'lobby' || Boolean(spectator) });
  });
  socket.on('start-game', ({ code } = {}, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以開始' });
    if (room.status !== 'lobby') return callback?.({ error: '遊戲已開始' });
    if (room.restartPending) return callback?.({ error: '新題目還在準備中，請稍候' });
    if (![...room.players.values()].some(player => !player.spectator)) return callback?.({ error: '至少需要一位玩家' });
    room.status = 'countdown'; room.countdownEnds = Date.now() + 3000; emitRoom(room);
    room.countdownTimer = setTimeout(() => {
      room.countdownTimer = null; room.status = 'playing'; room.startedAt = Date.now(); room.countdownEnds = null;
      io.to(room.code).emit('match-started'); emitRoom(room);
    }, 3000);
    callback?.({ ok: true });
  });
  socket.on('guess', ({ code, row, col } = {}) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player || room.status !== 'playing' || player.spectator || !player.alive || player.completedAt) return;
    const hit = room.puzzle.solution.some(cat => cat.row === row && cat.col === col);
    if (!hit) {
      player.alive = false; player.wrong.add(`${row}:${col}`);
      socket.emit('guess-result', { row, col, hit: false }); io.to(room.code).emit('player-eliminated', { playerId, row, col });
      if (allPlayersResolved(room)) finishRoom(room); else emitRoomSoon(room);
      return;
    }
    player.found.add(`${row}:${col}`); socket.emit('guess-result', { row, col, hit: true });
    if (player.found.size === room.puzzle.size) {
      player.completedAt = Date.now();
      room.leaderboard.push({ playerId: player.id, name: player.name, avatar: player.avatar, frame: player.frame, ms: player.completedAt - room.startedAt, at: player.completedAt, round: room.round, won: !room.leaderboard.some(record => record.round === room.round && record.won) });
      if (room.leaderboard.length > 200) room.leaderboard.splice(0, room.leaderboard.length - 200);
      if (allPlayersResolved(room)) { finishRoom(room); return; }
      if (!room.deadline) {
        const sprintSeconds = resolveSprintSeconds(room, Date.now() - room.startedAt);
        const sprintMs = sprintSeconds * 1000;
        room.deadline = Date.now() + sprintMs;
        room.timer = setTimeout(() => finishRoom(room), sprintMs);
        io.to(room.code).emit('final-sprint', { deadline: room.deadline, sprintSeconds });
      }
    }
    emitRoomSoon(room);
  });
  socket.on('marks-update', ({ code, marks } = {}) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player || room.status !== 'playing' || player.spectator || !player.alive || !Array.isArray(marks)) return;
    player.marks = new Set(marks.filter(key => typeof key === 'string').slice(0, room.puzzle.size * room.puzzle.size));
    emitRoomSoon(room);
  });
  socket.on('chat-message', ({ code, text } = {}, callback) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player || player.socketId !== socket.id) return callback?.({ error: '找不到房間成員' });
    const clean = String(text ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!clean) return callback?.({ ok: true });
    const now = Date.now();
    player.chatTimes = (player.chatTimes || []).filter(at => now - at < CHAT_WINDOW);
    if (player.chatTimes.length >= CHAT_WINDOW_MAX || now - (player.chatTimes.at(-1) || 0) < CHAT_MIN_GAP) return callback?.({ error: '訊息太頻繁，先喝口水吧' });
    player.chatTimes.push(now);
    const message = { id: nanoid(8), code: room.code, playerId, name: player.name, text: clean, at: now };
    room.chat.push(message); if (room.chat.length > CHAT_HISTORY) room.chat.shift();
    io.to(room.code).emit('chat-message', message);
    callback?.({ ok: true });
  });
  socket.on('set-lobby-role', ({ code, spectator } = {}, callback) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player) return callback?.({ error: '找不到房間成員' });
    // A finished round has already been scored, so switching there only affects the next one.
    if (room.status !== 'lobby' && room.status !== 'finished') return callback?.({ error: '這局還有人在解，結束後才能變更身分' });
    if (room.restartPending) return callback?.({ error: '房主正在準備新題目，請稍候' });
    player.spectator = Boolean(spectator); player.alive = true;
    player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null;
    emitRoom(room); checkAllSpectator(room); callback?.({ ok: true });
  });
  socket.on('set-sprint-setting', ({ code, mode, value } = {}, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以調整最後衝刺時間' });
    if (room.status !== 'lobby') return callback?.({ error: '倒數開始後不能再調整最後衝刺時間' });
    const nextMode = normalizeSprintMode(mode);
    if (!nextMode) return callback?.({ error: '最後衝刺模式不正確' });
    if (nextMode === 'multiply') {
      const factor = clampSprintFactor(value, null);
      if (factor === null) return callback?.({ error: '請輸入有效的倍數（0.1 – 9999）' });
      room.sprintFactor = factor;
    } else {
      const seconds = clampSprintSeconds(value, null);
      if (seconds === null) return callback?.({ error: '請輸入有效的秒數（1 – 9999）' });
      room.sprintSeconds = seconds;
    }
    room.sprintMode = nextMode;
    emitRoom(room); callback?.({ ok: true });
  });
  // Every change is validated (and the new puzzle generated) before anything
  // is applied, so a failure leaves the room exactly as it was.
  socket.on('update-room-settings', async ({ code, size, password, clearPassword, visibility } = {}, callback) => {
    const room = rooms.get(code), host = hostBySocket(room, socket);
    if (!host) return callback?.({ error: '只有房主可以調整房間設定' });
    if (room.status !== 'lobby') return callback?.({ error: '倒數開始後不能再調整房間設定' });
    if (room.restartPending) return callback?.({ error: '新題目還在準備中，請稍候' });
    const changes = {};
    if (visibility !== undefined) {
      if (visibility !== 'public' && visibility !== 'private') return callback?.({ error: '房間類型不正確' });
      changes.visibility = visibility;
    }
    if (clearPassword) changes.password = null;
    else if (password !== undefined) {
      if (typeof password !== 'string') return callback?.({ error: '密碼必須是文字' });
      const clean = password.trim();
      if (!clean) return callback?.({ error: '密碼不能是空白' });
      if (clean.length > PASSWORD_MAX_LEN) return callback?.({ error: `密碼最長 ${PASSWORD_MAX_LEN} 字` });
      changes.password = await hashPassword(clean);
    }
    let nextSize = null;
    if (size !== undefined) {
      if (!Number.isFinite(Number(size))) return callback?.({ error: '棋盤大小不正確' });
      nextSize = clampSize(size);
    }
    if (nextSize === null || nextSize === room.puzzle.size) {
      if (rooms.get(code) !== room || room.status !== 'lobby') return callback?.({ error: '房間狀態已改變，請重新操作' });
      Object.assign(room, changes); emitRoom(room);
      return callback?.({ ok: true });
    }
    room.restartPending = true; emitRoom(room);
    try {
      const puzzle = await generateAsync(nextSize);
      if (rooms.get(code) !== room) return callback?.({ error: '房間已關閉' });
      Object.assign(room, changes); room.puzzle = puzzle;
      for (const player of room.players.values()) { player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null; player.alive = true; }
      io.to(room.code).emit('room-restarted', { message: `房主把棋盤改成 ${nextSize} × ${nextSize}，已換上新題目。` });
      callback?.({ ok: true });
    } catch (error) { callback?.({ error: error.message }); }
    finally { room.restartPending = false; if (rooms.get(code) === room) emitRoom(room); }
  });
  socket.on('kick-player', ({ code, targetId } = {}, callback) => {
    const room = rooms.get(code), host = hostBySocket(room, socket);
    if (!host) return callback?.({ error: '只有房主可以移出玩家' });
    const target = room.players.get(targetId);
    if (!target) return callback?.({ error: '找不到這位成員' });
    if (target.id === host.id) return callback?.({ error: '房主不能把自己踢出去' });
    room.kicked.set(target.id, { id: target.id, name: target.name });
    const targetSocket = target.socketId && io.sockets.sockets.get(target.socketId);
    if (targetSocket) { targetSocket.emit('kicked', { code: room.code, reason: '你已被房主移出房間' }); targetSocket.leave(room.code); }
    removePlayer(room, target);
    callback?.({ ok: true });
  });
  socket.on('unblock-player', ({ code, targetId } = {}, callback) => {
    const room = rooms.get(code);
    if (!hostBySocket(room, socket)) return callback?.({ error: '只有房主可以解除封鎖' });
    if (!room.kicked.delete(targetId)) return callback?.({ error: '這位成員不在封鎖名單中' });
    emitRoom(room); callback?.({ ok: true });
  });
  // The round is reset before the new puzzle exists so a live round stops at
  // once; start-game refuses until the puzzle has been swapped in.
  socket.on('restart-room', async ({ code } = {}, callback) => {
    const room = rooms.get(code), host = hostBySocket(room, socket);
    if (!host) return callback?.({ error: '只有房主可以重新開始' });
    if (room.restartPending) return callback?.({ error: '正在準備下一局，請稍候' });
    room.restartPending = true;
    const aborted = resetRound(room);
    emitRoom(room); checkAllSpectator(room);
    if (aborted) io.to(room.code).emit('room-restarted', { message: '房主重開了這一局，本局不計分。' });
    try {
      const puzzle = await generateAsync(room.puzzle.size);
      if (rooms.get(code) !== room) return callback?.({ error: '房間已關閉' });
      room.puzzle = puzzle; room.round++;
      callback?.({ ok: true });
    } catch (error) { callback?.({ error: error.message }); }
    finally { room.restartPending = false; if (rooms.get(code) === room) emitRoom(room); }
  });
  socket.on('resume-room', async ({ code, name, password } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback?.({ error: '房間不存在或已關閉' });
    if (room.kicked.has(playerId)) return callback?.({ error: '你已被房主移出這個房間，無法再加入' });
    const player = room.players.get(playerId);
    // A seat that is still held was admitted already; only a fresh seat needs the password.
    if (!player) {
      const denied = await checkRoomPassword(socket, room, password);
      if (denied) return callback?.({ error: denied, needsPassword: true });
      if (!socket.connected || rooms.get(room.code) !== room) return callback?.({ error: '房間不存在或已關閉' });
      joinRoom(socket, room, { name, playerId, kind, spectator: true }); return callback?.({ ok: true, spectator: true, movedToSpectator: true });
    }
    const wasIdle = player.idle;
    clearTimeout(player.idleTimer); player.idleTimer = null;
    player.socketId = socket.id; player.disconnectedAt = null; player.idle = false;
    socket.join(room.code); socket.emit('chat-backlog', room.chat); emitRoom(room); checkAllSpectator(room);
    if (room.status === 'finished') socket.emit('game-finished', { results: orderedResults(room) });
    callback?.({ ok: true, spectator: player.spectator, movedToSpectator: wasIdle && player.spectator });
  });
  socket.on('leave-room', ({ code } = {}, callback) => {
    const room = rooms.get(code); const player = room?.players.get(playerId);
    callback?.({ ok: true });
    if (!room || !player) return;
    removePlayer(room, player);
  });
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = [...room.players.values()].find(p => p.socketId === socket.id);
      if (!player) continue;
      player.socketId = null; player.disconnectedAt = Date.now();
      clearTimeout(player.idleTimer);
      player.idleTimer = setTimeout(() => makeIdleSpectator(room, player), IDLE_GRACE);
      break;
    }
  });
});
function joinRoom(socket, room, { name, playerId, kind, spectator }) {
  for (const existing of room.players.values()) if (existing.id === playerId) { clearTimeout(existing.idleTimer); room.players.delete(existing.id); }
  // Looked up fresh rather than from the handshake identity, so a frame picked
  // on the profile page shows up in the next room without reconnecting.
  const user = kind === 'user' ? auth.userById(playerId) : null;
  const player = { id: playerId, kind, name: String(name || '神秘貓奴').slice(0, 20), avatar: user?.avatar || DEFAULT_AVATAR, frame: user?.frame || DEFAULT_FRAME, spectator, socketId: socket.id, idle: false, disconnectedAt: null, idleTimer: null, alive: true, found: new Set(), marks: new Set(), wrong: new Set(), completedAt: null };
  room.players.set(playerId, player); socket.join(room.code); socket.emit('chat-backlog', room.chat); emitRoom(room); checkAllSpectator(room);
  if (room.status === 'finished') socket.emit('game-finished', { results: orderedResults(room) });
}

if (require.main === module) server.listen(PORT, () => { console.log(`MeowDoku is ready at http://localhost:${PORT}`); startLadder(); });

module.exports = { app, server, io, db, auth, achievements, rooms, compactRoom };
