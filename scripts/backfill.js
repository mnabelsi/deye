'use strict';

// Imports DeyeCloud history for a date range and works through the queue until done:
//   node scripts/backfill.js 2025-01-01 2025-03-31
const db = require('../src/db');
const collector = require('../src/collector');

(async () => {
  const [from, to] = process.argv.slice(2);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '')) {
    console.error('Usage: node scripts/backfill.js YYYY-MM-DD YYYY-MM-DD');
    process.exit(2);
  }
  try {
    await db.migrate();
    const q = await collector.enqueueRange(from, to);
    console.log(`[backfill] Queued ${q.items} job(s) for ${q.days} day(s)`);
    for (;;) {
      const r = await collector.tick({ trigger: 'cli' });
      console.log(`[backfill] ${r.status}: ${r.message}`);
      const left = await db.one("SELECT COUNT(*) AS n FROM backfill_queue WHERE status IN ('pending','running')");
      if (!left.n || r.status === 'skipped' || (r.status === 'error' && !r.backfilled)) break;
    }
  } catch (err) {
    console.error('[backfill] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
