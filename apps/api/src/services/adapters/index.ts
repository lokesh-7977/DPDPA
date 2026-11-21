import { env } from "../../config/env.ts";
import { logger } from "../../config/logger.ts";
import {
  IntegrationUnavailable,
  useInventoryProvider,
} from "../cloud-inventory.ts";
import { useGithubClient } from "../github-client.ts";
import { createAwsInventory } from "./aws-inventory.ts";
import { createGithubRestClient } from "./github-rest.ts";
import { createWorkspaceInventory } from "./google-workspace.ts";

/**
 * Installs the real adapters at process start (API and worker; tests keep their fakes).
 * AWS needs the platform's own credentials; GitHub needs the App ID, private key and OAuth
 * client. Google Workspace needs nothing platform-side (each integration has its own key).
 */
export function installAdapters(opts: { aws: boolean }): void {
  // Only the worker syncs inventories: the API process never holds the platform's AWS keys.
  const awsCreds =
    opts.aws && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        }
      : null;
  const aws = awsCreds ? createAwsInventory({ credentials: awsCreds }) : null;
  useInventoryProvider({
    aws: aws
      ? aws
      : async () => {
          throw new IntegrationUnavailable("AWS connector not configured");
        },
    workspace: createWorkspaceInventory(),
  });

  const gh =
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET;
  const ghVars = {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID: env.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: env.GITHUB_APP_CLIENT_SECRET,
  };
  const missing = Object.entries(ghVars).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length && missing.length < 4)
    logger.warn({ missing }, "GitHub client not installed: settings incomplete");
  if (gh)
    useGithubClient(
      createGithubRestClient({
        appId: env.GITHUB_APP_ID!,
        // Env files often hold the PEM on one line with literal \n.
        privateKey: env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
        clientId: env.GITHUB_APP_CLIENT_ID!,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
      }),
    );
  logger.info(
    { aws: !!aws, googleWorkspace: true, githubClient: !!gh },
    "Integration adapters installed",
  );
}
