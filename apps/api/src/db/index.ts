/**
 * Single entry point for the data layer: connection, types and all tables.
 * Repositories and services import from here, never from individual files.
 *
 * Importing this module connects to the database (top-level await in client.ts).
 * Code that only needs table *types* (e.g. http DTO mappers) should
 * `import type` from "./schemas/index.ts" instead.
 */
export {
  assertAppLogin,
  closeDb,
  db,
  type Db,
  type Executor,
  type Tx,
} from "./client.ts";
export { currentScope, runInScope, type DbScope } from "./scope.ts";
export * from "./schemas/index.ts";
