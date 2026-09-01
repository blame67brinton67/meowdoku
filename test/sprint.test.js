const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampSprintSeconds,
  clampSprintFactor,
  normalizeSprintMode,
  resolveSprintSeconds
} = require('../sprint');

test('clampSprintSeconds', () => {
  assert.equal(clampSprintSeconds(60), 60);
  assert.equal(clampSprintSeconds('60'), 60);
  assert.equal(clampSprintSeconds(' 90 '), 90);
  assert.equal(clampSprintSeconds(60.6), 61);
  assert.equal(clampSprintSeconds('1.5'), 2);
  assert.equal(clampSprintSeconds(99999), 9999);
  assert.equal(clampSprintSeconds('1e9'), 9999);
  assert.equal(clampSprintSeconds(-5), 1);
  assert.equal(clampSprintSeconds(0), 1);
  assert.equal(clampSprintSeconds(''), 60);
  assert.equal(clampSprintSeconds('   '), 60);
  assert.equal(clampSprintSeconds(null), 60);
  assert.equal(clampSprintSeconds(undefined), 60);
  assert.equal(clampSprintSeconds(NaN), 60);
  assert.equal(clampSprintSeconds(Infinity), 60);
  assert.equal(clampSprintSeconds(-Infinity), 60);
  assert.equal(clampSprintSeconds('12abc'), 60);
  assert.equal(clampSprintSeconds({}), 60);
  assert.equal(clampSprintSeconds([]), 60);
  assert.equal(clampSprintSeconds([5]), 60);
  assert.equal(clampSprintSeconds(true), 60);
  assert.equal(clampSprintSeconds('0x10'), 16);
  assert.equal(clampSprintSeconds('abc', null), null);
});

test('clampSprintFactor', () => {
  assert.equal(clampSprintFactor(1.5), 1.5);
  assert.equal(clampSprintFactor('1.234'), 1.23);
  assert.equal(clampSprintFactor('0.1'), 0.1);
  assert.equal(clampSprintFactor(0.001), 0.1);
  assert.equal(clampSprintFactor(0), 0.1);
  assert.equal(clampSprintFactor(-3), 0.1);
  assert.equal(clampSprintFactor(99999), 9999);
  assert.equal(clampSprintFactor('1e9'), 9999);
  assert.equal(clampSprintFactor(''), 1);
  assert.equal(clampSprintFactor('abc'), 1);
  assert.equal(clampSprintFactor(Infinity), 1);
  assert.equal(clampSprintFactor([]), 1);
  assert.equal(clampSprintFactor('', null), null);
});

test('normalizeSprintMode', () => {
  assert.equal(normalizeSprintMode('fixed'), 'fixed');
  assert.equal(normalizeSprintMode('multiply'), 'multiply');
  assert.equal(normalizeSprintMode('MULTIPLY'), null);
  assert.equal(normalizeSprintMode('fixed '), null);
  assert.equal(normalizeSprintMode(''), null);
  assert.equal(normalizeSprintMode(undefined), null);
  assert.equal(normalizeSprintMode({}), null);
  assert.equal(normalizeSprintMode('sprint'), null);
  assert.equal(normalizeSprintMode('nope', 'fixed'), 'fixed');
});

test('resolveSprintSeconds', () => {
  assert.equal(resolveSprintSeconds({ sprintMode: 'fixed', sprintSeconds: 12 }, 40000), 12);
  assert.equal(resolveSprintSeconds({ sprintMode: 'fixed', sprintSeconds: 12 }, NaN), 12);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 1.5 }, 40000), 60);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 0.5 }, 41300), 21);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 9999 }, 600000), 9999);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 0.1 }, 1000), 1);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 1 }, 0), 1);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 1 }, NaN), 60);
  assert.equal(resolveSprintSeconds({ sprintMode: 'multiply', sprintFactor: 'garbage' }, 40000), 40);
});
