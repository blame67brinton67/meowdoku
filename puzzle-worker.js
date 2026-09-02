'use strict';

const { parentPort } = require('worker_threads');
const { generatePuzzle } = require('./puzzle');

parentPort.on('message', ({ jobId, size }) => {
  try {
    parentPort.postMessage({ jobId, puzzle: generatePuzzle(size) });
  } catch (error) {
    parentPort.postMessage({ jobId, error: error.message });
  }
});
