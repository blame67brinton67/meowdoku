const crypto = require('crypto');
const { promisify } = require('util');
const { nanoid } = require('nanoid');

const scrypt = promisify(crypto.scrypt);
// Interactive-login cost: ~50 ms per hash, 16 MiB of memory.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16, KEY_BYTES = 64, TOKEN_BYTES = 32;
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY, SESSION_RENEW_BELOW = 25 * DAY;
// A rotated token keeps working for a moment so an in-flight request or a
// socket handshake that still carries it does not get bounced.
const ROTATED_GRACE = 60_000;
const GUEST_TTL = 7 * DAY;
const LOGIN_WINDOW = 10 * 60_000, LOGIN_MAX_FAILURES = 10;
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;
const PASSWORD_MIN = 1, PASSWORD_MAX = 72;
const USERNAME_HINT = '帳號需為 3–20 個英數字、底線或連字號';
const PASSWORD_HINT = '密碼需為 1–72 個字元';
const LOGIN_FAILED = '帳號或密碼不正確';
const DISPLAY_NAME_MAX = 20;
// Control, format and zero-width characters are dropped so a name is always
// visible text; length is counted in code points so emoji are not split.
const NAME_JUNK = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;
function sanitizeDisplayName(value) {
  return [...String(value ?? '').replace(NAME_JUNK, '').replace(/\s+/g, ' ').trim()].slice(0, DISPLAY_NAME_MAX).join('').trim();
}

function validateUsername(username) {
  return typeof username === 'string' && USERNAME.test(username) ? null : USERNAME_HINT;
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return PASSWORD_HINT;
  return null;
}

async function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES)) {
  const hash = await scrypt(Buffer.from(password, 'utf8'), salt, KEY_BYTES, SCRYPT);
  return { hash, salt };
}
async function verifyPassword(password, hash, salt) {
  const candidate = await scrypt(Buffer.from(String(password), 'utf8'), salt, KEY_BYTES, SCRYPT);
  return hash.length === candidate.length && crypto.timingSafeEqual(hash, candidate);
}

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

function readSettings(json) {
  if (!json) return null;
  try { const value = JSON.parse(json); return value && typeof value === 'object' ? value : null; } catch { return null; }
}
function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name || row.username, isAdmin: Boolean(row.is_admin), avatar: row.avatar, frame: row.frame, settings: readSettings(row.settings_json) };
}

