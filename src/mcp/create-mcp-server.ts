import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FinanceCoreError } from "../core/errors";

export type FinanceTarget =
  | { kind: "account"; accountId: string }
  | { kind: "portfolio"; portfolioId: string };

export interface FinanceReadService {
  listAccounts(input: {
    portfolioId: string;
    country?: "US" | "JP";
    accountClass?: "personal" | "company";
  }): Promise<unknown>;
  getAccountStatus(input: { accountId: string }): Promise<unknown>;
  listTransactions(input: {
    target: FinanceTarget;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<unknown>;
  getStatement(input: { accountId: string; statementId: string }): Promise<unknown>;
  getPortfolioReport(input: { portfolioId: string; from?: string; to?: string }): Promise<unknown>;
  listFraudAlerts(input: {
    target: FinanceTarget;
    status?: "open" | "reviewed" | "dismissed";
    limit?: number;
  }): Promise<unknown>;
  explainAlert(input: { target: FinanceTarget; alertId: string }): Promise<unknown>;
}

const id = z.string().trim().min(1).max(128);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO calendar date (YYYY-MM-DD).");
const accountTarget = z.object({ kind: z.literal("account"), account_id: id });
const portfolioTarget = z.object({ kind: z.literal("portfolio"), portfolio_id: id });
const target = z.discriminatedUnion("kind", [
  accountTarget,
  portfolioTarget
]);
const isoInstant = z.string().datetime({ offset: true });
const moneyAmount = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const moneyRecord = z.object({ amount: moneyAmount, currency: z.string().min(3).max(3) });
const authorizationRecord = z.object({
  state: z.string(),
  checkedAt: isoInstant,
  expiresAt: isoInstant.optional()
});
const accountRecord = z.object({
  id,
  displayName: z.string(),
  legalEntityId: id,
  legalEntityName: z.string(),
  country: z.enum(["US", "JP"]),
  currency: z.string().min(3).max(3),
  accountClass: z.enum(["personal", "company"]),
  businessPurpose: z.string().nullable(),
  collectionMethod: z.enum(["provider", "statement_import"]),
  authorization: authorizationRecord,
  active: z.boolean()
});
const accountStatusRecord = z.object({
  accountId: id,
  authorization: authorizationRecord,
  availableForQueries: z.boolean(),
  recommendedAction: z.enum(["none", "reauthorize", "wait", "check_provider"])
});
const transactionRecord = z.object({
  id,
  source: z.object({
    accountId: id,
    legalEntityId: id,
    legalEntityName: z.string(),
    country: z.enum(["US", "JP"]),
    accountClass: z.enum(["personal", "company"]),
    accountCurrency: z.string().min(3).max(3),
    businessPurpose: z.string().nullable()
  }),
  postedAt: date,
  authorizedAt: isoInstant.optional(),
  description: z.string(),
  merchantName: z.string().optional(),
  merchantCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  amount: moneyAmount,
  currency: z.string().min(3).max(3),
  categoryId: z.string().nullable(),
  memo: z.string().nullable(),
  statementId: id.optional()
});
const transactionPageRecord = z.object({
  transactions: z.array(transactionRecord),
  nextCursor: z.string().nullable()
});
const statementRecord = z.object({
  id,
  accountId: id,
  periodStart: date,
  periodEnd: date,
  openingBalance: moneyRecord,
  closingBalance: moneyRecord,
  transactionIds: z.array(id)
});
const portfolioReportRecord = z.object({
  portfolioId: id,
  portfolioName: z.string(),
  accountIds: z.array(id),
  periodStart: date.optional(),
  periodEnd: date.optional(),
  totals: z.array(z.object({
    currency: z.string().min(3).max(3),
    inflows: moneyAmount,
    outflows: moneyAmount,
    net: moneyAmount,
    transactionCount: z.number().int().nonnegative()
  })),
  generatedAt: isoInstant
});
const fraudAlertRecord = z.object({
  id,
  accountId: id,
  transactionIds: z.array(id),
  kind: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  status: z.string(),
  title: z.string(),
  reviewOnly: z.literal(true),
  detectedAt: isoInstant
});
const alertExplanationRecord = z.object({
  alertId: id,
  title: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  limitations: z.array(z.string()),
  nextStep: z.literal("review_transaction")
});

const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

export function createFinanceMcpServer(service: FinanceReadService): McpServer {
  const server = new McpServer(
    {
      name: "amex-local-finance-connector",
      title: "Amex Local Finance Connector",
      version: "0.1.0",
      description: "Read-only, account-scoped access to owner-controlled local American Express financial data."
    },
    {
      instructions:
        "Every call must use the owner-provided account_id or portfolio_id. Never infer, broaden, or combine targets. " +
        "The server cannot authorize accounts, import files, create exports, pay, transfer, dispute, post to accounting systems, or change card/account settings."
    }
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts in one portfolio",
      description:
        "List only the accounts assigned to the explicitly selected local portfolio, including source attribution and current stored authorization state.",
      inputSchema: {
        target: portfolioTarget.describe("Explicit owner-visible local portfolio target."),
        country: z.enum(["US", "JP"]).optional(),
        account_class: z.enum(["personal", "company"]).optional()
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected, country, account_class }) =>
      callReadOnly(selected, () =>
        service.listAccounts({
          portfolioId: selected.portfolio_id,
          ...(country ? { country } : {}),
          ...(account_class ? { accountClass: account_class } : {})
        }),
        presentAccounts
      )
  );

  server.registerTool(
    "get_account_status",
    {
      title: "Get one account status",
      description:
        "Return stored authorization and local query-readiness status for one explicit account. This tool cannot sync or start authorization.",
      inputSchema: { target: accountTarget.describe("Explicit owner-visible local account target.") },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected }) =>
      callReadOnly(selected, () => service.getAccountStatus({ accountId: selected.account_id }), presentAccountStatus)
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List scoped transactions",
      description:
        "List normalized transactions from exactly one selected account or portfolio. Source account, legal entity, country, currency, class, and business-purpose metadata remain attached.",
      inputSchema: {
        target,
        from_date: date.optional(),
        to_date: date.optional(),
        cursor: z.string().max(512).optional(),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected, from_date, to_date, cursor, limit }) =>
      callReadOnly(selected, () =>
        service.listTransactions({
          target: toCoreTarget(selected),
          ...(from_date ? { from: from_date } : {}),
          ...(to_date ? { to: to_date } : {}),
          ...(cursor ? { cursor } : {}),
          limit
        }),
        presentTransactions
      )
  );

  server.registerTool(
    "get_statement",
    {
      title: "Get one statement",
      description:
        "Return minimized period, balance, and transaction-count data for one locally stored statement scoped to its owning account.",
      inputSchema: {
        target: accountTarget,
        statement_id: id
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected, statement_id }) =>
      callReadOnly(
        selected,
        () => service.getStatement({ accountId: selected.account_id, statementId: statement_id }),
        presentStatement
      )
  );

  server.registerTool(
    "get_portfolio_report",
    {
      title: "Get one portfolio report",
      description:
        "Return owner-controlled totals for one explicit portfolio, separated by original currency without implicit FX conversion.",
      inputSchema: {
        target: portfolioTarget,
        from_date: date.optional(),
        to_date: date.optional()
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected, from_date, to_date }) =>
      callReadOnly(selected, () =>
        service.getPortfolioReport({
          portfolioId: selected.portfolio_id,
          ...(from_date ? { from: from_date } : {}),
          ...(to_date ? { to: to_date } : {})
        }),
        presentPortfolioReport
      )
  );

  server.registerTool(
    "list_fraud_alerts",
    {
      title: "List review-only alerts",
      description:
        "List local anomaly/fraud-review alerts for exactly one account or portfolio. Alerts are informational and never file disputes or control cards.",
      inputSchema: {
        target,
        status: z.enum(["open", "reviewed", "dismissed"]).optional(),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected, status, limit }) =>
      callReadOnly(selected, () =>
        service.listFraudAlerts({
          target: toCoreTarget(selected),
          ...(status ? { status } : {}),
          limit
        }),
        presentFraudAlerts
      )
  );

  server.registerTool(
    "explain_alert",
    {
      title: "Explain one review alert",
      description:
        "Explain the local rules, evidence, and limitations behind one alert within an explicit account or portfolio target. It does not make a fraud determination.",
      inputSchema: {
        target,
        alert_id: id
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ target: selected, alert_id }) =>
      callReadOnly(
        selected,
        () => service.explainAlert({ target: toCoreTarget(selected), alertId: alert_id }),
        presentAlertExplanation
      )
  );

  return server;
}

