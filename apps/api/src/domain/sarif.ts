/**
 * Pure SARIF 2.1.0 normaliser for privacy scanners (HoundDog.ai first).
 * No I/O. Tolerant: HoundDog-specific property names are read when present,
 * generic SARIF fields otherwise.
 *
 * Privacy: code snippets (`region.snippet`, `contextRegion`) are never read, and
 * free text is truncated — scanned repos can contain test PII.
 */

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Sensitivity = "low" | "medium" | "high";
export type SinkType =
  | "log"
  | "database"
  | "file"
  | "api"
  | "third_party"
  | "ai_llm"
  | "cookie_storage"
  | "analytics"
  | "other";

export type NormalisedElement = { name: string; sensitivity: Sensitivity | null; tags: string[] };
export type NormalisedResult = {
  ruleId: string;
  title: string;
  severity: Severity;
  filePath: string | null;
  line: number | null;
  dataElements: string[];
  sinkName: string | null;
  sinkType: SinkType | null;
  /** HoundDog "risky" vs "safe" dataflow; null when the tool doesn't say. */
  risky: boolean | null;
};
export type NormalisedScan = {
  tool: string;
  toolVersion: string | null;
  results: NormalisedResult[];
  elements: NormalisedElement[];
};

export class SarifError extends Error {}

const MAX_TEXT = 300;
const MAX_RESULTS = 20_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** First string found under any of the given property keys (case-insensitive). */
function pick(props: Obj | undefined, ...keys: string[]): unknown {
  if (!props) return undefined;
  const lower = new Map(Object.entries(props).map(([k, v]) => [k.toLowerCase().replace(/[_-]/g, ""), v]));
  for (const k of keys) {
    const v = lower.get(k.toLowerCase().replace(/[_-]/g, ""));
    if (v !== undefined) return v;
  }
  return undefined;
}

function toStrings(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return arr(v)
    .map((x) => (isObj(x) ? str(x.name) ?? str(x.id) : str(x)))
    .filter((x): x is string => x !== null)
    .map(clip);
}

export function toSeverity(v: unknown): Severity | null {
  const s = str(v)?.toLowerCase();
  if (!s) return null;
  if (s === "critical") return "critical";
  if (s === "high" || s === "error") return "high";
  if (s === "medium" || s === "moderate" || s === "warning") return "medium";
  if (s === "low" || s === "note") return "low";
  if (s === "info" || s === "none" || s === "informational") return "info";
  return null;
}

function toSensitivity(v: unknown): Sensitivity | null {
  const s = str(v)?.toLowerCase();
  return s === "high" || s === "medium" || s === "low" ? s : null;
}

export function classifySink(name: string | null, hint?: string | null): SinkType | null {
  const s = `${hint ?? ""} ${name ?? ""}`.toLowerCase();
  if (!s.trim()) return null;
  if (/\b(log|logs|logger|logging|console|print|stdout|stderr)\b/.test(s)) return "log";
  if (/\b(openai|anthropic|claude|gemini|llm|langchain|bedrock|cohere|mistral|ollama|vertex ai|ai)\b/.test(s)) return "ai_llm";
  if (/\b(analytics|segment|mixpanel|amplitude|google analytics|posthog|heap)\b/.test(s)) return "analytics";
  if (/\b(cookie|localstorage|local storage|sessionstorage)\b/.test(s)) return "cookie_storage";
  if (/\b(database|db|\w*sql|postgres\w*|mongo\w*|redis|dynamo\w*|orm|prisma|drizzle|sequelize|typeorm)\b/.test(s)) {
    return "database";
  }
  if (/\b(file|filesystem|fs|s3|blob|storage)\b/.test(s)) return "file";
  if (/\b(http|api|rest|graphql|grpc|fetch|axios|webhook)\b/.test(s)) return "api";
  if (/\b(third.?party|sdk|saas)\b/.test(s)) return "third_party";
  // A named vendor sink (e.g. "Adyen", "Ably") that matched nothing above.
  return name ? "third_party" : "other";
}

/**
 * Normalise a parsed SARIF document. Throws SarifError when it isn't SARIF.
 */
