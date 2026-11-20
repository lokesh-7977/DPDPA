import type { Lease } from "../domain/jobs.ts";
import type {
  AwsConfig,
  AwsInventory,
  WorkspaceConfig,
  WorkspaceInventory,
} from "../domain/cloud-inventory.ts";

/**
 * Step 15 — read-only inventory of a customer's AWS account and Google Workspace.
 * The real adapters (AWS SDK with STS AssumeRole + external ID; Google Admin SDK with
 * domain-wide delegation) are added once test accounts exist; until then the default provider
 * answers "not configured" and a sync is recorded as failed with that reason.
 * Tests swap in a fake with useInventoryProvider.
 */
/**
 * Adapters must: be read-only; renew `lease` between pages / regions and stop when it returns
 * false; time out each call; throw errors whose name is a fixed code (never log e.message, it can
 * hold ARNs or emails). AWS: STS AssumeRole with the stored external ID, session name
 * `dpdpa-<integrationId>`, 15-minute session, allow-listed regions only, no custom endpoints,
 * check the assumed account matches the role ARN. Google: fixed token endpoint
 * (https://oauth2.googleapis.com/token), subject = adminEmail, the two read-only scopes only.
 */
export type InventoryProvider = {
  aws(config: AwsConfig, lease?: Lease): Promise<AwsInventory>;
  workspace(
    config: WorkspaceConfig,
    serviceAccountKey: string,
    lease?: Lease,
  ): Promise<WorkspaceInventory>;
};

export class IntegrationUnavailable extends Error {
  override name = "IntegrationUnavailable";
}

const notConfigured: InventoryProvider = {
  aws: async () => {
    throw new IntegrationUnavailable("AWS connector not configured");
  },
  workspace: async () => {
    throw new IntegrationUnavailable(
      "Google Workspace connector not configured",
    );
  },
};

let current: InventoryProvider = notConfigured;

export const inventoryProvider = (): InventoryProvider => current;

/** Tests (and, later, the real adapters at startup) install the provider. */
export function useInventoryProvider(p: InventoryProvider) {
  current = p;
}
