const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generatePuzzle, formatBoardText, validateBoardText } = require('../puzzle');
const { stopWorker } = require('../generator');

// Same isolation trick as auth.test.js: the server binds its data directory at
// require time, so a throwaway one is created first.
process.env.MEOWDOKU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meowdoku-admin-'));
delete process.env.ADMIN_BOOTSTRAP_USER;
// Scores far below anything the rater hands out, so levels published during
// the tests always sort after these three.
const LEVELS = ['A', 'B', 'C'].map((name, index) => ({ id: `lvl-${name}`, name: `關 ${name}`, createdAt: index + 1, ...generatePuzzle(4), rating: { score: index + 1, stars: 1, hardestName: '測試' } }));
fs.writeFileSync(path.join(process.env.MEOWDOKU_DATA_DIR, 'levels.json'), JSON.stringify(LEVELS));
const { server, io, auth: serverAuth, db: serverDb, rooms } = require('../server');

const PASSWORD = 'tuna-sashimi-42';
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
  await stopWorker();
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
async function adminCookie(username) {
  const { cookie } = await signUp(username);
  assert.equal(serverAuth.bootstrapAdmin(username), true);
  return cookie;
}
const levelIds = async () => (await call('GET', '/api/levels')).data.map(level => level.id);
const complete = (cookie, levelId) => call('POST', '/api/single-complete', { body: { name: 'P', levelId }, cookie });

const ADMIN_ROUTES = [
  ['POST', '/api/admin/levels', { size: 5 }],
  ['POST', '/api/admin/levels/validate', { text: 'x' }],
  ['POST', '/api/admin/levels/import', { text: 'x' }],
  ['PUT', '/api/admin/levels/order', { ids: [] }]
];

test('every admin endpoint rejects guests (401) and ordinary accounts (403)', async () => {
  const guest = await call('GET', '/api/auth/me');
  const { cookie } = await signUp('ordinary_user');
  for (const [method, route, body] of ADMIN_ROUTES) {
    assert.equal((await call(method, route, { body })).status, 401, `${route} without cookie`);
    assert.equal((await call(method, route, { body, cookie: guest.cookie })).status, 401, `${route} as guest`);
    assert.equal((await call(method, route, { body, cookie })).status, 403, `${route} as user`);
  }
  assert.deepEqual(await levelIds(), LEVELS.map(level => level.id), 'nothing was published or reordered');
});

// Regions 5 × 5 with region 1 split in two pieces and region 3 absent; the
// answer puts adjacent cats in rows 1–2 and 3–4 and two cats in region 1.
const BROKEN = ['1 1 2 2 2', '4 4 2 5 5', '4 1 2 5 5', '4 4 4 5 5', '1 1 1 5 5', '1 2 4 5 3'].join('\n');

test('validateBoardText lists every problem with its row/cell instead of the first one', () => {
  const { errors, puzzle } = validateBoardText(BROKEN);
  assert.equal(puzzle, null);
  assert.ok(errors.length >= 4, errors.join('\n'));
  assert.ok(errors.some(error => error.includes('缺少區域 3')), 'missing region');
  assert.ok(errors.some(error => error.includes('區域 1') && error.includes('連通') && error.includes('第 3 行第 2 格')), 'disconnected region with cell');
  assert.ok(errors.some(error => error.includes('相鄰') && error.includes('第 1 行第 1 格與第 2 行第 2 格')), 'adjacent cats name both cells');
  assert.ok(errors.some(error => error.includes('相鄰') && error.includes('第 3 行第 4 格與第 4 行第 5 格')), 'every adjacent pair is listed');
  assert.ok(errors.some(error => error.includes('各放一隻貓') && error.includes('區域 1 有 2 隻（第 1、5 行）') && error.includes('區域 2 沒有貓')), 'region cat counts');
  const duplicate = validateBoardText(['1 1 2 2 2', '4 4 2 5 5', '4 4 2 5 5', '4 4 3 5 5', '1 1 3 3 3', '1 2 4 4 1'].join('\n'));
  assert.ok(duplicate.errors.some(error => error.includes('不重複排列') && error.includes('第 1、5 行的貓都在第 1 列') && error.includes('第 3、4 行的貓都在第 4 列')), duplicate.errors.join('\n'));
  const short = validateBoardText('1 1 2\n2 2 2 2\n1 2 x 3\n3 1 2 3\n1 3 2 4 1');
  assert.ok(short.errors.some(error => error.startsWith('第 1 行必須有 4 個數值（目前 3 個）')), short.errors.join('\n'));
  assert.ok(short.errors.some(error => error.startsWith('第 3 行包含無效的整數')));
  assert.ok(short.errors.some(error => error.startsWith('第 5 行必須有 4 個數值（目前 5 個）')));
});

