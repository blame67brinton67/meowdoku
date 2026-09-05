const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');

process.env.MEOWDOKU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meowdoku-room-test-'));
const { server, io, rooms, compactRoom, db } = require('../server');
const { stopWorker } = require('../generator');

let url;
const clients = new Set();
test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  for (const client of clients) client.disconnect();
  io.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const current of rooms.values()) {
    for (const timer of [current.timer, current.countdownTimer, current.broadcastTimer, current.spectatorTimer]) clearTimeout(timer);
    for (const player of current.players.values()) clearTimeout(player.idleTimer);
  }
  await stopWorker();
  db.close();
  fs.rmSync(process.env.MEOWDOKU_DATA_DIR, { recursive: true, force: true });
});

// Identity rides on the session cookie; passing an existing client's cookie
// reconnects as that same seat, otherwise a fresh guest is minted.
async function client(cookie) {
  const response = await fetch(`${url}/api/auth/me`, { headers: cookie ? { cookie } : {} });
  cookie = cookie || (response.headers.get('set-cookie') || '').split(';')[0];
  const me = await response.json();
  const socket = connect(url, { forceNew: true, transports: ['websocket'], extraHeaders: { cookie } });
  clients.add(socket);
  socket.cookie = cookie; socket.playerId = (me.user || me.guest).id;
  return new Promise((resolve, reject) => { socket.on('connect', () => resolve(socket)); socket.on('connect_error', reject); });
}
const emit = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));
const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const room = code => rooms.get(code);

async function makeRoom(names, { size = 4 } = {}) {
  const sockets = [];
  const host = await client();
  const { code } = await emit(host, 'create-room', { name: names[0], size });
  sockets.push(host);
  for (let i = 1; i < names.length; i++) {
    const socket = await client();
    const result = await emit(socket, 'join-room', { code, name: names[i] });
    assert.equal(result.ok, true);
    sockets.push(socket);
  }
  return { code, sockets, ids: sockets.map(socket => socket.playerId) };
}
async function startMatch(code, hostSocket, hostId) {
  const started = once(hostSocket, 'match-started');
  const result = await emit(hostSocket, 'start-game', { code });
  assert.equal(result.ok, true);
  // Countdown is fixed at 3 s; the timer is fired early to keep the suite quick.
  const current = room(code);
  clearTimeout(current.countdownTimer);
  current.countdownTimer = null; current.status = 'playing'; current.startedAt = Date.now(); current.countdownEnds = null;
  io.to(code).emit('match-started');
  await started;
}
async function solve(code, socket, playerId, { pause = 0 } = {}) {
  const solution = room(code).puzzle.solution;
  for (const cat of solution) {
    socket.emit('guess', { code, playerId, row: cat.row, col: cat.col });
    await once(socket, 'guess-result');
  }
  if (pause) await sleep(pause);
}
async function eliminate(code, socket, playerId) {
  const { puzzle } = room(code);
  const miss = [...Array(puzzle.size * puzzle.size).keys()].map(i => ({ row: Math.floor(i / puzzle.size), col: i % puzzle.size }))
    .find(cell => !puzzle.solution.some(cat => cat.row === cell.row && cat.col === cell.col));
  socket.emit('guess', { code, playerId, ...miss });
  await once(socket, 'guess-result');
}
const finished = socket => once(socket, 'game-finished');
const stat = (code, playerId) => room(code).stats.get(playerId);

test('only the host, identified by socket, can kick', async () => {
  const { code, sockets: [host, guest], ids: [hostId, guestId] } = await makeRoom(['host', 'guest']);
  const forged = await emit(guest, 'kick-player', { code, targetId: hostId });
  assert.match(forged.error, /房主/);
  assert.equal(room(code).players.size, 2);
  const self = await emit(host, 'kick-player', { code, targetId: hostId });
  assert.match(self.error, /自己/);
  const outsider = await client();
  const stranger = await emit(outsider, 'kick-player', { code, targetId: guestId });
  assert.match(stranger.error, /房主/);
  assert.equal(room(code).players.size, 2);
});

