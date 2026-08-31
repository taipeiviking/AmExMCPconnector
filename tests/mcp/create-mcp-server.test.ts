import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFinanceMcpServer,
  type FinanceReadService
} from "../../src/mcp/create-mcp-server";
import { AuthorizationRequiredError } from "../../src/core/errors";

function createService(): FinanceReadService {
  const checkedAt = "2026-08-31T00:00:00.000Z";
  return {
    listAccounts: vi.fn().mockResolvedValue([{
      id: "acct-us-personal",
      displayName: "Personal",
      legalEntityId: "entity-owner",
      legalEntityName: "Owner",
      country: "US",
      currency: "USD",
      accountClass: "personal",
      businessPurpose: null,
      collectionMethod: "provider",
      authorization: { state: "authorized", checkedAt },
      active: true,
      createdAt: checkedAt,
      updatedAt: checkedAt
    }]),
    getAccountStatus: vi.fn().mockResolvedValue({
      accountId: "acct-us-personal",
      authorization: { state: "authorized", checkedAt },
      availableForQueries: true,
      recommendedAction: "none"
    }),
    listTransactions: vi.fn().mockResolvedValue({ transactions: [], nextCursor: null }),
    getStatement: vi.fn().mockResolvedValue({
      id: "statement-1",
      accountId: "acct-us-personal",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      openingBalance: { amount: "0.00", currency: "USD" },
      closingBalance: { amount: "10.00", currency: "USD" },
      transactionIds: [],
      importedAt: checkedAt,
      sourceFileFingerprint: "internal-statement-fingerprint"
    }),
    getPortfolioReport: vi.fn().mockResolvedValue({
      portfolioId: "owner-main",
      portfolioName: "Owner portfolio",
      accountIds: ["acct-us-personal"],
      totals: [],
      generatedAt: checkedAt
    }),
    listFraudAlerts: vi.fn().mockResolvedValue([]),
    explainAlert: vi.fn().mockResolvedValue({
      alertId: "alert-1",
      title: "Review transaction",
      summary: "A local rule matched.",
      evidence: [],
      limitations: ["Review-only."],
      nextStep: "review_transaction"
    })
  };
}

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(service: FinanceReadService) {
  const server = createFinanceMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("finance MCP server", () => {
  it("publishes exactly the seven approved read-only tools", async () => {
    const { client } = await connect(createService());
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "explain_alert",
        "get_account_status",
        "get_portfolio_report",
        "get_statement",
        "list_accounts",
        "list_fraud_alerts",
        "list_transactions"
      ].sort()
    );
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      });
    }
  });

  it("requires a portfolio selector before listing accounts", async () => {
    const service = createService();
    const { client } = await connect(service);

    const invalid = await client.callTool({ name: "list_accounts", arguments: {} });

    expect(invalid.isError).toBe(true);
    expect(service.listAccounts).not.toHaveBeenCalled();
  });

  it("maps an explicit account transaction target without broadening it", async () => {
    const service = createService();
    const { client } = await connect(service);

    const result = await client.callTool({
      name: "list_transactions",
      arguments: {
        target: { kind: "account", account_id: "acct-jp-company" },
        from_date: "2026-01-01",
        to_date: "2026-01-31",
        limit: 25
      }
    });

    expect(result.isError).not.toBe(true);
    expect(service.listTransactions).toHaveBeenCalledWith({
      target: { kind: "account", accountId: "acct-jp-company" },
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 25
    });
  });

  it("allowlists transaction output fields and excludes internal lineage identifiers", async () => {
    const service = createService();
    vi.mocked(service.listTransactions).mockResolvedValue({
      transactions: [{
        id: "txn-safe",
        externalId: "provider-external-secret",
        source: {
          accountId: "acct-us-personal",
          legalEntityId: "entity-owner",
          legalEntityName: "Owner",
          country: "US",
          accountClass: "personal",
          accountCurrency: "USD",
          businessPurpose: null
        },
        postedAt: "2026-08-30",
        description: "Merchant",
        amount: "-12.34",
        currency: "USD",
        categoryId: null,
        memo: null,
        importFingerprint: "internal-import-fingerprint",
        importedAt: "2026-08-31T00:00:00.000Z"
      }],
      nextCursor: null
    });
    const { client } = await connect(service);

    const result = await client.callTool({
      name: "list_transactions",
      arguments: { target: { kind: "account", account_id: "acct-us-personal" } }
    });

    const wire = JSON.stringify(result.content);
    expect(result.isError).not.toBe(true);
    expect(wire).toContain("txn-safe");
    expect(wire).toContain("entity-owner");
    expect(wire).not.toContain("provider-external-secret");
    expect(wire).not.toContain("internal-import-fingerprint");
    expect(wire).not.toContain("importedAt");
  });

  it("does not expose statement source-file fingerprints", async () => {
    const service = createService();
    const { client } = await connect(service);

    const result = await client.callTool({
      name: "get_statement",
      arguments: { target: { kind: "account", account_id: "acct-us-personal" }, statement_id: "statement-1" }
    });

    const wire = JSON.stringify(result.content);
    expect(result.isError).not.toBe(true);
    expect(wire).toContain("statement-1");
    expect(wire).not.toContain("internal-statement-fingerprint");
    expect(wire).not.toContain("sourceFileFingerprint");
  });

  it("returns authorization failures as bounded tool errors", async () => {
    const service = createService();
    vi.mocked(service.getStatement).mockRejectedValue(
      new AuthorizationRequiredError("acct-us-personal", "provider-secret-detail")
    );
    const { client } = await connect(service);

    const result = await client.callTool({
      name: "get_statement",
      arguments: { target: { kind: "account", account_id: "acct-us-personal" }, statement_id: "statement-1" }
    });

    expect(result.isError).toBe(true);
    const wire = JSON.stringify(result.content);
    expect(wire).toContain("REAUTHORIZATION_REQUIRED");
    expect(wire).toContain("requires reauthorization");
    expect(wire).not.toContain("acct-us-personal");
    expect(wire).not.toContain("provider-secret-detail");
  });

  it("never returns unexpected exception messages to the MCP caller", async () => {
    const service = createService();
    vi.mocked(service.getPortfolioReport).mockRejectedValue(
      new Error("database path C:\\Users\\owner\\private and token do-not-disclose")
    );
    const { client } = await connect(service);

    const result = await client.callTool({
      name: "get_portfolio_report",
      arguments: { target: { kind: "portfolio", portfolio_id: "owner-main" } }
    });

    const wire = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(wire).toContain("INTERNAL_ERROR");
    expect(wire).not.toContain("private");
    expect(wire).not.toContain("do-not-disclose");
  });
});
