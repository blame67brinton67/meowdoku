const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'meowdoku-admin';
const DATA_DIR = path.join(__dirname, 'data');
const LEVELS_PATH = path.join(DATA_DIR, 'levels.json');
const SCORES_PATH = path.join(DATA_DIR, 'scores.json');
const PUZZLE_POOL_PATH = path.join(DATA_DIR, 'multiplayer-puzzle-pool.json');
const rooms = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function neighbors(index, size) {
  const row = Math.floor(index / size), col = index % size, result = [];
  if (row) result.push(index - size);
  if (row < size - 1) result.push(index + size);
  if (col) result.push(index - 1);
  if (col < size - 1) result.push(index + 1);
  return result;
}

// Region growth guarantees connectivity.  We accept a board only after the
// independent permutation solver confirms exactly one cat placement.
function countSolutions(regions, size, stopAt = 2) {
  const usedCols = new Set(), usedRegions = new Set();
  let solutions = 0;
  function search(row, previousCol) {
    if (solutions >= stopAt) return;
    if (row === size) { solutions++; return; }
    for (let col = 0; col < size; col++) {
      const region = regions[row * size + col];
      // Rows are considered from top to bottom, so only the preceding row can
      // contain a king-adjacent cat. Columns are already unique by this point.
      if (usedCols.has(col) || usedRegions.has(region) || Math.abs(previousCol - col) <= 1) continue;
      usedCols.add(col); usedRegions.add(region);
      search(row + 1, col);
      usedCols.delete(col); usedRegions.delete(region);
    }
  }
  search(0, -99);
  return solutions;
}
function randomNoTouchingColumns(size) {
  // Build the answer row by row. Every choice is random among columns that
  // have not appeared before and cannot touch the cat in the previous row.
  const usedColumns = new Set(), columns = [];
  for (let row = 0; row < size; row++) {
    const candidates = Array.from({ length: size }, (_, column) => column)
      .filter(column => !usedColumns.has(column) && (row === 0 || Math.abs(column - columns[row - 1]) > 1));
    if (!candidates.length) return null;
    const column = candidates[Math.floor(Math.random() * candidates.length)];
    usedColumns.add(column); columns.push(column);
  }
  return columns;
}
function growRegionsWithMultiSourceBfs(size, cats) {
  const regions = Array(size * size).fill(-1);
  const frontiers = cats.map((cell, region) => {
    regions[cell] = region;
    return new Set(neighbors(cell, size));
  });
  let unassigned = size * size - cats.length;
  // Each round first chooses a colour, not a cell. That gives every colour
  // with an open frontier the same chance to grow one step, preventing a
  // large region from snowballing merely because it owns more frontier cells.
  while (unassigned) {
    const expandable = [];
    frontiers.forEach((frontier, region) => {
      for (const cell of frontier) if (regions[cell] !== -1) frontier.delete(cell);
      if (frontier.size) expandable.push(region);
    });
    if (!expandable.length) throw new Error('色塊擴張意外停止');
    const region = expandable[Math.floor(Math.random() * expandable.length)];
    const frontier = frontiers[region];
    const options = [...frontier];
    const cell = options[Math.floor(Math.random() * options.length)];
    frontier.delete(cell);
    if (regions[cell] !== -1) continue;
    regions[cell] = region; unassigned--;
    neighbors(cell, size).forEach(next => { if (regions[next] === -1) frontier.add(next); });
  }
  return regions;
}
function generatePuzzle(size = 7) {
  size = Math.max(4, Math.min(10, Number(size) || 7));
  // Reject the entire board whenever it has zero or multiple answers. This is
  // intentionally a pure generate-and-verify loop: no fixed answer pattern
  // and no post-generation alteration of the regions is used.
  for (;;) {
    const permutation = randomNoTouchingColumns(size);
    if (!permutation) continue;
    const cats = permutation.map((column, row) => row * size + column);
    const regions = growRegionsWithMultiSourceBfs(size, cats);
    if (countSolutions(regions, size) === 1) {
      return { size, regions, solution: cats.map(cell => ({ row: Math.floor(cell / size), col: cell % size })) };
    }
  }
}
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
function refillMultiplayerPool(size) {
  if (refillingPoolSizes.has(size)) return;
  refillingPoolSizes.add(size);
  setImmediate(() => {
    try {
      const existing = multiplayerPuzzlePool.filter(puzzle => puzzle.size === size).length;
      for (let count = existing; count < MULTIPLAYER_POOL_PER_SIZE; count++) multiplayerPuzzlePool.push(generatePuzzle(size));
      writeJson(PUZZLE_POOL_PATH, multiplayerPuzzlePool);
    } finally { refillingPoolSizes.delete(size); }
  });
}
function takeMultiplayerPuzzle(size) {
  const normalizedSize = Math.max(4, Math.min(10, Number(size) || 7));
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
    countdownEnds: room.countdownEnds, deadline: room.deadline,
    players: [...room.players.values()].map(player => ({
      id: player.id, name: player.name, host: player.id === room.hostId, spectator: player.spectator, alive: player.alive,
      found: player.found.size, completedAt: player.completedAt,
      cats: [...player.found], marks: [...player.marks], wrong: [...player.wrong]
    }))
  };
}
function emitRoom(room) { io.to(room.code).emit('room-state', compactRoom(room)); }
function orderedResults(room) {
  return [...room.players.values()].filter(p => p.completedAt).sort((a, b) => a.completedAt - b.completedAt)
    .map((p, index) => ({ rank: index + 1, name: p.name, time: ((p.completedAt - room.startedAt) / 1000).toFixed(1) }));
}
function finishRoom(room) {
  if (room.status !== 'playing') return;
  room.status = 'finished'; clearTimeout(room.timer);
  io.to(room.code).emit('game-finished', { results: orderedResults(room) }); emitRoom(room);
}
function allPlayersResolved(room) {
  const racers = [...room.players.values()].filter(player => !player.spectator);
  return racers.length > 0 && racers.every(player => player.completedAt || !player.alive);
}

