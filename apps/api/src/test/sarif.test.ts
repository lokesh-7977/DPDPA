import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySink, normaliseSarif, SarifError } from "../domain/sarif.ts";
import { FLOWS, hounddogSarif } from "./fixtures/hounddog-sarif.ts";

test("normalises HoundDog SARIF: tool, elements, sinks, risky/safe, severity", () => {
  const scan = normaliseSarif(hounddogSarif([FLOWS.emailToLogs, FLOWS.aadhaarToOpenAI, FLOWS.phoneToDb]));
  assert.equal(scan.tool, "HoundDog.ai");
  assert.equal(scan.toolVersion, "4.2.0");
  assert.equal(scan.results.length, 3);

  const [logs, ai, db] = scan.results;
  assert.deepEqual(
    { sink: logs!.sinkType, risky: logs!.risky, sev: logs!.severity, file: logs!.filePath, line: logs!.line },
    { sink: "log", risky: true, sev: "low", file: "server/src/users.ts", line: 42 },
  );
  assert.equal(ai!.sinkType, "ai_llm");
  assert.equal(ai!.severity, "high");
  assert.equal(db!.sinkType, "database");
  assert.equal(db!.risky, false);

  const aadhaar = scan.elements.find((e) => e.name === "Aadhaar Number");
  assert.deepEqual(aadhaar, { name: "Aadhaar Number", sensitivity: "high", tags: ["PII"] });
});

test("never reads code snippets", () => {
  const scan = normaliseSarif(hounddogSarif([FLOWS.emailToLogs]));
  assert.equal(JSON.stringify(scan).includes("jane@example.com"), false);
});

test("generic SARIF without HoundDog properties still works", () => {
  const scan = normaliseSarif({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "other", rules: [{ id: "R1", name: "Some rule" }] } },
        results: [{ ruleIndex: 0, level: "note", message: { text: "x" } }],
      },
    ],
  });
  assert.equal(scan.results[0]!.ruleId, "R1");
  assert.equal(scan.results[0]!.severity, "low");
  assert.equal(scan.results[0]!.risky, null);
});

test("rejects non-SARIF input", () => {
  assert.throws(() => normaliseSarif({ hello: "world" }), SarifError);
  assert.throws(() => normaliseSarif({ runs: [] }), SarifError);
});

test("sink classification", () => {
  assert.equal(classifySink("Winston"), "third_party");
  assert.equal(classifySink("console.log"), "log");
  assert.equal(classifySink("Anthropic"), "ai_llm");
  assert.equal(classifySink("Mixpanel"), "analytics");
  assert.equal(classifySink(null), null);
});
