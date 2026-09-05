const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: connect } = require('socket.io-client');
const { openDb } = require('../db');
const { generatePuzzle } = require('../puzzle');
const { createAuth, hashPassword, verifyPassword, hashToken, validatePassword, validateUsername, LOGIN_FAILED, SESSION_TTL, SESSION_RENEW_BELOW, LOGIN_MAX_FAILURES, LOGIN_WINDOW } = require('../auth');

// The server reads its data directory once at require time, so an empty one
// is pointed at before it loads and nothing from a real install is touched.
process.env.MEOWDOKU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meowdoku-auth-'));
delete process.env.ADMIN_BOOTSTRAP_USER;
// A ready-made level keeps rooms off the puzzle worker, which has no shutdown.
const LEVEL = { id: 'lvl-test', name: '測試關', createdAt: 1, ...generatePuzzle(4) };
fs.writeFileSync(path.join(process.env.MEOWDOKU_DATA_DIR, 'levels.json'), JSON.stringify([LEVEL]));
const { server, io, auth: serverAuth, db: serverDb, rooms } = require('../server');

const PASSWORD = 'tuna-sashimi-42';
const clock = () => { let t = 1_000_000; return { now: () => t, tick: ms => { t += ms; } }; };
const memoryAuth = () => { const time = clock(); return { auth: createAuth(openDb(), { now: time.now }), time }; };

test('scrypt hashes verify only with the same password', async () => {
  const { hash, salt } = await hashPassword(PASSWORD);
  assert.equal(salt.length, 16); assert.equal(hash.length, 64);
  assert.equal(await verifyPassword(PASSWORD, hash, salt), true);
  assert.equal(await verifyPassword('tuna-sashimi-43', hash, salt), false);
  assert.equal(await verifyPassword('', hash, salt), false);
  const again = await hashPassword(PASSWORD);
  assert.notDeepEqual(again.salt, salt);
});

test('registration rules: username shape and weak passwords', () => {
  assert.ok(validateUsername('ab'));
  assert.ok(validateUsername('a'.repeat(21)));
  assert.ok(validateUsername('貓咪'));
  assert.ok(validateUsername('has space'));
  assert.equal(validateUsername('Cat_Nap-01'), null);
  assert.ok(validatePassword('short'));
  assert.ok(validatePassword('x'.repeat(73)));
  for (const weak of ['password', '12345678', 'meowdoku', 'PASSWORD', 'qwertyuiop', 'aaaaaaaa', 'abcdefgh']) assert.ok(validatePassword(weak), weak);
  assert.equal(validatePassword(PASSWORD), null);
});

test('login: wrong password and unknown account share one message', async () => {
  const { auth } = memoryAuth();
  const registered = await auth.register({ username: 'Mochi', password: PASSWORD });
  assert.equal(registered.user.username, 'Mochi');
  assert.equal((await auth.register({ username: 'mochi', password: PASSWORD })).error, '這個帳號已經有人用了');
  const wrong = await auth.login({ username: 'mochi', password: 'not-the-password', ip: '10.0.0.1' });
  const missing = await auth.login({ username: 'nobody-here', password: PASSWORD, ip: '10.0.0.1' });
  assert.equal(wrong.error, LOGIN_FAILED); assert.equal(missing.error, LOGIN_FAILED);
  assert.deepEqual(Object.keys(wrong), Object.keys(missing));
  const ok = await auth.login({ username: 'MOCHI', password: PASSWORD, ip: '10.0.0.1' });
  assert.equal(ok.user.id, registered.user.id);
  assert.ok(ok.token);
});

test('sessions: only the hash is stored, expiry and logout invalidate, renewal rotates', async () => {
  const time = clock();
  const db = openDb(); const localAuth = createAuth(db, { now: time.now });
  const { token, user } = await localAuth.register({ username: 'sesame', password: PASSWORD });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(hashToken(token)).n, 1);
  assert.equal(localAuth.resolve(token).identity.id, user.id);
  assert.equal(localAuth.resolve(token + 'x'), null);
  assert.equal(localAuth.resolve(''), null);
  time.tick(SESSION_TTL - SESSION_RENEW_BELOW + 1);
  const renewed = localAuth.resolve(token);
  assert.ok(renewed.renewedToken && renewed.renewedToken !== token);
  assert.equal(localAuth.resolve(renewed.renewedToken).identity.id, user.id);
  time.tick(SESSION_TTL + 1);
  assert.equal(localAuth.resolve(renewed.renewedToken), null);
  const second = await localAuth.login({ username: 'sesame', password: PASSWORD, ip: '1.1.1.1' });
  localAuth.logout(second.token);
  assert.equal(localAuth.resolve(second.token), null);
});

