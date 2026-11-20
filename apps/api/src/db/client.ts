import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  PostgresJsDatabase,
  PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import { env } from "../config/env.ts";
import { sql } from "drizzle-orm";
import { currentScope, runInScope, scopeParams, SCOPE_SQL } from "./scope.ts";
import * as schema from "./schemas/index.ts";

// PGlite's drizzle instance shares the same query-builder surface; typing both
// as postgres-js keeps upper layers driver-agnostic.
export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or an open transaction. Repositories take this. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/**
 * Row-level security (Step 8): every statement and transaction first applies the current
 * scope (role + org) with transaction-local settings, so pooled connections never carry a scope
 * over. A standalone statement becomes a short transaction. Inside a transaction drizzle uses
 * the driver's own transaction client, which is not wrapped (the scope is already set).
 */
type PgUnsafe = (
  q: string,
  p?: unknown[],
  o?: unknown,
) => PromiseLike<unknown> & { values(): PromiseLike<unknown> };
type PgBegin = (fn: (sql: { unsafe: PgUnsafe }) => unknown) => Promise<unknown>;

function scopedPostgres<C extends object>(client: C): C {
  const real = client as unknown as { unsafe: PgUnsafe; begin: PgBegin };
  const begin = (fn: (sql: { unsafe: PgUnsafe }) => unknown) => {
    const scope = currentScope();
    if (scope.kind === "owner") return real.begin(fn);
    return real.begin(async (sql) => {
      await sql.unsafe(SCOPE_SQL, scopeParams(scope));
      return fn(sql);
    });
  };
  const unsafe = (q: string, p?: unknown[], o?: unknown) => {
    const scope = currentScope();
    if (scope.kind === "owner") return real.unsafe(q, p, o);
    // Scope and statement are pipelined on the transaction's connection (one wait, not two).
    const run = (values: boolean) =>
      real.begin(async (sql) => {
        const pending = sql.unsafe(q, p, o);
        const [, result] = await Promise.all([
          sql.unsafe(SCOPE_SQL, scopeParams(scope)),
          values ? pending.values() : pending,
        ]);
        return result;
      });
    // Memoised: a second then() / values() never runs the statement again.
    let rows: Promise<unknown> | undefined;
    let values: Promise<unknown> | undefined;
    return {
      values: () => (values ??= run(true)),
      then: <A, B>(ok?: (v: unknown) => A, ko?: (e: unknown) => B) =>
        (rows ??= run(false)).then(ok, ko),
    };
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "unsafe") return unsafe;
      if (prop === "begin") return begin;
      return Reflect.get(target, prop, receiver);
    },
  });
}

type PgliteLike = {
  query(q: string, p?: unknown[], o?: unknown): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
};

function scopedPglite<C extends object>(client: C): C {
  const real = client as unknown as PgliteLike;
  const transaction = <T>(fn: (tx: PgliteLike) => Promise<T>) => {
    const scope = currentScope();
    if (scope.kind === "owner") return real.transaction(fn);
    return real.transaction(async (tx) => {
      await tx.query(SCOPE_SQL, scopeParams(scope));
      return fn(tx);
    });
  };
  const query = (q: string, p?: unknown[], o?: unknown) =>
    currentScope().kind === "owner"
      ? real.query(q, p, o)
      : transaction((tx) => tx.query(q, p, o));
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "query") return query;
      if (prop === "transaction") return transaction;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function connect(): Promise<{ db: Db; close: () => Promise<void> }> {
  if (env.DATABASE_URL) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(env.DATABASE_URL, { max: 10 });
    return {
      db: drizzle(scopedPostgres(client), { schema }),
      close: () => client.end(),
    };
  }
  // Embedded Postgres for local dev without Docker.
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(env.PGLITE_DIR);
  return {
    db: drizzle(scopedPglite(client), { schema }) as unknown as Db,
    close: () => client.close(),
  };
}

const conn = await connect();
export const db = conn.db;
export const closeDb = conn.close;

/**
 * Production guard (Step 8): the API / worker login must not be able to bypass row-level
 * security, directly or by switching role: no superuser / BYPASSRLS attribute, no membership of
 * a role that has one (e.g. Neon's neon_superuser), and no ownership of the tables (owners
 * bypass RLS).
 */
export async function assertAppLogin(): Promise<void> {
  const res = (await runInScope({ kind: "owner" }, () =>
    db.execute(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_roles r
          WHERE (r.rolsuper OR r.rolbypassrls) AND pg_has_role(session_user, r.oid, 'MEMBER')
        ) AS bypass,
        EXISTS (
          SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relkind = 'r'
            AND pg_has_role(session_user, t.relowner, 'MEMBER')
        ) AS owner,
        pg_has_role(session_user, 'dpdpa_app', 'SET') AS can_switch`),
  )) as unknown;
  type Row = { bypass: boolean; owner: boolean; can_switch: boolean };
  // postgres-js returns the rows; PGlite wraps them in { rows }.
  const rows = (
    Array.isArray(res) ? res : (res as { rows: Row[] }).rows
  ) as Row[];
  const r = rows[0];
  if (!r || r.bypass || r.owner || !r.can_switch)
    throw new Error(
      "DATABASE_URL must use the dpdpa_api login (member of dpdpa_app; no superuser / BYPASSRLS role; not the table owner); see docs/operations.md",
    );
}