function toCoreTarget(
  selected:
    | { kind: "account"; account_id: string }
    | { kind: "portfolio"; portfolio_id: string }
): FinanceTarget {
  return selected.kind === "account"
    ? { kind: "account", accountId: selected.account_id }
    : { kind: "portfolio", portfolioId: selected.portfolio_id };
}

type WireTarget =
  | { kind: "account"; account_id: string }
  | { kind: "portfolio"; portfolio_id: string };

async function callReadOnly(
  selected: WireTarget,
  operation: () => Promise<unknown>,
  present: (result: unknown) => unknown
): Promise<CallToolResult> {
  const requestId = randomUUID();
  try {
    const result = await operation();
    const data = present(result);
    const response = {
      schema_version: "2026-08-31",
      request_id: requestId,
      target: selected,
      generated_at: new Date().toISOString(),
      partial: false,
      freshness: [],
      warnings: [],
      data,
      next_cursor: extractNextCursor(result)
    };
    return {
      structuredContent: response,
      content: [
        {
          type: "text",
          text: JSON.stringify(response, jsonReplacer, 2)
        }
      ]
    };
  } catch (error) {
    const publicError = toPublicError(error);
    const response = {
      schema_version: "2026-08-31",
      request_id: requestId,
      error: publicError
    };
    return {
      isError: true,
      structuredContent: response,
      content: [
        {
          type: "text",
          text: JSON.stringify(response)
        }
      ]
    };
  }
}