test('kicked player is told, removed and cannot rejoin until unblocked', async () => {
  const { code, sockets: [host, guest], ids: [, guestId] } = await makeRoom(['host', 'guest']);
  const kicked = once(guest, 'kicked');
  const result = await emit(host, 'kick-player', { code, targetId: guestId });
  assert.equal(result.ok, true);
  assert.match((await kicked).reason, /移出/);
  assert.equal(room(code).players.has(guestId), false);
  const again = await client(guest.cookie);
  const rejoin = await emit(again, 'join-room', { code, name: 'guest' });
  assert.match(rejoin.error, /移出/);
  const resume = await emit(again, 'resume-room', { code, name: 'guest' });
  assert.match(resume.error, /移出/);
  const unblockForged = await emit(again, 'unblock-player', { code, targetId: guestId });
  assert.match(unblockForged.error, /房主/);
  const unblock = await emit(host, 'unblock-player', { code, targetId: guestId });
  assert.equal(unblock.ok, true);
  const back = await emit(again, 'join-room', { code, name: 'guest' });
  assert.equal(back.ok, true);
});

test('kicking the last living racer ends the round', async () => {
  const { code, sockets: [host, guest], ids: [hostId, guestId] } = await makeRoom(['host', 'guest']);
  await startMatch(code, host, hostId);
  await eliminate(code, host, hostId);
  assert.equal(room(code).status, 'playing');
  const done = finished(host);
  await emit(host, 'kick-player', { code, targetId: guestId });
  await done;
  assert.equal(room(code).status, 'finished');
  assert.equal(room(code).players.has(guestId), false);
});

test('points: 3 racers with one unfinished score 3 / 2 / 0', async () => {
  const { code, sockets: [a, b, c], ids: [aId, bId, cId] } = await makeRoom(['a', 'b', 'c']);
  await startMatch(code, a, aId);
  const done = finished(a);
  await solve(code, a, aId, { pause: 5 });
  await solve(code, b, bId);
  await eliminate(code, c, cId);
  await done;
  assert.equal(stat(code, aId).points, 3);
  assert.equal(stat(code, bId).points, 2);
  assert.equal(stat(code, cId).points, 0);
  assert.equal(stat(code, cId).played, 1);
  assert.equal(stat(code, cId).completed, 0);
  const rows = [...room(code).stats.values()];
  assert.ok(rows.every(row => typeof row.totalMs === 'number'));
});

test('win streak accumulates and breaks; restart keeps totals', async () => {
  const { code, sockets: [a, b], ids: [aId, bId] } = await makeRoom(['a', 'b']);
  const play = async (winner, winnerId, loser, loserId) => {
    await startMatch(code, a, aId);
    const done = finished(a);
    await solve(code, winner, winnerId, { pause: 5 });
    await solve(code, loser, loserId);
    await done;
    assert.equal((await emit(a, 'restart-room', { code })).ok, true);
  };
  await play(a, aId, b, bId);
  await play(a, aId, b, bId);
  assert.equal(stat(code, aId).streak, 2);
  assert.equal(stat(code, aId).points, 4);
  await play(b, bId, a, aId);
  assert.equal(stat(code, aId).streak, 0);
  assert.equal(stat(code, aId).bestStreak, 2);
  assert.equal(stat(code, bId).streak, 1);
  assert.equal(stat(code, aId).points, 5);
  assert.equal(stat(code, bId).points, 4);
  assert.equal(room(code).round, 4);
});

test('restart while playing voids the round and clears timers', async () => {
  const { code, sockets: [a, b], ids: [aId, bId] } = await makeRoom(['a', 'b']);
  await startMatch(code, a, aId);
  await solve(code, a, aId);
  assert.ok(room(code).timer, 'final sprint timer running');
  assert.equal(room(code).leaderboard.length, 1);
  const notice = once(b, 'room-restarted');
  const result = await emit(a, 'restart-room', { code });
  assert.equal(result.ok, true);
  assert.match((await notice).message, /重開/);
  const current = room(code);
  assert.equal(current.status, 'lobby');
  assert.equal(current.timer, null);
  assert.equal(current.countdownTimer, null);
  assert.equal(current.deadline, null);
  assert.equal(current.leaderboard.length, 0);
  assert.equal(current.stats.size, 0);
  assert.equal(current.players.get(aId).found.size, 0);
  assert.equal(current.round, 2);
});

