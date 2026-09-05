'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BOARD_THEMES } = require('../public/themes');

const HEX = /^#[0-9a-f]{6}$/;
const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
const linear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const luminance = hex => 0.2126 * linear(channel(hex, 0)) + 0.7152 * linear(channel(hex, 1)) + 0.0722 * linear(channel(hex, 2));
// CIE76 in Lab: the same metric used while tuning the palettes.
function lab(hex) {
  const [r, g, b] = [0, 1, 2].map(i => linear(channel(hex, i)));
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const minPairwise = colors => Math.min(...colors.flatMap((a, i) => colors.slice(i + 1).map(b => deltaE(a, b))));

test('every theme has twelve distinct, valid, deep region colours', () => {
  assert.ok(BOARD_THEMES.length >= 6 && BOARD_THEMES.length <= 8);
  assert.strictEqual(new Set(BOARD_THEMES.map(theme => theme.id)).size, BOARD_THEMES.length);
  for (const theme of BOARD_THEMES) {
    assert.match(theme.name, /\p{Script=Han}/u);
    assert.strictEqual(theme.palette.length, 12, theme.id);
    for (const color of [...theme.palette, theme.boardLine, theme.paper]) assert.match(color, HEX, `${theme.id} ${color}`);
    assert.strictEqual(new Set(theme.palette).size, 12, `${theme.id} repeats a colour`);
    // Cats, marks and the red error ring sit on top; light cells wash them out.
    for (const color of theme.palette) assert.ok(luminance(color) <= 0.42, `${theme.id} ${color} is too light`);
    assert.ok(luminance(theme.paper) > 0.8, `${theme.id} paper must stay light`);
  }
});

test('region colours stay far apart, the high-contrast theme most of all', () => {
  for (const theme of BOARD_THEMES) assert.ok(minPairwise(theme.palette) >= 18, `${theme.id} min ΔE ${minPairwise(theme.palette).toFixed(1)}`);
  assert.ok(minPairwise(BOARD_THEMES.find(theme => theme.id === 'contrast').palette) >= 40);
});
