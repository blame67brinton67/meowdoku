'use strict';
// Board colour presets: twelve region colours plus grid line and page paper.
// Loaded as a plain script by the page and required by the tests, hence the
// dual export. Every palette is kept deep — the cat, the × and the red error
// ring are all drawn on top of these, and light tints made the cells blur
// together at 10 × 10.
const BOARD_THEMES = [
  { id: 'classic', name: '經典', palette: ['#c4423d', '#2b6cb0', '#c07c12', '#2c7a4b', '#6b4b9e', '#8aa625', '#b83f7d', '#159490', '#8a4a1f', '#4b5768', '#7a2f4e', '#1f6f8b'], boardLine: '#c7cad1', paper: '#fffaf1' },
  { id: 'sakura', name: '櫻花', palette: ['#e24679', '#6a59bc', '#c4790e', '#498d58', '#8c282c', '#4e90d6', '#c66fb3', '#9b9d36', '#e97f65', '#43536b', '#6d2251', '#00949b'], boardLine: '#e3c6cf', paper: '#fff5f7' },
  { id: 'ocean', name: '海洋', palette: ['#2879ba', '#2ba89e', '#08458f', '#0098ba', '#7164bd', '#4e8b56', '#6a5674', '#006277', '#7890b0', '#193b5c', '#914c93', '#00725e'], boardLine: '#bcd3e0', paper: '#f2f8fb' },
  { id: 'forest', name: '森林', palette: ['#006e2b', '#6b4c00', '#449919', '#b95925', '#007274', '#747e00', '#713527', '#2aa785', '#6e804d', '#c29544', '#174325', '#a57e68'], boardLine: '#cfd8c8', paper: '#f6f8ee' },
  { id: 'night', name: '夜貓', palette: ['#475b8f', '#61175e', '#03404d', '#90475f', '#294011', '#313996', '#673802', '#007856', '#3b1815', '#18163b', '#867551', '#63898c'], boardLine: '#6b7080', paper: '#eef0f6' },
  { id: 'candy', name: '糖果', palette: ['#e85178', '#008de4', '#ef7c00', '#4d9e53', '#8e3fd6', '#b29500', '#e867bf', '#00a897', '#e8452f', '#5e56b9', '#8c3366', '#41a5c8'], boardLine: '#f0d0e0', paper: '#fff8fb' },
  { id: 'morandi', name: '莫蘭迪', palette: ['#93493f', '#477ba4', '#ad7e46', '#456c4a', '#745c8e', '#9ca568', '#af7086', '#318a8c', '#614e34', '#88888d', '#5f3443', '#375158'], boardLine: '#d4cfc7', paper: '#f7f4ef' },
  { id: 'contrast', name: '高對比', palette: ['#010800', '#ff8f00', '#0070ed', '#87b96c', '#e0110a', '#ae5e8e', '#00bedc', '#7b694f', '#6f00ff', '#223167', '#6f1300', '#530097'], boardLine: '#000000', paper: '#ffffff' }
];
if (typeof module !== 'undefined') module.exports = { BOARD_THEMES };