test('restart during countdown and lobby; guest cannot restart', async () => {
  const { code, sockets: [a, b], ids: [aId] } = await makeRoom(['a', 'b']);
  assert.match((await emit(b, 'restart-room', { code })).error, /房主/);
  const before = room(code).puzzle;
  assert.equal((await emit(a, 'restart-room', { code })).ok, true);
  assert.notEqual(room(code).puzzle, before);
  assert.equal((await emit(a, 'start-game', { code })).ok, true);
  assert.equal(room(code).status, 'countdown');
  assert.equal((await emit(a, 'restart-room', { code })).ok, true);
  assert.equal(room(code).status, 'lobby');
  assert.equal(room(code).countdownTimer, null);
});

test('double-click restart generates only one puzzle', async () => {
  const { code, sockets: [a], ids: [aId] } = await makeRoom(['a']);
  const [first, second] = await Promise.all([emit(a, 'restart-room', { code }), emit(a, 'restart-room', { code })]);
  assert.equal(first.ok, true);
  assert.match(second.error, /稍候/);
  assert.equal(room(code).round, 2);
  assert.equal(room(code).restartPending, false);
});

test('host handover carries kick rights', async () => {
  const { code, sockets: [a, b, c], ids: [aId, bId, cId] } = await makeRoom(['a', 'b', 'c']);
  await emit(a, 'leave-room', { code });
  assert.equal(room(code).hostId, bId);
  assert.match((await emit(c, 'kick-player', { code, targetId: bId })).error, /房主/);
  assert.equal((await emit(b, 'kick-player', { code, targetId: cId })).ok, true);
  assert.equal(room(code).players.size, 1);
});

test('room settings: host only, lobby only, size clamped, failure leaves state intact', async () => {
  const { code, sockets: [a, b], ids: [aId] } = await makeRoom(['a', 'b']);
  assert.match((await emit(b, 'update-room-settings', { code, visibility: 'private' })).error, /房主/);
  assert.equal(room(code).visibility, 'public');
  assert.match((await emit(a, 'update-room-settings', { code, visibility: 'hidden' })).error, /類型/);
  assert.match((await emit(a, 'update-room-settings', { code, size: 'abc' })).error, /大小/);
  assert.equal(room(code).puzzle.size, 4);
  assert.equal((await emit(a, 'update-room-settings', { code, visibility: 'private' })).ok, true);
  assert.equal(room(code).visibility, 'private');
  const publicRooms = await fetch(`${url}/api/public-rooms`).then(r => r.json());
  assert.equal(publicRooms.some(r => r.code === code), false);
  const notice = once(b, 'room-restarted');
  assert.equal((await emit(a, 'update-room-settings', { code, size: 99 })).ok, true);
  assert.equal(room(code).puzzle.size, 12);
  assert.match((await notice).message, /12 × 12/);
  assert.equal((await emit(a, 'update-room-settings', { code, size: 1 })).ok, true);
  assert.equal(room(code).puzzle.size, 4);
  await startMatch(code, a, aId);
  assert.match((await emit(a, 'update-room-settings', { code, visibility: 'public' })).error, /倒數/);
  assert.equal(room(code).visibility, 'private');
});

