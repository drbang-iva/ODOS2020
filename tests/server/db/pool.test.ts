import { describe, it, expect } from 'vitest';
import { createPool } from '../../../src/server/db/pool.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('createPool', () => {
  it('connects to PostgreSQL and runs a query', async () => {
    const pool = createPool(TEST_DB_URL);
    const result = await pool.query('SELECT 1 AS value');
    expect(result.rows[0].value).toBe(1);
    await pool.end();
  });

  it('rejects invalid connection strings', async () => {
    const pool = createPool('postgresql://bad:bad@localhost:9999/nope');
    await expect(pool.query('SELECT 1')).rejects.toThrow();
    await pool.end();
  });
});
