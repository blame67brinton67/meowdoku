'use strict';

// Daily hint allowance: three per identity per Taipei calendar day. The rules
// live here; where the ledger is kept is a `store` handed in by the caller, so
// the JSON file used today can be swapped for a database table without
// touching the arithmetic. Every operation is a single read-modify-write of
// the whole ledger, which is what keeps two rapid clicks from double-charging.

const DAILY_HINTS = 3;
const TIME_ZONE = 'Asia/Taipei';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function dayKey(now) { return dayFormatter.format(new Date(now)); }

function jsonFileStore(file, readJson, writeJson) {
  return { read: () => readJson(file, {}), write: ledger => writeJson(file, ledger) };
}
function memoryStore() {
  let ledger = {};
  return { read: () => ledger, write: next => { ledger = next; } };
}

function createHintQuota({ store, now = Date.now, daily = DAILY_HINTS }) {
  const validId = id => typeof id === 'string' && ID.test(id);
  // The first look on a new day hands out the day's allowance; later looks on
  // the same day only read.
  function entryFor(ledger, id) {
    const today = dayKey(now());
    const entry = ledger[id];
    if (entry && entry.day === today) return entry;
    return (ledger[id] = { day: today, granted: daily, used: 0, hinted: entry?.hinted || [] });
  }
  const view = entry => ({ day: entry.day, granted: entry.granted, used: entry.used, remaining: Math.max(0, entry.granted - entry.used), hinted: entry.hinted });

  function get(id) {
    if (!validId(id)) return null;
    const ledger = store.read();
    const entry = entryFor(ledger, id);
    store.write(ledger);
    return view(entry);
  }
  // Charges one hint, or refuses without touching the count. `levelId` is
  // remembered so a later achievement system can tell hint-free clears apart.
  function consume(id, levelId) {
    if (!validId(id)) return { ok: false, remaining: 0, error: '無效的玩家識別碼' };
    const ledger = store.read();
    const entry = entryFor(ledger, id);
    if (entry.used >= entry.granted) { store.write(ledger); return { ok: false, ...view(entry), error: '今天的提示用完了，明天再來領 3 次' }; }
    entry.used++;
    if (typeof levelId === 'string' && levelId && !entry.hinted.includes(levelId)) entry.hinted = [...entry.hinted, levelId].slice(-200);
    store.write(ledger);
    return { ok: true, ...view(entry) };
  }
  return { get, consume };
}

module.exports = { createHintQuota, jsonFileStore, memoryStore, dayKey, DAILY_HINTS, TIME_ZONE };
