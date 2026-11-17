/**
 * Synthetic HoundDog-style SARIF 2.1.0 fixture (shape per SARIF spec + HoundDog
 * docs: data elements w/ sensitivity + tags, data sinks, risky/safe dataflows).
 * Replace/extend with a real `hounddog scan --output-format=sarif` file when available.
 */
type Flow = {
  rule: string;
  file: string;
  line: number;
  elements: { name: string; sensitivity: "low" | "medium" | "high"; tags: string[] }[];
  sink: string;
  severity: "low" | "medium" | "high";
  risky: boolean;
};

export const FLOWS = {
  emailToLogs: {
    rule: "hounddog.dataflow.logs",
    file: "server/src/users.ts",
    line: 42,
    elements: [{ name: "Email Address", sensitivity: "low", tags: ["PII"] }],
    sink: "Logs",
    severity: "low",
    risky: true,
  },
  aadhaarToOpenAI: {
    rule: "hounddog.dataflow.ai",
    file: "server/src/kyc.ts",
    line: 17,
    elements: [{ name: "Aadhaar Number", sensitivity: "high", tags: ["PII"] }],
    sink: "OpenAI",
    severity: "high",
    risky: true,
  },
  phoneToDb: {
    rule: "hounddog.dataflow.database",
    file: "server/src/repo.ts",
    line: 8,
    elements: [{ name: "Phone Number", sensitivity: "medium", tags: ["PII"] }],
    sink: "PostgreSQL",
    severity: "low",
    risky: false,
  },
  cardToStripe: {
    rule: "hounddog.dataflow.third_party",
    file: "server/src/billing.ts",
    line: 99,
    elements: [{ name: "Bank Card Number", sensitivity: "high", tags: ["CHD", "PIFI"] }],
    sink: "Stripe",
    severity: "high",
    risky: true,
  },
} satisfies Record<string, Flow>;

export function hounddogSarif(flows: Flow[], version = "4.2.0") {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "HoundDog.ai",
            semanticVersion: version,
            rules: [...new Set(flows.map((f) => f.rule))].map((id) => ({
              id,
              shortDescription: { text: `Sensitive data flows to ${id.split(".").pop()}` },
            })),
          },
        },
        results: flows.map((f) => ({
          ruleId: f.rule,
          level: f.severity === "high" ? "error" : "warning",
          message: { text: `${f.elements.map((e) => e.name).join(", ")} → ${f.sink}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                // Snippets must never be stored by the platform.
                region: { startLine: f.line, snippet: { text: 'logger.info("user", "jane@example.com")' } },
              },
            },
          ],
          properties: {
            severity: f.severity,
            dataElements: f.elements,
            dataSink: f.sink,
            dataflowType: f.risky ? "risky" : "safe",
          },
        })),
      },
    ],
  };
}
