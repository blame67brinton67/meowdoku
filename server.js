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
function findAlternative(regions, size, expectedColumns) {
  const usedCols = new Set(), usedRegions = new Set(), selected = [];
  function search(row, previousCol) {
    if (row === size) return selected.some((col, index) => col !== expectedColumns[index]) ? [...selected] : null;
    // Try the intended solution first. It lets us stop at the very first
    // competing placement rather than enumerating every valid board.
    const options = [expectedColumns[row], ...Array.from({ length: size }, (_, col) => col).filter(col => col !== expectedColumns[row])];
    for (const col of options) {
      const region = regions[row * size + col];
      if (usedCols.has(col) || usedRegions.has(region) || Math.abs(previousCol - col) <= 1) continue;
      usedCols.add(col); usedRegions.add(region); selected.push(col);
      const result = search(row + 1, col);
      if (result) return result;
      selected.pop(); usedCols.delete(col); usedRegions.delete(region);
    }
    return null;
  }
  return search(0, -99);
}
function staysConnectedAfterRemoval(regions, size, cell, region) {
  const members = regions.flatMap((value, index) => value === region && index !== cell ? [index] : []);
  if (!members.length) return false;
  const visited = new Set([members[0]]), queue = [members[0]];
  while (queue.length) {
    const current = queue.shift();
    neighbors(current, size).forEach(next => {
      if (next !== cell && regions[next] === region && !visited.has(next)) { visited.add(next); queue.push(next); }
    });
  }
  return visited.size === members.length;
}
function removeAlternatives(regions, size, expectedColumns) {
  const catCells = new Set(expectedColumns.map((col, row) => row * size + col));
  for (let step = 0; step < size * size * 4; step++) {
    const alternative = findAlternative(regions, size, expectedColumns);
    if (!alternative) return true;
    const candidates = shuffled(alternative.map((col, row) => row * size + col)
      .filter((cell, row) => alternative[row] !== expectedColumns[row] && !catCells.has(cell)));
    let changed = false;
    for (const cell of candidates) {
      const from = regions[cell];
      const options = shuffled(neighbors(cell, size).filter(next => regions[next] !== from));
      if (!options.length || !staysConnectedAfterRemoval(regions, size, cell, from)) continue;
      regions[cell] = regions[options[0]];
      changed = true;
      break;
    }
    if (!changed) return false;
  }
  return false;
}
function generatePuzzle(size = 7) {
  size = Math.max(4, Math.min(10, Number(size) || 7));
  for (let attempt = 0; attempt < 160; attempt++) {
    // Even columns followed by odd columns keeps consecutive rows at least two
    // columns apart, satisfying the no-touching rule before regions are grown.
    const split = Math.ceil(size / 2);
    let permutation = Array.from({ length: size }, (_, row) => row < split ? row * 2 : (row - split) * 2 + 1);
    if (Math.random() < .5) permutation = permutation.map(col => size - 1 - col);
    const cats = permutation.map((col, row) => row * size + col);
    const regions = Array(size * size).fill(-1);
    cats.forEach((cell, region) => { regions[cell] = region; });
    const owned = cats.map(cell => [cell]);
    let remaining = size * size - size;
    while (remaining) {
      const choices = [];
      for (let region = 0; region < size; region++) {
        const frontier = new Set();
        owned[region].forEach(cell => neighbors(cell, size).forEach(next => {
          if (regions[next] === -1) frontier.add(next);
        }));
        if (frontier.size) choices.push([region, [...frontier]]);
      }
      if (!choices.length) break;
      const [region, frontier] = choices[Math.floor(Math.random() * choices.length)];
      const cell = frontier[Math.floor(Math.random() * frontier.length)];
      regions[cell] = region; owned[region].push(cell); remaining--;
    }
    if (remaining === 0 && removeAlternatives(regions, size, permutation) && countSolutions(regions, size) === 1) {
      return { size, regions, solution: cats.map(cell => ({ row: Math.floor(cell / size), col: cell % size })) };
    }
  }
  throw new Error('關卡生成逾時，請再試一次');
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
function publicLevel(level) { return { id: level.id, name: level.name, size: level.size, regions: level.regions, createdAt: level.createdAt }; }
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
app.post('/api/single-complete', (req, res) => {
  const { visitorId, name, levelId } = req.body || {};
  if (!visitorId || !name || !levels.some(level => level.id === levelId)) return res.status(400).json({ error: '資料不完整' });
  const scores = readJson(SCORES_PATH, {});
  const entry = scores[visitorId] || { name: String(name).slice(0, 20), cleared: [] };
  entry.name = String(name).slice(0, 20);
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
    code: room.code, name: room.name, status: room.status, hostId: room.hostId,
    // Do not reveal the region arrangement to waiting players or spectators.
    puzzle: room.status === 'lobby'
      ? { id: room.puzzle.id, name: room.puzzle.name, size: room.puzzle.size }
      : publicLevel(room.puzzle),
    players: [...room.players.values()].map(player => ({
      id: player.id, name: player.name, spectator: player.spectator, alive: player.alive,
      found: player.found.size, completedAt: player.completedAt
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

io.on('connection', socket => {
  socket.on('create-room', ({ name, playerId, roomName, levelId, size }, callback) => {
    const puzzle = levelId ? levels.find(level => level.id === levelId) : generatePuzzle(size || 5);
    if (!puzzle) return callback({ error: '找不到關卡' });
    const code = nanoid(5).toUpperCase();
    const room = { code, name: String(roomName || '一起玩 MeowDoku').slice(0, 40), puzzle, status: 'lobby', hostId: playerId,
      players: new Map(), startedAt: null, deadline: null, timer: null };
    rooms.set(code, room); joinRoom(socket, room, { name, playerId, spectator: false }); callback({ code });
  });
  socket.on('join-room', ({ code, name, playerId, spectator }, callback) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return callback({ error: '房間不存在或已關閉' });
    if (room.status === 'finished') return callback({ error: '這局已結束' });
    joinRoom(socket, room, { name, playerId, spectator: Boolean(spectator) }); callback({ ok: true });
  });
  socket.on('start-game', ({ code, playerId }, callback) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== playerId) return callback?.({ error: '只有房主可以開始' });
    if (room.status !== 'lobby') return callback?.({ error: '遊戲已開始' });
    if (![...room.players.values()].some(player => !player.spectator)) return callback?.({ error: '至少需要一位玩家' });
    room.status = 'playing'; room.startedAt = Date.now(); emitRoom(room); callback?.({ ok: true });
  });
  socket.on('guess', ({ code, playerId, row, col }, callback) => {
    const room = rooms.get(code), player = room?.players.get(playerId);
    if (!room || !player || room.status !== 'playing' || player.spectator || !player.alive) return;
    const hit = room.puzzle.solution.some(cat => cat.row === row && cat.col === col);
    if (!hit) { player.alive = false; socket.emit('guess-result', { row, col, hit: false }); emitRoom(room); return; }
    player.found.add(`${row}:${col}`); socket.emit('guess-result', { row, col, hit: true });
    if (player.found.size === room.puzzle.size) {
      player.completedAt = Date.now();
      if (!room.deadline) {
        room.deadline = Date.now() + 60_000;
        room.timer = setTimeout(() => finishRoom(room), 60_000);
        io.to(room.code).emit('final-sprint', { deadline: room.deadline });
      }
    }
    emitRoom(room);
  });
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const removed = [...room.players.values()].find(player => player.socketId === socket.id);
      if (!removed) continue;
      room.players.delete(removed.id);
      if (removed.id === room.hostId) room.hostId = [...room.players.values()].find(player => !player.spectator)?.id || [...room.players.keys()][0];
      if (!room.players.size) { clearTimeout(room.timer); rooms.delete(room.code); } else emitRoom(room);
      break;
    }
  });
});
function joinRoom(socket, room, { name, playerId, spectator }) {
  for (const existing of room.players.values()) if (existing.id === playerId) room.players.delete(existing.id);
  const player = { id: playerId, name: String(name || '神秘貓奴').slice(0, 20), spectator, socketId: socket.id, alive: true, found: new Set(), completedAt: null };
  room.players.set(playerId, player); socket.join(room.code); emitRoom(room);
}

server.listen(PORT, () => console.log(`MeowDoku is ready at http://localhost:${PORT}`));
