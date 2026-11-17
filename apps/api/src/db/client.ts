import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import { env } from "../config/env.ts";
import * as schema from "./schemas/index.ts";

// PGlite's drizzle instance shares the same query-builder surface; typing both
// as postgres-js keeps upper layers driver-agnostic.
export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or an open transaction. Repositories take this. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

async function connect(): Promise<{ db: Db; close: () => Promise<void> }> {
  if (env.DATABASE_URL) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(env.DATABASE_URL, { max: 10 });
    return {
      db: drizzle(client, { schema }),
      close: () => client.end(),
    };
  }
  // Embedded Postgres for local dev without Docker.
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(env.PGLITE_DIR);
  return {
    db: drizzle(client, { schema }) as unknown as Db,
    close: () => client.close(),
  };
}

const conn = await connect();
export const db = conn.db;
export const closeDb = conn.close;