export function normaliseSarif(doc: unknown): NormalisedScan {
  if (!isObj(doc) || !Array.isArray(doc.runs)) throw new SarifError("Not a SARIF document (missing runs[])");
  if (doc.runs.length === 0) throw new SarifError("SARIF has no runs");

  let tool = "unknown";
  let toolVersion: string | null = null;
  const results: NormalisedResult[] = [];
  const elements = new Map<string, NormalisedElement>();

  for (const run of doc.runs) {
    if (!isObj(run)) continue;
    const driver = isObj(run.tool) && isObj(run.tool.driver) ? run.tool.driver : {};
    tool = clip(str(driver.name) ?? tool);
    toolVersion = str(driver.semanticVersion) ?? str(driver.version) ?? toolVersion;

    const rules = new Map<string, Obj>();
    arr(driver.rules).forEach((r, i) => {
      if (!isObj(r)) return;
      const id = str(r.id);
      if (id) rules.set(id, r);
      rules.set(`#${i}`, r);
    });

    for (const raw of arr(run.results)) {
      if (!isObj(raw)) continue;
      if (results.length >= MAX_RESULTS) throw new SarifError(`Too many results (max ${MAX_RESULTS})`);

      const ruleId =
        str(raw.ruleId) ??
        (isObj(raw.rule) ? str(raw.rule.id) : null) ??
        (typeof raw.ruleIndex === "number" ? str(rules.get(`#${raw.ruleIndex}`)?.id) : null) ??
        "unknown";
      const rule = rules.get(ruleId) ?? (typeof raw.ruleIndex === "number" ? rules.get(`#${raw.ruleIndex}`) : undefined);
      const props = isObj(raw.properties) ? raw.properties : undefined;
      const ruleProps = rule && isObj(rule.properties) ? rule.properties : undefined;

      const title = clip(
        str(isObj(rule?.shortDescription) ? rule.shortDescription.text : null) ??
          str(rule?.name) ??
          str(isObj(raw.message) ? raw.message.text : null) ??
          ruleId,
      );
      const severity =
        toSeverity(pick(props, "severity", "risk", "riskLevel")) ??
        toSeverity(pick(ruleProps, "severity", "problem.severity")) ??
        toSeverity(raw.level) ??
        "medium";

      const loc = arr(raw.locations)[0];
      const phys = isObj(loc) && isObj(loc.physicalLocation) ? loc.physicalLocation : undefined;
      const filePath = phys && isObj(phys.artifactLocation) ? str(phys.artifactLocation.uri) : null;
      const startLine = phys && isObj(phys.region) ? phys.region.startLine : undefined;

      const dataElements = toStrings(pick(props, "dataElements", "data_elements", "dataElement", "elements") ?? pick(ruleProps, "dataElements"));
      const sinkName = str(pick(props, "dataSink", "data_sink", "sink", "sinkName") ?? pick(ruleProps, "dataSink", "sink"));
      const sinkHint = str(pick(props, "sinkType", "sinkCategory", "dataSinkType"));
      const riskyV = pick(props, "risky", "isRisky");
      const safeV = pick(props, "safe", "isSafe");
      const flowType = str(pick(props, "dataflowType", "flowType", "riskStatus"));
      const risky: boolean | null =
        typeof riskyV === "boolean"
          ? riskyV
          : typeof safeV === "boolean"
            ? !safeV
            : flowType && /risk/i.test(flowType)
              ? true
              : flowType && /safe/i.test(flowType)
                ? false
                : null;

      results.push({
        ruleId: clip(ruleId),
        title,
        severity,
        filePath: filePath ? clip(filePath) : null,
        line: typeof startLine === "number" && startLine > 0 ? Math.floor(startLine) : null,
        dataElements,
        sinkName: sinkName ? clip(sinkName) : null,
        sinkType: classifySink(sinkName, sinkHint),
        risky,
      });

      // Element metadata: explicit objects in properties, else names from the result.
      const elementDetails = arr(pick(props, "dataElements", "data_elements"));
      for (const d of elementDetails) {
        if (!isObj(d)) continue;
        const name = str(d.name) ?? str(d.id);
        if (!name) continue;
        elements.set(name, {
          name: clip(name),
          sensitivity: toSensitivity(d.sensitivity),
          tags: toStrings(d.tags),
        });
      }
      for (const name of dataElements) {
        if (!elements.has(name)) {
          elements.set(name, { name, sensitivity: toSensitivity(pick(props, "sensitivity")), tags: [] });
        }
      }
    }
  }
  return { tool, toolVersion, results, elements: [...elements.values()] };
}
