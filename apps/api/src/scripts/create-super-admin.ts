/**
 * Create the platform super admin (or promote an existing user).
 *
 *   pnpm --filter api create-super-admin <email> "<Full Name>"
 *
 * The password is read from SUPER_ADMIN_PASSWORD if set, otherwise prompted for
 * (input hidden). It is never accepted as a command-line argument, so it can't
 * end up in shell history or process listings.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { closeDb } from "../db/index.ts";
import { DomainError } from "../domain/errors.ts";
import { identityService } from "../services/identity.service.ts";

function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('Usage: pnpm --filter api create-super-admin <email> "<Full Name>"');
  process.exit(1);
}

if (process.env.SUPER_ADMIN_PASSWORD) {
  console.warn("Using SUPER_ADMIN_PASSWORD from the environment: remove it from .env / shell afterwards.");
}
const password = process.env.SUPER_ADMIN_PASSWORD ?? (await promptHidden("Password (min 12 chars, ignored if the user already exists): "));

try {
  const { userId, created } = await identityService.bootstrapSuperAdmin({ email, name, password });
  console.log(created ? `Super admin created: ${userId}` : `Existing user promoted to super admin: ${userId}`);
} catch (err) {
  // Never print raw DB errors: their message embeds query params (email, password hash).
  console.error(err instanceof DomainError ? err.message : `Failed: ${(err as Error).name}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
