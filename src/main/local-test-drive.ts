import { parseStatementCsv, type AmexAccount } from "../core";
import type { LocalTestDriveResult } from "../shared/ipc";

export interface LocalRuntimeHealth {
  storageState: "locked" | "unlocked" | "unavailable";
  mcpState: string;
  mcpExposure: string;
  toolCount: number;
}

/** Runs a synthetic parser dry-run entirely in memory. No account, statement,
 * transaction, token, or file is written to the encrypted store. */
export function runLocalTestDrive(health: LocalRuntimeHealth): LocalTestDriveResult {
  const importedAt = "2026-08-31T00:00:00.000Z";
  const account: AmexAccount = {
    id: "synthetic-test-account",
    displayName: "Synthetic Japan company card",
    legalEntityId: "synthetic-company",
    legalEntityName: "Example Company (synthetic)",
    country: "JP",
    currency: "JPY",
    accountClass: "company",
    businessPurpose: "Local onboarding test",
    collectionMethod: "statement_import",
    authorization: { state: "import_only", checkedAt: importedAt },
    active: true,
    createdAt: importedAt,
    updatedAt: importedAt
  };
  const bytes = Buffer.from("date,description,amount,country\n2026-08-30,Synthetic test purchase,1200,GB\n", "utf8");
  const parsed = parseStatementCsv(bytes, { account, importedAt }, { encoding: "utf8" });
  bytes.fill(0);
  const transaction = parsed.transactions[0];

  const checks = [
    {
      id: "storage",
      label: "Encrypted local store",
      passed: health.storageState === "unlocked",
      detail: health.storageState === "unlocked" ? "Unlocked for this Windows user." : `State: ${health.storageState}.`
    },
    {
      id: "loopback",
      label: "Private local MCP",
      passed: health.mcpState === "running" && health.mcpExposure === "loopback-only",
      detail:
        health.mcpState === "running" && health.mcpExposure === "loopback-only"
          ? "Running on this PC only; no public listener."
          : `State: ${health.mcpState}; exposure: ${health.mcpExposure}.`
    },
    {
      id: "tools",
      label: "Read-only ChatGPT boundary",
      passed: health.toolCount === 7,
      detail: `${health.toolCount} approved read-only tools are registered.`
    },
    {
      id: "import",
      label: "Synthetic Japan statement dry-run",
      passed:
        parsed.issues.every((issue) => issue.severity !== "error") &&
        parsed.transactions.length === 1 &&
        transaction?.amount === "-1200" &&
        transaction.merchantCountry === "GB",
      detail: "Parsed one synthetic JPY company-card row in memory and discarded it; no financial data was saved."
    }
  ];

  return { passed: checks.every((check) => check.passed), checks };
}
