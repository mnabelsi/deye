'use strict';

const collector = require('./collector');

// In-process scheduler: ticks every minute. The collector decides whether a poll is due
// (based on the interval stored in MySQL), so cron calls and multiple workers don't double up.
const TICK_MS = 60 * 1000;
let timer = null;
let running = false;
let nextAt = null;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const r = await collector.tick({ trigger: 'scheduler' });
    if (r && r.status === 'error') console.error('[collector]', r.message);
  } catch (err) {
    console.error('[collector] tick failed:', err.message);
  } finally {
    running = false;
    nextAt = Date.now() + TICK_MS;
  }
}

function start() {
  if (timer) return;
  console.log('[collector] Scheduler started');
  setTimeout(runOnce, 5000);
  nextAt = Date.now() + 5000;
  timer = setInterval(runOnce, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, isRunning: () => Boolean(timer), nextTickAt: () => nextAt };