test('dry-run validation reports all errors, publishes nothing; import needs a clean board', async () => {
  const cookie = await adminCookie('admin_one');
  const before = await levelIds();
  const dry = await call('POST', '/api/admin/levels/validate', { body: { text: BROKEN }, cookie });
  assert.equal(dry.status, 400); assert.equal(dry.data.ok, false);
  assert.ok(dry.data.errors.length >= 4, JSON.stringify(dry.data.errors));
  assert.equal(dry.data.error, dry.data.errors[0]);
  const rejected = await call('POST', '/api/admin/levels/import', { body: { text: BROKEN }, cookie });
  assert.equal(rejected.status, 400); assert.equal(rejected.data.errors.length, dry.data.errors.length);
  const good = formatBoardText(generatePuzzle(5));
  const mismatch = await call('POST', '/api/admin/levels/validate', { body: { text: good, size: 6 }, cookie });
  assert.equal(mismatch.status, 400); assert.match(mismatch.data.errors[0], /尺寸不符/);
  const ok = await call('POST', '/api/admin/levels/validate', { body: { text: good, size: 5 }, cookie });
  assert.equal(ok.status, 200); assert.equal(ok.data.ok, true); assert.equal(ok.data.size, 5);
  assert.ok(ok.data.rating && typeof ok.data.rating.score === 'number'); assert.equal(ok.data.rating.solution, undefined);
  assert.equal(ok.data.solution.length, 5, 'admins get the answer for the preview');
  assert.deepEqual(await levelIds(), before, 'validate never publishes');
  const imported = await call('POST', '/api/admin/levels/import', { body: { text: good, size: 5, name: '手繪' }, cookie });
  assert.equal(imported.status, 201); assert.equal(imported.data.name, '手繪');
  assert.equal(imported.data.solution.length, 5);
  const listed = (await call('GET', '/api/levels')).data.find(level => level.id === imported.data.id);
  assert.equal(listed.solution, undefined, 'the public catalogue still hides answers');
  assert.equal((await levelIds()).length, before.length + 1);
});

test('generated level: size and name honoured, rating and board returned', async () => {
  const cookie = await adminCookie('admin_two');
  const made = await call('POST', '/api/admin/levels', { body: { size: 4, name: '午後曬太陽' }, cookie });
  assert.equal(made.status, 201); assert.equal(made.data.size, 4); assert.equal(made.data.name, '午後曬太陽');
  assert.equal(made.data.regions.length, 16); assert.ok(made.data.rating.stars >= 1); assert.equal(made.data.solution.length, 4);
});