io.on('connection', socket => {
  socket.on('create-room', ({ name, playerId, roomName, levelId, size, visibility }, callback) => {
    const puzzle = levelId ? levels.find(level => level.id === levelId) : takeMultiplayerPuzzle(size || 7);
    if (!puzzle) return callback({ error: '找不到關卡' });
    const code = nanoid(5).toUpperCase();
    const room = { code, name: String(roomName || '一起玩 MeowDoku').slice(0, 40), puzzle, status: 'lobby', hostId: playerId,
      visibility: visibility === 'private' ? 'private' : 'public',
      players: new Map(), startedAt: null, deadline: null, timer: null };
    rooms.set(code, room); joinRoom(socket, room, { name, playerId, spectator: false }); callback({ code });
  });
  socket.on('join-room', ({ code, name, playerId, spectator }, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback({ error: '房間不存在或已關閉' });
    // A match's player roster locks as soon as its countdown begins.
    joinRoom(socket, room, { name, playerId, spectator: Boolean(spectator) || room.status !== 'lobby' }); callback({ ok: true, spectator: room.status !== 'lobby' || Boolean(spectator) });
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
      if (allPlayersResolved(room)) finishRoom(room); else emitRoom(room);
      return;
    }
    player.found.add(`${row}:${col}`); socket.emit('guess-result', { row, col, hit: true });
    if (player.found.size === room.puzzle.size) {
      player.completedAt = Date.now();
      if (allPlayersResolved(room)) { finishRoom(room); return; }
      if (!room.deadline) {
        room.deadline = Date.now() + 60_000;
        room.timer = setTimeout(() => finishRoom(room), 60_000);
        io.to(room.code).emit('final-sprint', { deadline: room.deadline });
      }
    }
    emitRoom(room);
  });
  socket.on('marks-update', ({ code, playerId, marks }) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player || room.status !== 'playing' || player.spectator || !player.alive || !Array.isArray(marks)) return;
    player.marks = new Set(marks.filter(key => typeof key === 'string').slice(0, room.puzzle.size * room.puzzle.size));
    emitRoom(room);
  });
  socket.on('set-lobby-role', ({ code, playerId, spectator }, callback) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player) return callback?.({ error: '找不到房間成員' });
    if (room.status !== 'lobby') return callback?.({ error: '倒數開始後不能再變更身分' });
    player.spectator = Boolean(spectator); player.alive = true;
    player.found.clear(); player.marks.clear(); player.wrong.clear(); player.completedAt = null;
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
    emitRoom(room); callback?.({ ok: true });
  });
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const removed = [...room.players.values()].find(player => player.socketId === socket.id);
      if (!removed) continue;
      room.players.delete(removed.id);
      if (removed.id === room.hostId) room.hostId = [...room.players.values()].find(player => !player.spectator)?.id || [...room.players.keys()][0];
      if (!room.players.size) { clearTimeout(room.timer); clearTimeout(room.countdownTimer); rooms.delete(room.code); } else emitRoom(room);
      break;
    }
  });
});
function joinRoom(socket, room, { name, playerId, spectator }) {
  for (const existing of room.players.values()) if (existing.id === playerId) room.players.delete(existing.id);
  const player = { id: playerId, name: String(name || '神秘貓奴').slice(0, 20), spectator, socketId: socket.id, alive: true, found: new Set(), marks: new Set(), wrong: new Set(), completedAt: null };
  room.players.set(playerId, player); socket.join(room.code); emitRoom(room);
}

server.listen(PORT, () => console.log(`MeowDoku is ready at http://localhost:${PORT}`));
