'use strict';

/**
 * @fileoverview Application startup, database migration, and graceful shutdown.
 */

const { join } = require('node:path');
const { createApiServer } = require('./api/server.js');
const { createPostgresStore } = require('./infrastructure/postgres-store.js');

/**
 * Connects to PostgreSQL, applies migrations, and starts the HTTP server.
 *
 * Reads `DATABASE_URL`, `HOST`, and `PORT` from the process environment.
 * Resolves once the server is listening; SIGINT and SIGTERM trigger graceful
 * server and pool shutdown.
 *
 * @returns {Promise<void>} Resolves after the server starts listening.
 * @throws {Error} If database initialization, migration, or listening fails.
 */
async function start() {
  const store = await createPostgresStore({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await store.migrate();
    const server = createApiServer({
      store,
      webRoot: join(__dirname, '..', 'public'),
    });
    const port = Number(process.env.PORT ?? 4179);
    const host = process.env.HOST ?? '127.0.0.1';

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

    console.log(`PageTracker is listening on http://${host}:${port}`);

    let stopping = false;
    const stop = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await store.close();
      } catch (error) {
        console.error('Failed to stop PageTracker cleanly:', error);
        process.exitCode = 1;
      }
    };

    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } catch (error) {
    await store.close();
    throw error;
  }
}

if (require.main === module) {
  void start().catch((error) => {
    console.error('Failed to start PageTracker:', error);
    process.exitCode = 1;
  });
}

module.exports = { start };
