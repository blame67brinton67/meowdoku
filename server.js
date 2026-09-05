const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const { openDb } = require('./db');
const { createAuth } = require('./auth');
const { generatePuzzle, countSolutions, clampSize, parseBoardText } = require('./puzzle');
const { generateAsync } = require('./generator');
const { clampSprintSeconds, clampSprintFactor, normalizeSprintMode, resolveSprintSeconds } = require('./sprint');
const { rate } = require('./difficulty');
const { buildLadder, validLadder, LADDER_VERSION, LADDER_LENGTH } = require('./ladder');

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
const LADDER_PATH = path.join(DATA_DIR, 'ladder.json');
const rooms = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_PATH);
const auth = createAuth(db);
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
function singleLevels() {
  return [...ladder, ...levels].sort((a, b) => (a.rating?.score || 0) - (b.rating?.score || 0) || a.createdAt - b.createdAt);
}
let multiplayerPuzzlePool = readJson(PUZZLE_POOL_PATH, []);
const refillingPoolSizes = new Set();
const MULTIPLAYER_POOL_PER_SIZE = 4;
function publicLevel(level) {
  const rating = level.rating ? { ...level.rating } : null;
  if (rating) delete rating.solution;
  return { id: level.id, name: level.name, size: level.size, regions: level.regions, createdAt: level.createdAt, rating };
}
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
function scoreRows() {
  const guests = Object.values(readJson(SCORES_PATH, {})).map(({ name, cleared }) => ({ name, cleared: cleared.length }));
  return [...auth.userLeaderboard(), ...guests].sort((a, b) => b.cleared - a.cleared || a.name.localeCompare(b.name, 'zh-Hant'));
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
app.get('/api/leaderboard', (_req, res) => res.json(scoreRows()));
app.get('/api/public-rooms', (_req, res) => {
  const visibleRooms = [...rooms.values()]
    .filter(room => room.visibility === 'public' && room.status !== 'finished')
    .map(room => ({
      code: room.code, name: room.name, size: room.puzzle.size, status: room.status,
      players: [...room.players.values()].filter(player => !player.spectator).length,
      spectators: [...room.players.values()].filter(player => player.spectator).length
    }));
  res.json(visibleRooms);
});
app.get('/api/progress/me', ensureIdentity, (req, res) => res.json({ cleared: clearedFor(req.identity) }));
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
app.post('/api/single-complete', ensureIdentity, (req, res) => {
  const { name, levelId } = req.body || {};
  const list = singleLevels();
  const levelIndex = list.findIndex(level => level.id === levelId);
  if (!name || levelIndex < 0) return res.status(400).json({ error: '資料不完整' });
  const cleared = clearedFor(req.identity);
  // Replaying something already cleared stays allowed even when a newly rated
  // level has since sorted in between it and the rung below.
  if (levelIndex > 0 && !cleared.includes(levelId) && !cleared.includes(list[levelIndex - 1].id)) return res.status(403).json({ error: '請先完成前一關' });
  if (isUser(req)) {
    auth.clearLevel(req.identity.id, levelId);
    return res.json({ ok: true, cleared: auth.clearedLevels(req.identity.id).length });
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
    res.status(201).json(publicLevel(level));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/admin/levels/import', requireAdmin, (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({ error: '地圖文字必須是文字格式。' });
  if (text.length > 8192) return res.status(400).json({ error: '地圖文字不得超過 8 KB。' });
  let puzzle;
  try { puzzle = parseBoardText(text); } catch (error) { return res.status(400).json({ error: error.message }); }
  const level = { id: nanoid(8), name: String(req.body?.name || `${puzzle.size} × ${puzzle.size} 匯入關卡`).slice(0, 40), createdAt: Date.now(), ...puzzle, rating: rate(puzzle) };
  levels = [...levels, level]; writeJson(LEVELS_PATH, levels);
  res.status(201).json(publicLevel(level));
});

function leaderboardRows(room) {
  const players = new Map();
  for (const record of room.leaderboard) {
    const current = players.get(record.playerId);
    if (!current) players.set(record.playerId, { playerId: record.playerId, name: record.name, ms: record.ms, round: record.round, wins: record.won ? 1 : 0 });
    else {
      current.wins += record.won ? 1 : 0;
      if (record.ms < current.ms) { current.ms = record.ms; current.round = record.round; current.name = record.name; }
    }
  }
  return [...players.values()].sort((a, b) => a.ms - b.ms || a.playerId.localeCompare(b.playerId)).slice(0, 10);
}
function compactRoom(room) {
  return {
    code: room.code, name: room.name, status: room.status, hostId: room.hostId, visibility: room.visibility,
    // Do not reveal the region arrangement to waiting players or spectators.
    puzzle: room.status === 'playing' || room.status === 'finished'
      ? { ...publicLevel(room.puzzle), ...(room.status === 'finished' ? { solution: room.puzzle.solution } : {}) }
      : { id: room.puzzle.id, name: room.puzzle.name, size: room.puzzle.size },
    countdownEnds: room.countdownEnds, deadline: room.deadline, sprintMode: room.sprintMode, sprintSeconds: room.sprintSeconds, sprintFactor: room.sprintFactor,
    leaderboard: leaderboardRows(room),
    players: [...room.players.values()].map(player => ({
      id: player.id, name: player.name, host: player.id === room.hostId, spectator: player.spectator, idle: player.idle, alive: player.alive,
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
    if (player.kind === 'user') { auth.recordMatch(player.id, record); continue; }
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
  room.status = 'finished'; clearTimeout(room.timer);
  try { recordMatchHistory(room); } catch (error) { console.error('寫入對戰紀錄失敗', error); }
  emitRoom(room); io.to(room.code).emit('game-finished', { results: orderedResults(room) });
}
function allPlayersResolved(room) {
  const racers = [...room.players.values()].filter(player => !player.spectator);
  return racers.length > 0 && racers.every(player => player.completedAt || !player.alive);
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
      players: new Map(), startedAt: null, deadline: null, timer: null, spectatorTimer: null,
      sprintMode: normalizeSprintMode(sprintMode, 'fixed'), sprintSeconds: clampSprintSeconds(sprintSeconds), sprintFactor: clampSprintFactor(sprintFactor), chat: [] };
    rooms.set(code, room); joinRoom(socket, room, { name, playerId, kind, spectator: false }); callback({ code });
  });
  socket.on('join-room', ({ code, name, spectator } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback({ error: '房間不存在或已關閉' });
    // A match's player roster locks as soon as its countdown begins.
    joinRoom(socket, room, { name, playerId, kind, spectator: Boolean(spectator) || room.status !== 'lobby' });
    callback({ ok: true, spectator: room.status !== 'lobby' || Boolean(spectator) });
  });
  socket.on('start-game', ({ code } = {}, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以開始' });
    if (room.status !== 'lobby') return callback?.({ error: '遊戲已開始' });
    if (![...room.players.values()].some(player => !player.spectator)) return callback?.({ error: '至少需要一位玩家' });
    room.status = 'countdown'; room.countdownEnds = Date.now() + 3000; emitRoom(room);
    room.countdownTimer = setTimeout(() => {
      room.status = 'playing'; room.startedAt = Date.now(); room.countdownEnds = null;
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
      room.leaderboard.push({ playerId: player.id, name: player.name, ms: player.completedAt - room.startedAt, at: player.completedAt, round: room.round, won: !room.leaderboard.some(record => record.round === room.round && record.won) });
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
    if (room.status !== 'lobby') return callback?.({ error: '倒數開始後不能再變更身分' });
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
  socket.on('restart-room', async ({ code } = {}, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以重新開始' });
    if (room.status !== 'finished') return callback?.({ error: '本局尚未結束' });
    if (room.restartPending) return callback?.({ error: '正在準備下一局，請稍候' });
    room.restartPending = true;
    try {
      const puzzle = await generateAsync(room.puzzle.size);
      if (!socket.connected || rooms.get(code) !== room || room.hostId !== playerId) return callback?.({ error: '房間已關閉或房主已離開' });
      clearTimeout(room.timer); clearTimeout(room.countdownTimer);
      room.puzzle = puzzle; room.round++; room.status = 'lobby'; room.startedAt = null; room.deadline = null; room.countdownEnds = null;
      for (const player of room.players.values()) {
        player.alive = true; player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null;
      }
      emitRoom(room); checkAllSpectator(room); callback?.({ ok: true });
    } catch (error) { callback?.({ error: error.message }); }
    finally { room.restartPending = false; }
  });
  socket.on('resume-room', ({ code, name } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback?.({ error: '房間不存在或已關閉' });
    const player = room.players.get(playerId);
    if (!player) { joinRoom(socket, room, { name, playerId, kind, spectator: true }); return callback?.({ ok: true, spectator: true, movedToSpectator: true }); }
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
    clearTimeout(player.idleTimer); room.players.delete(playerId);
    if (playerId === room.hostId) reassignHost(room);
    if (![...room.players.values()].some(p => p.socketId)) return closeRoom(room, null);
    if (room.status === 'countdown' && !racers(room).length) { clearTimeout(room.countdownTimer); room.status = 'lobby'; room.countdownEnds = null; emitRoom(room); }
    else if (room.status === 'playing' && (!racers(room).length || allPlayersResolved(room))) finishRoom(room);
    else emitRoom(room);
    checkAllSpectator(room);
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
  const player = { id: playerId, kind, name: String(name || '神秘貓奴').slice(0, 20), spectator, socketId: socket.id, idle: false, disconnectedAt: null, idleTimer: null, alive: true, found: new Set(), marks: new Set(), wrong: new Set(), completedAt: null };
  room.players.set(playerId, player); socket.join(room.code); socket.emit('chat-backlog', room.chat); emitRoom(room); checkAllSpectator(room);
  if (room.status === 'finished') socket.emit('game-finished', { results: orderedResults(room) });
}

if (require.main === module) server.listen(PORT, () => { console.log(`MeowDoku is ready at http://localhost:${PORT}`); startLadder(); });

module.exports = { app, server, io, db, auth, rooms };
