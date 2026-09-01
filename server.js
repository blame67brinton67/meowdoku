const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');
const { generatePuzzle, countSolutions, clampSize } = require('./puzzle');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'meowdoku-admin';
const SPRINT_MIN = 15, SPRINT_MAX = 300, SPRINT_DEFAULT = 60;
const IDLE_GRACE = 20_000;
const CHAT_MAX_LEN = 200, CHAT_HISTORY = 50, CHAT_WINDOW = 5_000, CHAT_WINDOW_MAX = 5, CHAT_MIN_GAP = 400;
const ALL_SPECTATOR_CLOSE = 10 * 60_000;
const DATA_DIR = path.join(__dirname, 'data');
const LEVELS_PATH = path.join(DATA_DIR, 'levels.json');
const SCORES_PATH = path.join(DATA_DIR, 'scores.json');
const PUZZLE_POOL_PATH = path.join(DATA_DIR, 'multiplayer-puzzle-pool.json');
const rooms = new Map();

function clampSprintSeconds(value, fallback = SPRINT_DEFAULT) {
  const seconds = Math.round(Number(value));
  return Number.isFinite(seconds) ? Math.min(SPRINT_MAX, Math.max(SPRINT_MIN, seconds)) : fallback;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function loadLevels() {
  const levels = readJson(LEVELS_PATH, []);
  if (levels.length) {
    // Existing boards from before the no-touching rule are transparently
    // regenerated, while their names and identifiers stay stable.
    const upgraded = levels.map(level => {
      if (level.name === '新手的第一盒罐罐' && level.size < 7) return { ...level, ...generatePuzzle(7), createdAt: Date.now() };
      if (countSolutions(level.regions, level.size) === 1) return level;
      return { ...level, ...generatePuzzle(level.size), createdAt: Date.now() };
    });
    if (upgraded.some((level, index) => level !== levels[index])) writeJson(LEVELS_PATH, upgraded);
    return upgraded;
  }
  const starter = { id: nanoid(8), name: '新手的第一盒罐罐', createdAt: Date.now(), ...generatePuzzle(7) };
  writeJson(LEVELS_PATH, [starter]);
  return [starter];
}
let levels = loadLevels();
let multiplayerPuzzlePool = readJson(PUZZLE_POOL_PATH, []);
const refillingPoolSizes = new Set();
const MULTIPLAYER_POOL_PER_SIZE = 4;
function publicLevel(level) { return { id: level.id, name: level.name, size: level.size, regions: level.regions, createdAt: level.createdAt }; }
// One puzzle per tick: the pool is refilled without holding up the socket
// traffic of a match that is already running.
function refillMultiplayerPool(size) {
  if (refillingPoolSizes.has(size)) return;
  refillingPoolSizes.add(size);
  const addOne = () => {
    if (multiplayerPuzzlePool.filter(puzzle => puzzle.size === size).length >= MULTIPLAYER_POOL_PER_SIZE) {
      refillingPoolSizes.delete(size);
      return;
    }
    try {
      multiplayerPuzzlePool.push(generatePuzzle(size));
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
function takeMultiplayerPuzzle(size) {
  const normalizedSize = clampSize(size);
  const index = multiplayerPuzzlePool.findIndex(puzzle => puzzle.size === normalizedSize);
  const puzzle = index < 0 ? generatePuzzle(normalizedSize) : multiplayerPuzzlePool.splice(index, 1)[0];
  if (index >= 0) writeJson(PUZZLE_POOL_PATH, multiplayerPuzzlePool);
  refillMultiplayerPool(normalizedSize);
  return puzzle;
}
function scoreRows() {
  const scores = readJson(SCORES_PATH, {});
  return Object.values(scores).sort((a, b) => b.cleared.length - a.cleared.length || a.name.localeCompare(b.name, 'zh-Hant'))
    .map(({ name, cleared }) => ({ name, cleared: cleared.length }));
}

app.get('/api/levels', (_req, res) => res.json(levels.map(publicLevel)));
app.get('/api/levels/:id', (req, res) => {
  const level = levels.find(item => item.id === req.params.id);
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
app.get('/api/progress/:visitorId', (req, res) => {
  const scores = readJson(SCORES_PATH, {});
  const entry = scores[req.params.visitorId];
  res.json({ cleared: entry?.cleared || [] });
});
app.post('/api/single-complete', (req, res) => {
  const { visitorId, name, levelId } = req.body || {};
  const levelIndex = levels.findIndex(level => level.id === levelId);
  if (!visitorId || !name || levelIndex < 0) return res.status(400).json({ error: '資料不完整' });
  const scores = readJson(SCORES_PATH, {});
  const entry = scores[visitorId] || { name: String(name).slice(0, 20), cleared: [] };
  entry.name = String(name).slice(0, 20);
  if (levelIndex > 0 && !entry.cleared.includes(levels[levelIndex - 1].id)) return res.status(403).json({ error: '請先完成前一關' });
  if (!entry.cleared.includes(levelId)) entry.cleared.push(levelId);
  scores[visitorId] = entry;
  writeJson(SCORES_PATH, scores);
  res.json({ ok: true, cleared: entry.cleared.length });
});
app.post('/api/admin/levels', (req, res) => {
  if (req.header('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: '管理密鑰不正確' });
  try {
    const puzzle = generatePuzzle(req.body?.size);
    const level = { id: nanoid(8), name: String(req.body?.name || `${puzzle.size} × ${puzzle.size} 新關卡`).slice(0, 40), createdAt: Date.now(), ...puzzle };
    levels = [...levels, level]; writeJson(LEVELS_PATH, levels);
    res.status(201).json(publicLevel(level));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

function compactRoom(room) {
  return {
    code: room.code, name: room.name, status: room.status, hostId: room.hostId, visibility: room.visibility,
    // Do not reveal the region arrangement to waiting players or spectators.
    puzzle: room.status === 'playing' || room.status === 'finished'
      ? publicLevel(room.puzzle)
      : { id: room.puzzle.id, name: room.puzzle.name, size: room.puzzle.size },
    countdownEnds: room.countdownEnds, deadline: room.deadline, sprintSeconds: room.sprintSeconds,
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
function finishRoom(room) {
  if (room.status !== 'playing') return;
  room.status = 'finished'; clearTimeout(room.timer);
  emitRoom(room); io.to(room.code).emit('game-finished', { results: orderedResults(room) });
}
function allPlayersResolved(room) {
  const racers = [...room.players.values()].filter(player => !player.spectator);
  return racers.length > 0 && racers.every(player => player.completedAt || !player.alive);
}

io.on('connection', socket => {
  socket.on('create-room', ({ name, playerId, roomName, levelId, size, visibility, sprintSeconds }, callback) => {
    const puzzle = levelId ? levels.find(level => level.id === levelId) : takeMultiplayerPuzzle(size || 7);
    if (!puzzle) return callback({ error: '找不到關卡' });
    const code = nanoid(5).toUpperCase();
    const room = { code, name: String(roomName || '一起玩 MeowDoku').slice(0, 40), puzzle, status: 'lobby', hostId: playerId,
      visibility: visibility === 'private' ? 'private' : 'public',
      players: new Map(), startedAt: null, deadline: null, timer: null, spectatorTimer: null, sprintSeconds: clampSprintSeconds(sprintSeconds), chat: [] };
    rooms.set(code, room); joinRoom(socket, room, { name, playerId, spectator: false }); callback({ code });
  });
  socket.on('join-room', ({ code, name, playerId, spectator }, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback({ error: '房間不存在或已關閉' });
    // A match's player roster locks as soon as its countdown begins.
    joinRoom(socket, room, { name, playerId, spectator: Boolean(spectator) || room.status !== 'lobby' });
    if (room.status === 'finished') socket.emit('game-finished', { results: orderedResults(room) });
    callback({ ok: true, spectator: room.status !== 'lobby' || Boolean(spectator) });
  });
  socket.on('start-game', ({ code, playerId }, callback) => {
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
  socket.on('guess', ({ code, playerId, row, col }, callback) => {
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
      if (allPlayersResolved(room)) { finishRoom(room); return; }
      if (!room.deadline) {
        const sprintMs = room.sprintSeconds * 1000;
        room.deadline = Date.now() + sprintMs;
        room.timer = setTimeout(() => finishRoom(room), sprintMs);
        io.to(room.code).emit('final-sprint', { deadline: room.deadline, sprintSeconds: room.sprintSeconds });
      }
    }
    emitRoomSoon(room);
  });
  socket.on('marks-update', ({ code, playerId, marks }) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player || room.status !== 'playing' || player.spectator || !player.alive || !Array.isArray(marks)) return;
    player.marks = new Set(marks.filter(key => typeof key === 'string').slice(0, room.puzzle.size * room.puzzle.size));
    emitRoomSoon(room);
  });
  socket.on('chat-message', ({ code, playerId, text }, callback) => {
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
  socket.on('set-lobby-role', ({ code, playerId, spectator }, callback) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player) return callback?.({ error: '找不到房間成員' });
    if (room.status !== 'lobby') return callback?.({ error: '倒數開始後不能再變更身分' });
    player.spectator = Boolean(spectator); player.alive = true;
    player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null;
    emitRoom(room); checkAllSpectator(room); callback?.({ ok: true });
  });
  socket.on('set-sprint-seconds', ({ code, playerId, seconds }, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以調整最後衝刺時間' });
    if (room.status !== 'lobby') return callback?.({ error: '倒數開始後不能再調整最後衝刺時間' });
    if (!Number.isFinite(Number(seconds))) return callback?.({ error: '請輸入有效的秒數' });
    room.sprintSeconds = clampSprintSeconds(seconds, room.sprintSeconds);
    emitRoom(room); callback?.({ ok: true });
  });
  socket.on('restart-room', ({ code, playerId }, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以重新開始' });
    if (room.status !== 'finished') return callback?.({ error: '本局尚未結束' });
    clearTimeout(room.timer); clearTimeout(room.countdownTimer);
    room.puzzle = generatePuzzle(room.puzzle.size); room.status = 'lobby'; room.startedAt = null; room.deadline = null; room.countdownEnds = null;
    for (const player of room.players.values()) {
      player.alive = true; player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null;
    }
    emitRoom(room); checkAllSpectator(room); callback?.({ ok: true });
  });
  socket.on('resume-room', ({ code, playerId, name }, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback?.({ error: '房間不存在或已關閉' });
    const player = room.players.get(playerId);
    if (!player) { joinRoom(socket, room, { name, playerId, spectator: true }); return callback?.({ ok: true, spectator: true, movedToSpectator: true }); }
    const wasIdle = player.idle;
    clearTimeout(player.idleTimer); player.idleTimer = null;
    player.socketId = socket.id; player.disconnectedAt = null; player.idle = false;
    socket.join(room.code); socket.emit('chat-backlog', room.chat); emitRoom(room); checkAllSpectator(room);
    if (room.status === 'finished') socket.emit('game-finished', { results: orderedResults(room) });
    callback?.({ ok: true, spectator: player.spectator, movedToSpectator: wasIdle && player.spectator });
  });
  socket.on('leave-room', ({ code, playerId }, callback) => {
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
function joinRoom(socket, room, { name, playerId, spectator }) {
  for (const existing of room.players.values()) if (existing.id === playerId) { clearTimeout(existing.idleTimer); room.players.delete(existing.id); }
  const player = { id: playerId, name: String(name || '神秘貓奴').slice(0, 20), spectator, socketId: socket.id, idle: false, disconnectedAt: null, idleTimer: null, alive: true, found: new Set(), marks: new Set(), wrong: new Set(), completedAt: null };
  room.players.set(playerId, player); socket.join(room.code); socket.emit('chat-backlog', room.chat); emitRoom(room); checkAllSpectator(room);
}

server.listen(PORT, () => console.log(`MeowDoku is ready at http://localhost:${PORT}`));
