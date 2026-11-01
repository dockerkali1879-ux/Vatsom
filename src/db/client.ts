import { Pool, PoolClient } from '@neondatabase/serverless';
import { Env } from '../types';

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface QueryResult<T = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DatabaseClient extends SqlExecutor {
  withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Pooled Neon PostgreSQL client supporting both Cloudflare Hyperdrive
 * (`env.HYPERDRIVE.connectionString`) and Neon Serverless Pool (`env.DATABASE_URL`).
 * Reuses pools across requests within the Worker isolate to prevent connection exhaustion.
 */
const isolatePoolCache = new Map<string, Pool>();

function getOrCreateNeonPool(connectionString: string): Pool {
  let pool = isolatePoolCache.get(connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 8000
    });
    isolatePoolCache.set(connectionString, pool);
  }
  return pool;
}

export class NeonPostgresClient implements DatabaseClient {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = getOrCreateNeonPool(connectionString);
  }

  async query<T = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // Defense-in-depth: ensure all parameters are passed out-of-line
    const res = await this.pool.query(sql, params);
    return {
      rows: (res.rows ?? []) as T[],
      rowCount: res.rowCount ?? 0
    };
  }

  async withTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txExecutor: SqlExecutor = {
        query: async <R = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> => {
          const res = await client.query(sql, params);
          return {
            rows: (res.rows ?? []) as R[],
            rowCount: res.rowCount ?? 0
          };
        }
      };
      const result = await fn(txExecutor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Transaction rollback error:', rollbackErr);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

let customTestDbOverride: DatabaseClient | null = null;

export function setTestDatabaseOverride(db: DatabaseClient | null): void {
  customTestDbOverride = db;
}

export function resolveDatabaseClient(env: Env): DatabaseClient {
  if (customTestDbOverride) {
    return customTestDbOverride;
  }

  const connectionString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Database connection is not configured. Configure Cloudflare Hyperdrive (HYPERDRIVE) or DATABASE_URL secret.'
    );
  }

  return new NeonPostgresClient(connectionString);
}

