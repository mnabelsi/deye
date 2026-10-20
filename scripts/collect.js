'use strict';

// Runs one collection from the command line, e.g. from a cron job:
//   cd ~/path/to/app && node scripts/collect.js [--force] [--discover]
const db = require('../src/db');
const collector = require('../src/collector');

(async () => {
  const force = process.argv.includes('--force');
  const discover = process.argv.includes('--discover');
  try {
    await db.migrate();
    const r = await collector.tick({ trigger: 'cli', force, discover });
    console.log(`[collect] ${r.status}: ${r.message}`);
    process.exitCode = r.status === 'error' ? 1 : 0;
  } catch (err) {
    console.error('[collect] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