function presentAccounts(result: unknown): unknown {
  const accounts = z.array(accountRecord).parse(result);
  return {
    accounts: accounts.map((account) => ({
      account_id: account.id,
      display_name: account.displayName,
      legal_entity: {
        legal_entity_id: account.legalEntityId,
        display_name: account.legalEntityName
      },
      country: account.country,
      currency: account.currency,
      account_class: account.accountClass,
      business_purpose_default: account.businessPurpose,
      source_kind: account.collectionMethod === "provider" ? "us_provider" : "jp_statement_import",
      enabled: account.active,
      authorization: {
        state: account.authorization.state,
        checked_at: account.authorization.checkedAt,
        expires_at: account.authorization.expiresAt ?? null
      }
    }))
  };
}

function presentAccountStatus(result: unknown): unknown {
  const status = accountStatusRecord.parse(result);
  return {
    account_id: status.accountId,
    authorization: {
      state: status.authorization.state,
      checked_at: status.authorization.checkedAt,
      expires_at: status.authorization.expiresAt ?? null
    },
    available_for_queries: status.availableForQueries,
    recommended_action: status.recommendedAction
  };
}

function presentTransactions(result: unknown): unknown {
  const page = transactionPageRecord.parse(result);
  return {
    transactions: page.transactions.map((transaction) => ({
      transaction_id: transaction.id,
      account: {
        account_id: transaction.source.accountId,
        legal_entity_id: transaction.source.legalEntityId,
        legal_entity_name: transaction.source.legalEntityName,
        country: transaction.source.country,
        account_class: transaction.source.accountClass,
        account_currency: transaction.source.accountCurrency
      },
      statement_id: transaction.statementId ?? null,
      posted_at: transaction.postedAt,
      authorized_at: transaction.authorizedAt ?? null,
      direction: isNegativeNonZero(transaction.amount) ? "debit" : "credit",
      amount: { amount: transaction.amount, currency: transaction.currency },
      description: transaction.description,
      merchant: transaction.merchantName ?? null,
      merchant_country: transaction.merchantCountry ?? null,
      category_id: transaction.categoryId,
      business_purpose: transaction.source.businessPurpose,
      memo: transaction.memo
    }))
  };
}

