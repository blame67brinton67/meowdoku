'use strict';

const { generatePuzzle } = require('./puzzle');

let Worker;
try { ({ Worker } = require('worker_threads')); } catch (error) {
  console.error('無法載入題目 worker，改用主執行緒產題', error.message);
}

const jobs = new Map(), queue = [];
const workerFile = require('path').join(__dirname, 'puzzle-worker.js');
let worker = null, active = null, nextJobId = 1, workerDisabled = !Worker;

function failWorker(instance, error) {
  if (worker !== instance) return;
  worker = null;
  const failed = [active, ...queue];
  active = null; queue.length = 0;
  for (const job of failed) if (job) { jobs.delete(job.jobId); job.reject(error); }
}

function ensureWorker() {
  if (worker || workerDisabled) return;
  try {
    const instance = new Worker(workerFile);
    worker = instance;
    instance.on('message', message => {
      if (worker !== instance) return;
      const job = jobs.get(message.jobId);
      if (!job) return;
      jobs.delete(message.jobId); active = null;
      if (message.error) job.reject(new Error(message.error)); else job.resolve(message.puzzle);
      pump();
    });
    instance.once('error', error => failWorker(instance, error));
    instance.once('exit', code => {
      if (worker === instance) failWorker(instance, new Error(`題目 worker 結束（${code}）`));
    });
  } catch (error) {
    workerDisabled = true;
    console.error('無法建立題目 worker，改用主執行緒產題', error.message);
  }
}

function pump() {
  if (workerDisabled || active || !queue.length) return;
  ensureWorker();
  if (!worker) return;
  active = queue.shift();
  try { worker.postMessage({ jobId: active.jobId, size: active.size }); } catch (error) { failWorker(worker, error); }
}

function generateAsync(size) {
  if (workerDisabled) return Promise.resolve().then(() => generatePuzzle(size));
  const jobId = nextJobId++;
  return new Promise((resolve, reject) => {
    const job = { jobId, size, resolve, reject };
    jobs.set(jobId, job); queue.push(job); ensureWorker(); pump();
  });
}

// Lets a test process exit once it is done with the server; pending jobs are
// rejected rather than left dangling.
function stopWorker() {
  if (!worker) return Promise.resolve();
  const instance = worker;
  failWorker(instance, new Error('題目 worker 已關閉'));
  return instance.terminate();
}

module.exports = { generateAsync, stopWorker };
