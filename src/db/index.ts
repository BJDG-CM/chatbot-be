import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';
import {
  buildDatabaseSslOptions,
  needsTlsVerificationWarning,
  TLS_VERIFICATION_WARNING,
} from './ssl-options';

// Database connection token
export const DB_CONNECTION = Symbol('DB_CONNECTION');

// Database connection parameters
export interface DatabaseConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslEnabled: boolean;
}

const MIGRATION_LOCK_SQL = 'SELECT pg_advisory_lock(1128352846, 1667785076)';
const MIGRATION_UNLOCK_SQL =
  'SELECT pg_advisory_unlock(1128352846, 1667785076)';
const MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const MIGRATION_LOCK_TIMEOUT_SQL = `SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT_MS}ms'`;
const MIGRATION_LOCK_TIMEOUT_RESET_SQL = 'SET lock_timeout = DEFAULT';

export interface MigrationAdvisoryLockClient {
  unsafe(query: string): PromiseLike<unknown>;
}

export interface ReservedMigrationConnection extends MigrationAdvisoryLockClient {
  release(): void;
}

export interface ReservableMigrationClient<
  TConnection extends ReservedMigrationConnection = ReservedMigrationConnection,
> {
  reserve(): Promise<TConnection>;
  end(): Promise<void>;
}

export async function withReservedMigrationConnection<
  TConnection extends ReservedMigrationConnection,
  T,
>(
  client: ReservableMigrationClient<TConnection>,
  operation: (connection: TConnection) => Promise<T>,
): Promise<T> {
  let connection: TConnection | undefined;
  try {
    connection = await client.reserve();
    return await operation(connection);
  } finally {
    try {
      connection?.release();
    } finally {
      await client.end();
    }
  }
}

/** Serialize startup migrators across every application instance. */
export async function withMigrationAdvisoryLock<T>(
  client: MigrationAdvisoryLockClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.unsafe(MIGRATION_LOCK_TIMEOUT_SQL);
  await client.unsafe(MIGRATION_LOCK_SQL);
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    await client.unsafe(MIGRATION_LOCK_TIMEOUT_RESET_SQL);
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await client.unsafe(MIGRATION_UNLOCK_SQL);
  } catch (unlockError) {
    if (!operationFailed) throw unlockError;
  }
  if (operationFailed) throw operationError;
  return result as T;
}

// Database connection factory with SSL options
export const createDatabaseConnection = (params: DatabaseConnectionParams) => {
  if (needsTlsVerificationWarning(params.sslEnabled)) {
    console.warn(`[db] ${TLS_VERIFICATION_WARNING}`);
  }
  const options = {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: buildDatabaseSslOptions(params.sslEnabled),
  };

  // 보안: connection string 대신 개별 파라미터 사용하여 GitGuardian 감지 방지
  const client = postgres({
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.user,
    password: params.password,
    ...options,
  });
  return drizzle(client, { schema });
};

// Run migrations with SSL options
export const runMigrations = async (params: DatabaseConnectionParams) => {
  // Create a separate connection for migrations
  // 보안: connection string 대신 개별 파라미터 사용하여 GitGuardian 감지 방지
  const migrationClient = postgres({
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.user,
    password: params.password,
    max: 1,
    ssl: buildDatabaseSslOptions(params.sslEnabled),
  });
  // Determine migrations folder path based on environment
  const migrationsFolder =
    process.env.NODE_ENV === 'production'
      ? '/app/drizzle' // Docker container path
      : './drizzle'; // Local development path

  try {
    // max:1 keeps advisory lock + migrate on the same session. Do not pass
    // reserve() to drizzle — that wrapper lacks options.parsers.
    await withMigrationAdvisoryLock(migrationClient, () =>
      migrate(drizzle(migrationClient), { migrationsFolder }),
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Migration failed:', errorMessage);
    throw error;
  } finally {
    await migrationClient.end();
  }
};

// Type exports
export type Database = ReturnType<typeof createDatabaseConnection>;
export * from './schema';
