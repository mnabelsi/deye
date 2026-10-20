'use strict';

// Entry point. On Hostinger set this file as the application's "Entry file".
const config = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const scheduler = require('./src/scheduler');

async function main() {
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[web] Deye Solar Monitor listening on port ${config.port}`);
  });

  // Retry migrations so the web UI still starts (and shows an error) if MySQL is not ready yet.
  let delay = 2000;
  for (;;) {
    try {
      await db.migrate();
      console.log('[db] Schema ready');
      break;
    } catch (err) {
      console.error(`[db] Cannot initialise database (${err.code || err.message}); retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }

  if (config.schedulerEnabled) scheduler.start();

  const shutdown = async (signal) => {
    console.log(`[web] ${signal} received, shutting down`);
    scheduler.stop();
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('[process] Unhandled rejection:', err));

main().catch((err) => {
  console.error('[web] Fatal startup error:', err);
  process.exit(1);
});