test('login throttling: 10 failures per IP in 10 minutes cools down with 429 seconds', async () => {
  const { auth, time } = memoryAuth();
  await auth.register({ username: 'throttle', password: PASSWORD });
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) assert.equal((await auth.login({ username: 'throttle', password: 'nope-nope-nope', ip: '9.9.9.9' })).error, LOGIN_FAILED);
  const blocked = await auth.login({ username: 'throttle', password: PASSWORD, ip: '9.9.9.9' });
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= LOGIN_WINDOW / 1000);
  assert.equal((await auth.login({ username: 'throttle', password: PASSWORD, ip: '8.8.8.8' })).user.username, 'throttle');
  time.tick(LOGIN_WINDOW + 1);
  assert.equal((await auth.login({ username: 'throttle', password: PASSWORD, ip: '9.9.9.9' })).user.username, 'throttle');
});

test('claim-progress merges once and only once', async () => {
  const { auth } = memoryAuth();
  const { user } = await auth.register({ username: 'claimer', password: PASSWORD });
  auth.clearLevel(user.id, 'L1');
  assert.equal(auth.claimVisitor(user.id, 'visitor-1', { cleared: ['L1', 'L2'], history: [{ matchId: 'm1', finishedAt: 5 }] }), true);
  assert.deepEqual(auth.clearedLevels(user.id).sort(), ['L1', 'L2']);
  assert.equal(auth.matchHistory(user.id).length, 1);
  assert.equal(auth.claimVisitor(user.id, 'visitor-1', { cleared: ['L3'] }), false);
  const other = await auth.register({ username: 'thief', password: PASSWORD });
  assert.equal(auth.claimVisitor(other.user.id, 'visitor-1', { cleared: ['L3'] }), false);
  assert.deepEqual(auth.clearedLevels(other.user.id), []);
});

// --- HTTP + Socket.IO against the real server ---
let baseUrl;
test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  io.close();
  await new Promise(resolve => server.close(resolve));
  for (const room of rooms.values()) {
    for (const timer of [room.timer, room.countdownTimer, room.broadcastTimer, room.spectatorTimer]) clearTimeout(timer);
    for (const player of room.players.values()) clearTimeout(player.idleTimer);
  }
  serverDb.close();
});

const cookieOf = response => (response.headers.get('set-cookie') || '').split(';')[0];
async function call(method, route, { body, cookie } = {}) {
  const response = await fetch(baseUrl + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), cookie: cookieOf(response), raw: response.headers.get('set-cookie') || '' };
}
async function signUp(username) {
  const guest = await call('GET', '/api/auth/me');
  const created = await call('POST', '/api/auth/register', { body: { username, password: PASSWORD }, cookie: guest.cookie });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return { cookie: created.cookie, user: created.data.user, guestCookie: guest.cookie };
}

test('guests get an HttpOnly session cookie without Max-Age; users get 30 days', async () => {
  const guest = await call('GET', '/api/auth/me');
  assert.equal(guest.data.user, null); assert.match(guest.data.guest.id, /^g_/);
  assert.match(guest.raw, /HttpOnly/); assert.match(guest.raw, /SameSite=Lax/); assert.match(guest.raw, /Path=\//);
  assert.doesNotMatch(guest.raw, /Max-Age/);
  const again = await call('GET', '/api/auth/me', { cookie: guest.cookie });
  assert.equal(again.data.guest.id, guest.data.guest.id);
  const { cookie } = await signUp('cookie_user');
  const signedUp = await call('GET', '/api/auth/me', { cookie });
  assert.equal(signedUp.data.user.username, 'cookie_user');
});

test('register/login/logout over HTTP; logout kills the token; 429 carries Retry-After', async () => {
  const { cookie } = await signUp('http_user');
  assert.equal((await call('POST', '/api/auth/logout', { cookie })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie })).data.user, null);
  const login = await call('POST', '/api/auth/login', { body: { username: 'HTTP_USER', password: PASSWORD } });
  assert.equal(login.status, 200); assert.match(login.raw, /Max-Age=2592000/);
  const bad = await call('POST', '/api/auth/login', { body: { username: 'http_user', password: 'wrong-wrong-1' } });
  const missing = await call('POST', '/api/auth/login', { body: { username: 'ghost_user', password: 'wrong-wrong-1' } });
  assert.equal(bad.status, 401); assert.equal(missing.status, 401); assert.deepEqual(bad.data, missing.data);
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await call('POST', '/api/auth/login', { body: { username: 'ghost_user', password: 'wrong-wrong-1' } });
  const response = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'http_user', password: PASSWORD }) });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  serverDb.prepare('DELETE FROM login_attempts').run();
});