test('reordering persists, is validated, and keeps unlock rules intact', async () => {
  const dataDir = process.env.MEOWDOKU_DATA_DIR;
  const cookie = await adminCookie('admin_three');
  const ids = await levelIds();
  assert.deepEqual(ids.slice(0, 3), ['lvl-A', 'lvl-B', 'lvl-C']);
  for (const bad of [ids.slice(1), [...ids, ids[0]], [...ids.slice(0, -1), 'nope'], 'lvl-A']) {
    assert.equal((await call('PUT', '/api/admin/levels/order', { body: { ids: bad }, cookie })).status, 400);
  }
  assert.deepEqual(await levelIds(), ids, 'rejected orders change nothing');

  const player = await signUp('climber');
  assert.equal((await complete(player.cookie, 'lvl-B')).status, 403, 'B is locked behind A');
  assert.equal((await complete(player.cookie, 'lvl-A')).status, 200);
  assert.equal((await complete(player.cookie, 'lvl-B')).status, 200);

  // C moves to the front: the player has cleared A and B but never C.
  const reordered = ['lvl-C', 'lvl-A', 'lvl-B', ...ids.slice(3)];
  const saved = await call('PUT', '/api/admin/levels/order', { body: { ids: reordered }, cookie });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.map(level => level.id), reordered);
  assert.deepEqual(await levelIds(), reordered);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'level-order.json'), 'utf8')), reordered);
  assert.equal((await complete(player.cookie, 'lvl-A')).status, 200, 'cleared levels stay replayable');
  assert.equal((await complete(player.cookie, 'lvl-B')).status, 200, 'cleared levels stay replayable');
  assert.equal((await complete(player.cookie, 'lvl-C')).status, 200, 'first level is always open');
  const rookie = await signUp('rookie');
  assert.equal((await complete(rookie.cookie, 'lvl-A')).status, 403, 'a newcomer must clear C first');
  assert.equal((await complete(rookie.cookie, 'lvl-C')).status, 200);
  assert.equal((await complete(rookie.cookie, 'lvl-A')).status, 200);

  // A brand-new level inserted between cleared rungs must not wall anyone off.
  const fresh = await call('POST', '/api/admin/levels', { body: { size: 4, name: '插隊' }, cookie });
  const withFresh = ['lvl-C', 'lvl-A', fresh.data.id, 'lvl-B', ...ids.slice(3)];
  assert.equal((await call('PUT', '/api/admin/levels/order', { body: { ids: withFresh }, cookie })).status, 200);
  assert.equal((await complete(player.cookie, 'lvl-B')).status, 200, 'already cleared B stays open without the new level');
  assert.equal((await complete(player.cookie, fresh.data.id)).status, 200, 'the new level is reachable from cleared A');
  assert.equal((await complete(rookie.cookie, 'lvl-B')).status, 403, 'rookie still needs the new level first');
  assert.equal((await complete(rookie.cookie, fresh.data.id)).status, 200);
  assert.equal((await complete(rookie.cookie, 'lvl-B')).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'level-order.json'), 'utf8')), withFresh);
});

test('leaderboard: top five with competition ranks, own rank from the server, guests get none', async () => {
  const cookie = await adminCookie('admin_four');
  // Enough levels for distinct scores, all unlocked in order by each player.
  while ((await levelIds()).length < 8) await call('POST', '/api/admin/levels', { body: { size: 4 }, cookie });
  const order = await levelIds();
  const clearN = async (playerCookie, n) => { for (const id of order.slice(0, n)) assert.equal((await complete(playerCookie, id)).status, 200); };
  const players = {};
  for (const [name, n] of [['p7', 7], ['p6a', 6], ['p6b', 6], ['p4', 4], ['p3', 3], ['p2', 2], ['p1', 1]]) {
    players[name] = await signUp(`rank_${name}`); await clearN(players[name].cookie, n);
  }
  // Two players from the reorder test also sit at four clears, so the board
  // reads 7, 6, 6, 4, 4, 4, 3, 2, 1.
  const guest = await call('GET', '/api/leaderboard');
  assert.equal(guest.data.top.length, 5); assert.equal(guest.data.me, null);
  assert.equal(guest.data.total, 9);
  assert.deepEqual(guest.data.top.map(row => row.cleared), [7, 6, 6, 4, 4]);
  assert.deepEqual(guest.data.top.map(row => row.rank), [1, 2, 2, 4, 4], 'ties share a rank and the next rank skips');
  assert.ok(guest.data.top.every(row => row.me === false));
  const guestCookie = (await call('GET', '/api/auth/me')).cookie;
  assert.equal((await call('GET', '/api/leaderboard', { cookie: guestCookie })).data.me, null, 'guests are not ranked');

  const inTop = await call('GET', '/api/leaderboard', { cookie: players.p6b.cookie });
  assert.equal(inTop.data.me.inTop, true); assert.equal(inTop.data.me.rank, 2);
  assert.equal(inTop.data.top.filter(row => row.me).length, 1);

  const below = await call('GET', '/api/leaderboard', { cookie: players.p1.cookie });
  assert.equal(below.data.me.inTop, false); assert.equal(below.data.me.cleared, 1);
  assert.deepEqual([below.data.me.rank, below.data.me.total], [9, 9]);
  assert.ok(below.data.top.every(row => row.me === false));
  const tied = await call('GET', '/api/leaderboard', { cookie: players.p3.cookie });
  assert.equal(tied.data.me.rank, 7, 'sixth place is a tie at 4, so 3 clears rank seventh');
  // An account with nothing cleared is not on the board yet but still gets a
  // rank, counted as one more participant.
  const nothing = await call('GET', '/api/leaderboard', { cookie });
  assert.deepEqual([nothing.data.me.rank, nothing.data.me.total, nothing.data.me.cleared, nothing.data.me.inTop], [10, 10, 0, false]);
});