function presentStatement(result: unknown): unknown {
  const statement = statementRecord.parse(result);
  return {
    statement_id: statement.id,
    account_id: statement.accountId,
    period: { start_date: statement.periodStart, end_date: statement.periodEnd },
    opening_balance: statement.openingBalance,
    closing_balance: statement.closingBalance,
    transaction_count: statement.transactionIds.length
  };
}

function presentPortfolioReport(result: unknown): unknown {
  const report = portfolioReportRecord.parse(result);
  return {
    portfolio: { portfolio_id: report.portfolioId, display_name: report.portfolioName },
    account_ids: report.accountIds,
    period: {
      start_date: report.periodStart ?? null,
      end_date: report.periodEnd ?? null
    },
    totals: report.totals.map((total) => ({
      currency: total.currency,
      inflows: total.inflows,
      outflows: total.outflows,
      net: total.net,
      transaction_count: total.transactionCount
    })),
    generated_at: report.generatedAt
  };
}

function presentFraudAlerts(result: unknown): unknown {
  const alerts = z.array(fraudAlertRecord).parse(result);
  return {
    alerts: alerts.map((alert) => ({
      alert_id: alert.id,
      account_id: alert.accountId,
      related_transaction_ids: alert.transactionIds,
      kind: alert.kind,
      severity: alert.severity,
      review_state: alert.status,
      title: alert.title,
      detected_at: alert.detectedAt,
      review_only: alert.reviewOnly
    }))
  };
}

function presentAlertExplanation(result: unknown): unknown {
  const explanation = alertExplanationRecord.parse(result);
  return {
    alert_id: explanation.alertId,
    title: explanation.title,
    summary: explanation.summary,
    evidence: explanation.evidence,
    limitations: explanation.limitations,
    next_step: explanation.nextStep,
    review_only: true
  };
}

function isNegativeNonZero(amount: string): boolean {
  return amount.startsWith("-") && !/^-0(?:\.0+)?$/u.test(amount);
}

function extractNextCursor(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("nextCursor" in result)) return null;
  const cursor = (result as { nextCursor?: unknown }).nextCursor;
  return typeof cursor === "string" ? cursor : null;
}

interface PublicToolError {
  code: string;
  message: string;
  retryable: boolean;
  owner_action: string;
}

function toPublicError(error: unknown): PublicToolError {
  if (!(error instanceof FinanceCoreError)) {
    return {
      code: "INTERNAL_ERROR",
      message: "The local read-only query could not be completed.",
      retryable: false,
      owner_action: "open_desktop_app"
    };
  }

  switch (error.code) {
    case "REAUTHORIZATION_REQUIRED":
      return {
        code: "REAUTHORIZATION_REQUIRED",
        message: "The selected account requires reauthorization in the desktop app.",
        retryable: false,
        owner_action: "reauthorize_in_desktop_app"
      };
    case "ACCOUNT_UNAVAILABLE":
      return {
        code: "ACCOUNT_DISABLED",
        message: "The selected account is unavailable for financial queries.",
        retryable: false,
        owner_action: "open_desktop_app"
      };
    case "NOT_FOUND":
      return {
        code: "TARGET_NOT_FOUND",
        message: "The requested record is unavailable within the selected target.",
        retryable: false,
        owner_action: "review_target"
      };
    case "VALIDATION_ERROR":
      return {
        code: "INVALID_REQUEST",
        message: "The request or local record state is invalid.",
        retryable: false,
        owner_action: "review_query"
      };
    default:
      return {
        code: "INTERNAL_ERROR",
        message: "The local read-only query could not be completed.",
        retryable: false,
        owner_action: "open_desktop_app"
      };
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