function createAuth(db, { now = Date.now } = {}) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, username, password_hash, salt, created_at, display_name) VALUES (?, ?, ?, ?, ?, ?)'),
    setAdmin: db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?'),
    insertGuest: db.prepare('INSERT INTO guests (id, created_at, last_seen) VALUES (?, ?, ?)'),
    touchGuest: db.prepare('UPDATE guests SET last_seen = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, guest_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    expireSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteGuestSessions: db.prepare('DELETE FROM sessions WHERE guest_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    purgeGuests: db.prepare('DELETE FROM guests WHERE last_seen <= ? AND id NOT IN (SELECT guest_id FROM sessions WHERE guest_id IS NOT NULL)'),
    failures: db.prepare('SELECT COUNT(*) AS count, MIN(at) AS oldest FROM login_attempts WHERE ip = ? AND at > ?'),
    insertFailure: db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)'),
    clearFailures: db.prepare('DELETE FROM login_attempts WHERE ip = ?'),
    pruneFailures: db.prepare('DELETE FROM login_attempts WHERE at <= ?'),
    claimed: db.prepare('SELECT user_id FROM claimed_visitors WHERE visitor_id = ?'),
    insertClaim: db.prepare('INSERT INTO claimed_visitors (visitor_id, user_id, claimed_at) VALUES (?, ?, ?)'),
    upsertProgress: db.prepare('INSERT OR IGNORE INTO progress (user_id, level_id, cleared_at, ms, hints_used, mistakes) VALUES (?, ?, ?, ?, ?, ?)'),
    cleared: db.prepare('SELECT level_id FROM progress WHERE user_id = ? ORDER BY cleared_at'),
    upsertHistory: db.prepare('INSERT OR IGNORE INTO match_history (user_id, match_id, finished_at, record_json) VALUES (?, ?, ?, ?)'),
    history: db.prepare('SELECT record_json FROM match_history WHERE user_id = ? ORDER BY finished_at DESC LIMIT ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
    setFrame: db.prepare('UPDATE users SET frame = ? WHERE id = ?'),
    setSettings: db.prepare('UPDATE users SET settings_json = ? WHERE id = ?'),
    leaderboard: db.prepare('SELECT u.id, u.username, u.display_name, u.avatar, u.frame, COUNT(p.level_id) AS cleared FROM users u JOIN progress p ON p.user_id = u.id GROUP BY u.id')
  };

  function issueSession({ userId = null, guestId = null, userAgent }) {
    const token = newToken(), at = now();
    q.insertSession.run(hashToken(token), userId, guestId, at, at + (userId ? SESSION_TTL : GUEST_TTL), String(userAgent || '').slice(0, 200));
    return token;
  }

  async function register({ username, password, userAgent }) {
    const usernameError = validateUsername(username); if (usernameError) return { error: usernameError };
    const passwordError = validatePassword(password); if (passwordError) return { error: passwordError };
    if (q.userByName.get(username)) return { error: '這個帳號已經有人用了' };
    const { hash, salt } = await hashPassword(password);
    const id = `u_${nanoid(12)}`;
    try { q.insertUser.run(id, username, hash, salt, now(), username); }
    catch (error) { if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return { error: '這個帳號已經有人用了' }; throw error; }
    return { user: publicUser(q.userById.get(id)), token: issueSession({ userId: id, userAgent }) };
  }

  function loginCooldown(ip) {
    const at = now();
    q.pruneFailures.run(at - LOGIN_WINDOW);
    const { count, oldest } = q.failures.get(ip, at - LOGIN_WINDOW);
    return count >= LOGIN_MAX_FAILURES ? Math.max(1, Math.ceil((oldest + LOGIN_WINDOW - at) / 1000)) : 0;
  }

  // Unknown account and wrong password take the same path and the same
  // message; the dummy hash keeps the timing of the two alike.
  async function login({ username, password, ip, userAgent }) {
    const retryAfter = loginCooldown(ip);
    if (retryAfter) return { error: `登入失敗次數太多，請 ${retryAfter} 秒後再試`, retryAfter };
    const row = typeof username === 'string' ? q.userByName.get(username) : null;
    const ok = row
      ? await verifyPassword(String(password ?? ''), row.password_hash, row.salt)
      : await verifyPassword(String(password ?? ''), DUMMY.hash, DUMMY.salt) && false;
    if (!ok) { q.insertFailure.run(ip, now()); return { error: LOGIN_FAILED }; }
    q.clearFailures.run(ip);
    return { user: publicUser(row), token: issueSession({ userId: row.id, userAgent }) };
  }

  function logout(token) {
    if (typeof token === 'string' && token) q.deleteSession.run(hashToken(token));
  }

  function createGuest(userAgent) {
    const id = `g_${nanoid(12)}`, at = now();
    q.insertGuest.run(id, at, at);
    return { identity: { kind: 'guest', id }, token: issueSession({ guestId: id, userAgent }) };
  }

  // Resolves a cookie token to an identity. A user session past the renewal
  // point is rotated: the caller must set `renewedToken` as the new cookie.
  // Callers that cannot set a cookie (socket handshakes) pass renew: false.
  function resolve(token, userAgent, { renew = true } = {}) {
    if (typeof token !== 'string' || !token || token.length > 128) return null;
    const at = now();
    const session = q.session.get(hashToken(token));
    if (!session || session.expires_at <= at) return null;
    if (session.guest_id) {
      q.touchGuest.run(at, session.guest_id);
      q.expireSession.run(at + GUEST_TTL, session.token_hash);
      return { identity: { kind: 'guest', id: session.guest_id } };
    }
    const row = q.userById.get(session.user_id);
    if (!row) return null;
    const identity = { kind: 'user', ...publicUser(row) };
    if (!renew || session.expires_at - at >= SESSION_RENEW_BELOW) return { identity };
    const renewedToken = issueSession({ userId: row.id, userAgent });
    q.expireSession.run(at + ROTATED_GRACE, session.token_hash);
    return { identity, renewedToken };
  }

  function purgeExpired() {
    const at = now();
    q.purge.run(at); q.purgeGuests.run(at - GUEST_TTL); q.pruneFailures.run(at - LOGIN_WINDOW);
  }

  function bootstrapAdmin(username) {
    if (!username) return false;
    return q.setAdmin.run(username).changes > 0;
  }

  const claimVisitor = db.transaction((userId, visitorId, { cleared = [], history = [] }) => {
    if (q.claimed.get(visitorId)) return false;
    q.insertClaim.run(visitorId, userId, now());
    for (const levelId of cleared) q.upsertProgress.run(userId, String(levelId), now(), null, 0, null);
    for (const record of history) q.upsertHistory.run(userId, String(record.matchId), Number(record.finishedAt) || now(), JSON.stringify(record));
    return true;
  });

  return {
    register, login, logout, resolve, createGuest, purgeExpired, bootstrapAdmin, loginCooldown, claimVisitor,
    clearLevel: (userId, levelId, { ms = null, hints = 0, mistakes = null } = {}) => q.upsertProgress.run(userId, levelId, now(), ms, hints, mistakes),
    clearedLevels: userId => q.cleared.all(userId).map(row => row.level_id),
    recordMatch: (userId, record) => q.upsertHistory.run(userId, record.matchId, record.finishedAt, JSON.stringify(record)),
    matchHistory: (userId, limit = 50) => q.history.all(userId, limit).map(row => JSON.parse(row.record_json)),
    setDisplayName: (userId, name) => q.setDisplayName.run(name, userId),
    setAvatar: (userId, avatar) => q.setAvatar.run(avatar, userId),
    setFrame: (userId, frame) => q.setFrame.run(frame, userId),
    setSettings: (userId, settings) => q.setSettings.run(JSON.stringify(settings), userId),
    userLeaderboard: () => q.leaderboard.all().map(row => ({ id: row.id, name: row.display_name || row.username, cleared: row.cleared, avatar: row.avatar, frame: row.frame })),
    userById: id => { const row = q.userById.get(id); return row ? publicUser(row) : null; },
    deleteGuestSessions: guestId => q.deleteGuestSessions.run(guestId)
  };
}

const DUMMY = { salt: Buffer.alloc(SALT_BYTES), hash: Buffer.alloc(KEY_BYTES) };

module.exports = {
  createAuth, hashPassword, verifyPassword, hashToken, validateUsername, validatePassword, sanitizeDisplayName,
  LOGIN_FAILED, DISPLAY_NAME_MAX, SESSION_TTL, SESSION_RENEW_BELOW, GUEST_TTL, LOGIN_WINDOW, LOGIN_MAX_FAILURES
};
