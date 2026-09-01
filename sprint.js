const SPRINT_MIN = 1, SPRINT_MAX = 9999, SPRINT_DEFAULT = 60;
const FACTOR_MIN = 0.1, FACTOR_MAX = 9999, FACTOR_DEFAULT = 1;
const SPRINT_MODES = ['fixed', 'multiply'];

// Only plain numbers and non-blank numeric strings count: Number('') / Number(null) /
// Number([]) are all 0, which would silently become a 1 second sprint.
function numericOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}
function clampSprintSeconds(value, fallback = SPRINT_DEFAULT) {
  const parsed = numericOrNull(value);
  return parsed === null ? fallback : Math.min(SPRINT_MAX, Math.max(SPRINT_MIN, Math.round(parsed)));
}
function clampSprintFactor(value, fallback = FACTOR_DEFAULT) {
  const parsed = numericOrNull(value);
  return parsed === null ? fallback : Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, Math.round(parsed * 100) / 100));
}
function normalizeSprintMode(value, fallback = null) { return SPRINT_MODES.includes(value) ? value : fallback; }
// The factor multiplies the first finisher's own solve time, and the product goes
// through the same 1–9999 clamp so no factor can reach setTimeout unbounded.
function resolveSprintSeconds(room, elapsedMs) {
  if (room.sprintMode !== 'multiply') return clampSprintSeconds(room.sprintSeconds);
  const elapsed = numericOrNull(elapsedMs);
  return elapsed === null ? SPRINT_DEFAULT : clampSprintSeconds(clampSprintFactor(room.sprintFactor) * (elapsed / 1000));
}

module.exports = { SPRINT_MIN, SPRINT_MAX, SPRINT_DEFAULT, FACTOR_MIN, FACTOR_MAX, FACTOR_DEFAULT, SPRINT_MODES, clampSprintSeconds, clampSprintFactor, normalizeSprintMode, resolveSprintSeconds };
