import { serve } from '@hono/node-server';
import { createPool } from './db/pool.js';
import { parseConfig } from './config/index.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';

async function main() {
  const config = parseConfig(process.env);
  const pool = createPool(config.databaseUrl);

  // Run pending migrations on startup
  await runMigrations(config.databaseUrl);

  const { app } = createApp({ pool, config });

  console.log(`OSOD server starting on ${config.host}:${config.port}`);
  serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  console.log(`OSOD server running at http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Failed to start OSOD:', err);
  process.exit(1);
});