test('admin APIs reject guests and non-admins, allow bootstrapped admins', async () => {
  const guest = await call('GET', '/api/auth/me');
  assert.equal((await call('POST', '/api/admin/levels', { body: { size: 7 }, cookie: guest.cookie })).status, 401);
  assert.equal((await call('POST', '/api/admin/levels/import', { body: { text: 'x' } })).status, 401);
  const { cookie } = await signUp('plain_user');
  assert.equal((await call('POST', '/api/admin/levels', { body: { size: 7 }, cookie })).status, 403);
  assert.equal((await call('POST', '/api/admin/levels/import', { body: { text: 'x' }, cookie })).status, 403);
  assert.equal(serverAuth.bootstrapAdmin('nobody_registered'), false);
  assert.equal(serverAuth.bootstrapAdmin('plain_user'), true);
  assert.equal((await call('GET', '/api/auth/me', { cookie })).data.user.isAdmin, true);
  const imported = await call('POST', '/api/admin/levels/import', { body: { text: 'not a board' }, cookie });
  assert.equal(imported.status, 400);
});

test('claim-progress over HTTP needs a login and is one-shot', async () => {
  const guest = await call('GET', '/api/auth/me');
  assert.equal((await call('POST', '/api/auth/claim-progress', { body: { visitorId: 'legacy-1' }, cookie: guest.cookie })).status, 401);
  const { cookie } = await signUp('claim_user');
  assert.equal((await call('POST', '/api/auth/claim-progress', { body: { visitorId: '../etc' }, cookie })).status, 400);
  assert.equal((await call('POST', '/api/auth/claim-progress', { body: { visitorId: 'legacy-1' }, cookie })).status, 200);
  assert.equal((await call('POST', '/api/auth/claim-progress', { body: { visitorId: 'legacy-1' }, cookie })).status, 409);
});

test('single-complete uses the cookie identity, not the body', async () => {
  const levels = (await call('GET', '/api/levels')).data;
  assert.equal(levels[0].id, LEVEL.id);
  const { cookie, user } = await signUp('solo_user');
  const done = await call('POST', '/api/single-complete', { body: { visitorId: 'someone-else', name: 'Solo', levelId: levels[0].id }, cookie });
  assert.equal(done.status, 200);
  assert.deepEqual((await call('GET', '/api/progress/me', { cookie })).data.cleared, [levels[0].id]);
  assert.deepEqual((await call('GET', '/api/progress/someone-else')).data.cleared, []);
  assert.deepEqual(serverAuth.clearedLevels(user.id), [levels[0].id]);
});

const connectAs = cookie => new Promise((resolve, reject) => {
  const socket = connect(baseUrl, { forceNew: true, transports: ['websocket'], extraHeaders: cookie ? { cookie } : {} });
  socket.on('connect', () => resolve(socket)); socket.on('connect_error', reject);
});
const emit = (socket, event, payload) => new Promise(resolve => socket.emit(event, payload, resolve));

test('socket identity comes from the cookie and payload playerId is ignored', async () => {
  const host = await signUp('host_user'), rival = await signUp('rival_user');
  const hostSocket = await connectAs(host.cookie), rivalSocket = await connectAs(rival.cookie);
  const sockets = [hostSocket, rivalSocket];
  try {
    await assert.rejects(connectAs('meowdoku_sid=forged-token'));
    const { code } = await emit(hostSocket, 'create-room', { name: 'Host', playerId: 'spoofed', levelId: LEVEL.id, visibility: 'private' });
    assert.ok(code);
    const nextState = new Promise(resolve => hostSocket.once('room-state', resolve));
    await emit(rivalSocket, 'join-room', { code, name: 'Rival', playerId: host.user.id });
    const room = await nextState;
    assert.deepEqual(room.players.map(p => p.id).sort(), [host.user.id, rival.user.id].sort());
    assert.equal(room.hostId, host.user.id);
    const hijack = await emit(rivalSocket, 'start-game', { code, playerId: host.user.id });
    assert.equal(hijack.error, '只有房主可以開始');
    const sprint = await emit(rivalSocket, 'set-sprint-setting', { code, playerId: host.user.id, mode: 'fixed', value: 5 });
    assert.equal(sprint.error, '只有房主可以調整最後衝刺時間');
    const restart = await emit(rivalSocket, 'restart-room', { code, playerId: host.user.id });
    assert.equal(restart.error, '只有房主可以重新開始');
    const nextLine = new Promise(resolve => hostSocket.once('chat-message', resolve));
    const chat = await emit(rivalSocket, 'chat-message', { code, playerId: host.user.id, text: 'hi' });
    assert.equal(chat.ok, true);
    const line = await nextLine;
    assert.equal(line.playerId, rival.user.id);
    // Guests reconnect to the same seat because the id lives in the cookie.
    const guest = await call('GET', '/api/auth/me');
    const guestSocket = await connectAs(guest.cookie); sockets.push(guestSocket);
    await emit(guestSocket, 'join-room', { code, name: 'Guest', spectator: false });
    guestSocket.disconnect();
    const guestAgain = await connectAs(guest.cookie); sockets.push(guestAgain);
    const resumed = await emit(guestAgain, 'resume-room', { code, name: 'Guest', playerId: host.user.id });
    assert.deepEqual(resumed, { ok: true, spectator: false, movedToSpectator: false });
  } finally { for (const socket of sockets) socket.disconnect(); }
});
