import type { Lease } from "../domain/jobs.ts";

/**
 * Step 17 — GitHub App access and the HoundDog runner, behind interfaces. The real client
 * (App JWT → installation token, REST) and the sandboxed scanner are added once the App is
 * registered; until then the defaults answer "not configured". Tests swap in fakes.
 */

export type GithubRepository = {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type GithubClient = {
  /** Read with the App JWT (`GET /app/installations/{id}`): ids of other Apps are not found. */
  installation(installationId: number): Promise<{
    account: { login: string; type: string };
  }>;
  /**
   * Proves the person who just installed controls the installation: exchanges the OAuth `code`
   * from "Request user authorization during installation" for a user token, then requires
   * `installationId` in `GET /user/installations` and the user to be an admin / owner of the
   * installation's account. Never reads URLs from the request.
   */
  installerControls(code: string, installationId: number): Promise<boolean>;
  repositories(installationId: number): Promise<GithubRepository[]>;
};

/**
 * Clones `repository` at `ref` and runs HoundDog (`--output-format=sarif`). The real runner
 * must:
 * - use an installation token limited to that one repository with `contents: read`, passed
 *   through a credential helper (never in the URL or argv), and never log it;
 * - treat `ref` as data (SAFE_REF, always after `--`); no submodules, LFS, hooks or
 *   fsmonitor; never follow symlinks out of the clone; run no code from the repository;
 * - run in a sandbox: network to github.com only (no metadata / private addresses), CPU,
 *   memory, disk and time limits; delete the clone afterwards;
 * - renew `lease` while it works and stop when renewal fails;
 * - throw errors whose `name` is a fixed code (never built from stderr or the token).
 * Returns the commit and branch scanned and the SARIF (≤ MAX_SARIF_BYTES).
 */
export type CodeScanner = {
  scan(v: {
    installationId: number;
    repository: string;
    ref: string;
    lease?: Lease;
  }): Promise<{ commitSha: string; branch: string; sarif: unknown }>;
};

export class GithubUnavailable extends Error {
  override name = "GithubUnavailable";
}

const unavailable = async (): Promise<never> => {
  throw new GithubUnavailable("GitHub App not configured");
};
let client: GithubClient = {
  installation: unavailable,
  installerControls: unavailable,
  repositories: unavailable,
};
let scanner: CodeScanner = { scan: unavailable };

export const githubClient = (): GithubClient => client;
export const codeScanner = (): CodeScanner => scanner;
export function useGithubClient(c: GithubClient) {
  client = c;
}
export function useCodeScanner(s: CodeScanner) {
  scanner = s;
}
