import {
  Client,
  Pool,
  type ClientConfig,
  type PoolConfig,
} from "pg";

export type PostgresErrorLogger = (message: string, error: Error) => void;

const defaultErrorLogger: PostgresErrorLogger = (message, error) => {
  console.error(message, error);
};

export function createPostgresPool(
  config: PoolConfig,
  context: string,
  logError: PostgresErrorLogger = defaultErrorLogger,
): Pool {
  const pool = new Pool(config);
  pool.on("error", (error) => {
    logError(`odos-mcp: PostgreSQL pool error (${context}):`, error);
  });
  return pool;
}

export function createPostgresClient(
  config: ClientConfig,
  context: string,
  logError: PostgresErrorLogger = defaultErrorLogger,
): Client {
  const client = new Client(config);
  client.on("error", (error) => {
    logError(`odos-mcp: PostgreSQL client error (${context}):`, error);
  });
  return client;
}