test('room password gates joining and never leaves the server', async () => {
  const { code, sockets: [a], ids: [aId] } = await makeRoom(['a']);
  assert.match((await emit(a, 'update-room-settings', { code, password: '   ' })).error, /空白/);
  assert.match((await emit(a, 'update-room-settings', { code, password: 'x'.repeat(33) })).error, /32/);
  assert.match((await emit(a, 'update-room-settings', { code, password: 123 })).error, /文字/);
  assert.equal(room(code).password, null);
  const state = once(a, 'room-state');
  assert.equal((await emit(a, 'update-room-settings', { code, password: '  meow-secret  ' })).ok, true);
  const payload = JSON.stringify(await state);
  assert.ok(payload.includes('"hasPassword":true'));
  assert.equal(payload.includes('meow-secret'), false);
  assert.equal(payload.includes(room(code).password.hash.toString('base64')), false);
  assert.equal(payload.includes(room(code).password.hash.toString('hex')), false);
  assert.equal(payload.includes('"password"'), false);
  const listing = JSON.stringify(await fetch(`${url}/api/public-rooms`).then(r => r.json()));
  assert.ok(listing.includes('"hasPassword":true'));
  assert.equal(listing.includes('meow-secret'), false);
  assert.equal(listing.includes(room(code).password.hash.toString('hex')), false);
  assert.equal(listing.includes(room(code).password.hash.toString('base64')), false);
  const guest = await client();
  const missing = await emit(guest, 'join-room', { code, name: 'g' });
  assert.equal(missing.needsPassword, true);
  assert.match(missing.error, /需要密碼/);
  const wrong = await emit(guest, 'join-room', { code, name: 'g', password: 'nope' });
  assert.match(wrong.error, /不正確/);
  const throttled = await emit(guest, 'join-room', { code, name: 'g', password: 'meow-secret' });
  assert.match(throttled.error, /稍後/);
  assert.equal(room(code).players.has(guest.playerId), false);
  const fresh = await client(guest.cookie);
  const right = await emit(fresh, 'join-room', { code, name: 'g', password: 'meow-secret' });
  assert.equal(right.ok, true);
  // A seat already inside the room reconnects without the password.
  fresh.disconnect();
  const back = await client(guest.cookie);
  assert.equal((await emit(back, 'resume-room', { code, name: 'g' })).ok, true);
  const lost = await client();
  assert.equal((await emit(lost, 'resume-room', { code, name: 'z' })).needsPassword, true);
  assert.equal((await emit(a, 'update-room-settings', { code, clearPassword: true })).ok, true);
  assert.equal(room(code).password, null);
  const open = await client();
  assert.equal((await emit(open, 'join-room', { code, name: 'o' })).ok, true);
  void aId;
});

test('eliminated player receives the answer in the room payload while others still play', async () => {
  const { code, sockets: [host, guest], ids: [hostId, guestId] } = await makeRoom(['host', 'guest']);
  await startMatch(code, host, hostId);
  const state = once(guest, 'room-state');
  await eliminate(code, guest, guestId);
  const payload = await state;
  assert.equal(payload.status, 'playing');
  assert.equal(payload.players.find(p => p.id === guestId).alive, false);
  assert.ok(Array.isArray(payload.puzzle.regions));
  assert.deepEqual(payload.puzzle.solution, room(code).puzzle.solution);
  assert.doesNotMatch(JSON.stringify(compactRoom({ ...room(code), status: 'lobby' })), /solution|regions/);
});

test('roles can change once everyone is done, never mid-round, without touching points', async () => {
  const { code, sockets: [host, guest, third], ids: [hostId, guestId, thirdId] } = await makeRoom(['host', 'guest', 'third']);
  await startMatch(code, host, hostId);
  await eliminate(code, guest, guestId);
  const midRound = await emit(guest, 'set-lobby-role', { code, spectator: true });
  assert.match(midRound.error, /結束後/);
  assert.equal(room(code).players.get(guestId).spectator, false);
  const done = finished(host);
  await solve(code, host, hostId);
  await solve(code, third, thirdId);
  await done;
  assert.equal(room(code).status, 'finished');
  assert.equal(stat(code, hostId).points, 3);
  assert.equal(stat(code, thirdId).points, 2);
  assert.equal(stat(code, guestId).points, 0);
  assert.equal((await emit(host, 'set-lobby-role', { code, spectator: true })).ok, true);
  assert.equal((await emit(guest, 'set-lobby-role', { code, spectator: true })).ok, true);
  assert.equal((await emit(guest, 'set-lobby-role', { code, spectator: false })).ok, true);
  assert.equal(room(code).status, 'finished');
  assert.equal(stat(code, hostId).points, 3);
  assert.equal(stat(code, hostId).played, 1);
  assert.equal(stat(code, guestId).points, 0);
  assert.equal(stat(code, guestId).played, 1);
  assert.equal((await emit(host, 'restart-room', { code })).ok, true);
  await startMatch(code, host, hostId);
  const next = finished(guest);
  await solve(code, guest, guestId);
  await solve(code, third, thirdId);
  await next;
  assert.equal(stat(code, hostId).points, 3);
  assert.equal(stat(code, hostId).played, 1);
  assert.equal(stat(code, guestId).points, 2);
  assert.equal(stat(code, thirdId).points, 3);
});
