import { describe, expect, it, vi } from "vitest";
import { PlaidApiClient, type PlaidEnvironment } from "../../src/integrations/plaid-api-client";
import { PlaidHostedLinkProvider } from "../../src/integrations/plaid-hosted-link-provider";
import {
  PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES,
  PLAID_SANDBOX_TEST_INSTITUTION_NAMES,
  plaidInstitutionPolicyForEnvironment,
} from "../../src/integrations/plaid-institution-policy";
import { PlaidReadOnlyFinancialProvider } from "../../src/integrations/plaid-read-only-financial-provider";
import { assertPlaidAllowedInstitution } from "../../src/integrations/plaid-response-mapping";
import type { ProviderTokenSet, ProviderTokenStore } from "../../src/integrations/provider-types";
import type { SecretReferenceResolver } from "../../src/security/secret-reference";

const NOW = new Date("2026-09-07T00:00:00.000Z");
const LOCAL_ACCOUNT_ID = "local-personal-card";
const PROVIDER_ACCOUNT_ID = "plaid-card-account";
const ITEM_ID = "plaid-item";
const SANDBOX_INSTITUTION_ID = "ins_109508";

describe("Plaid API transport", () => {
  it("uses protected references, fixed authentication headers, and no credential fields in the body", async () => {
    const resolved: Uint8Array[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).toString())
        .toBe("https://sandbox.plaid.com/item/get");
      const headers = new Headers(init?.headers);
      expect(headers.get("PLAID-CLIENT-ID")).toBe("test-client-id");
      expect(headers.get("PLAID-SECRET")).toBe("test-secret");
      expect(headers.get("Plaid-Version")).toBe("2020-09-14");
      expect(JSON.parse(String(init?.body))).toEqual({ access_token: "test-access-token" });
      expect(String(init?.body)).not.toContain("test-client-id");
      expect(String(init?.body)).not.toContain("test-secret");
      return Response.json(itemResponse());
    });
    const client = new PlaidApiClient(
      apiConfiguration("sandbox"),
      secretResolver(resolved),
      fetchImpl as typeof fetch,
    );

    await client.post("/item/get", { access_token: "test-access-token" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((secret) => secret.every((byte) => byte === 0))).toBe(true);
  });
});

describe("Plaid institution policy", () => {
  it("uses exact American Express production names and an explicit synthetic Sandbox identity", () => {
    const production = plaidInstitutionPolicyForEnvironment("production");
    const sandbox = plaidInstitutionPolicyForEnvironment("sandbox");
    expect(production).toMatchObject({ kind: "american-express-production", synthetic: false });
    expect([...production.allowedExactNames]).toEqual([...PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES]);
    expect(sandbox).toMatchObject({ kind: "plaid-sandbox-test", synthetic: true });
    expect([...sandbox.allowedExactNames]).toEqual([...PLAID_SANDBOX_TEST_INSTITUTION_NAMES]);
  });

  it("binds the actual Item institution ID to lookup output without hard-coding a production ID", () => {
    expect(() => assertPlaidAllowedInstitution(
      institutionResponse("a-current-plaid-id", "American Express"),
      "a-current-plaid-id",
      new Set(PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES),
    )).not.toThrow();
    expect(() => assertPlaidAllowedInstitution(
      institutionResponse("different-id", "American Express"),
      "the-item-id",
      new Set(PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES),
    )).toThrow(/institution/iu);
    expect(() => assertPlaidAllowedInstitution(
      institutionResponse("the-item-id", "Another Issuer"),
      "the-item-id",
      new Set(PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES),
    )).toThrow(/institution/iu);
  });
});

describe("Plaid Hosted Link provider", () => {
  it("creates a Transactions-only Hosted Link and persists one validated synthetic Sandbox card", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = plaidFetchRouter("sandbox", calls, {
      "/link/token/create": hostedLinkCreateResponse("sandbox"),
      "/link/token/get": hostedLinkSuccessResponse(),
      "/item/public_token/exchange": {
        access_token: "access-sandbox-token",
        item_id: ITEM_ID,
        request_id: "exchange-request",
      },
      "/item/get": itemResponse(),
      "/institutions/get_by_id": institutionResponse(
        SANDBOX_INSTITUTION_ID,
        "First Platypus Bank",
      ),
      "/accounts/get": accountsResponse(),
    });
    const store = new MemoryTokenStore();
    const provider = new PlaidHostedLinkProvider(
      { clientName: "Amex Local Connector" },
      new PlaidApiClient(apiConfiguration("sandbox"), secretResolver(), fetchImpl),
      store,
      { now: () => NOW },
    );

    const started = await provider.beginHostedConsent(LOCAL_ACCOUNT_ID);
    const completed = await provider.completeHostedConsent(LOCAL_ACCOUNT_ID);

    expect(started).toMatchObject({
      providerId: "plaid",
      localAccountId: LOCAL_ACCOUNT_ID,
      authorizationUrl: "https://secure.plaid.com/hl/test-session",
    });
    expect(provider.institutionPolicy).toMatchObject({ kind: "plaid-sandbox-test", synthetic: true });
    expect(completed).toMatchObject({
      authorization: { state: "authorized", localAccountId: LOCAL_ACCOUNT_ID },
      account: {
        id: PROVIDER_ACCOUNT_ID,
        country: "US",
        currency: "USD",
        account_class: "personal",
        last_four: "1000",
      },
      itemId: ITEM_ID,
    });
    expect(await store.text("plaid", LOCAL_ACCOUNT_ID)).toBe("access-sandbox-token");
    const create = calls.find((call) => call.path === "/link/token/create")!;
    expect(create.body).toMatchObject({
      client_name: "Amex Local Connector",
      country_codes: ["US"],
      products: ["transactions"],
      account_filters: { credit: { account_subtypes: ["credit card", "charge card"] } },
    });
    expect(create.body).not.toHaveProperty("institution_id");
  });

  it("rejects a non-Amex production Item, removes it, and never stores its access token", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = plaidFetchRouter("production", calls, {
      "/link/token/create": hostedLinkCreateResponse("production"),
      "/link/token/get": hostedLinkSuccessResponse(),
      "/item/public_token/exchange": {
        access_token: "access-production-token",
        item_id: ITEM_ID,
      },
      "/item/get": itemResponse("live-institution-id"),
      "/institutions/get_by_id": institutionResponse("live-institution-id", "Another Issuer"),
      "/item/remove": { request_id: "remove-request" },
    });
    const store = new MemoryTokenStore();
    const provider = new PlaidHostedLinkProvider(
      {
        clientName: "Amex Local Connector",
        redirectUri: "https://connect.example.test/plaid-oauth",
      },
      new PlaidApiClient(apiConfiguration("production"), secretResolver(), fetchImpl),
      store,
      { now: () => NOW },
    );

    await provider.beginHostedConsent(LOCAL_ACCOUNT_ID);
    await expect(provider.completeHostedConsent(LOCAL_ACCOUNT_ID)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });

    expect(provider.institutionPolicy).toMatchObject({
      kind: "american-express-production",
      synthetic: false,
    });
    expect(calls.map((call) => call.path)).toContain("/item/remove");
    expect(calls.map((call) => call.path)).not.toContain("/accounts/get");
    expect(await store.get("plaid", LOCAL_ACCOUNT_ID)).toBeUndefined();
  });

  it("uses update mode for an existing Item without exchanging a token or creating a duplicate Item", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = plaidFetchRouter("sandbox", calls, {
      "/item/get": itemResponse(),
      "/institutions/get_by_id": institutionResponse(
        SANDBOX_INSTITUTION_ID,
        "First Platypus Bank",
      ),
      "/link/token/create": hostedLinkCreateResponse("sandbox"),
      "/link/token/get": hostedLinkUpdateSuccessResponse(),
      "/accounts/get": accountsResponse(),
    });
    const store = new MemoryTokenStore();
    await store.put("plaid", LOCAL_ACCOUNT_ID, {
      accessToken: Buffer.from("unchanged-access-token", "utf8"),
      tokenType: "Bearer",
      scopes: ["transactions"],
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    const provider = new PlaidHostedLinkProvider(
      { clientName: "Amex Local Connector" },
      new PlaidApiClient(apiConfiguration("sandbox"), secretResolver(), fetchImpl),
      store,
      { now: () => NOW },
    );

    await provider.beginHostedConsent(LOCAL_ACCOUNT_ID, PROVIDER_ACCOUNT_ID);
    const completed = await provider.completeHostedConsent(LOCAL_ACCOUNT_ID);

    const create = calls.find((call) => call.path === "/link/token/create")!;
    expect(create.body).toMatchObject({ access_token: "unchanged-access-token" });
    expect(create.body).not.toHaveProperty("products");
    expect(create.body).not.toHaveProperty("transactions");
    expect(create.body).not.toHaveProperty("account_filters");
    expect(calls.map((call) => call.path)).not.toContain("/item/public_token/exchange");
    expect(calls.map((call) => call.path)).not.toContain("/item/remove");
    expect(completed).toMatchObject({
      itemId: ITEM_ID,
      account: { id: PROVIDER_ACCOUNT_ID },
      authorization: { state: "authorized" },
    });
    expect(await store.text("plaid", LOCAL_ACCOUNT_ID)).toBe("unchanged-access-token");
  });

  it("enforces Plaid's 30-character client_name limit", () => {
    const api = new PlaidApiClient(apiConfiguration("sandbox"), secretResolver(), vi.fn() as typeof fetch);
    expect(() => new PlaidHostedLinkProvider(
      { clientName: "x".repeat(31) },
      api,
      new MemoryTokenStore(),
    )).toThrow(/client name/iu);
  });

  it("requires an allowlisted HTTPS OAuth redirect in production", () => {
    const api = new PlaidApiClient(apiConfiguration("production"), secretResolver(), vi.fn() as typeof fetch);
    expect(() => new PlaidHostedLinkProvider(
      { clientName: "Amex Local Connector" },
      api,
      new MemoryTokenStore(),
    )).toThrow(/redirect URI/iu);
  });
});

describe("Plaid read-only financial provider", () => {
  it("revalidates the Item, exact account, and institution before mapping posted USD transactions", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = plaidFetchRouter("sandbox", calls, {
      "/item/get": itemResponse(),
      "/institutions/get_by_id": institutionResponse(
        SANDBOX_INSTITUTION_ID,
        "First Platypus Bank",
      ),
      "/accounts/get": accountsResponse(),
      "/transactions/get": transactionsResponse(),
    });
    const provider = new PlaidReadOnlyFinancialProvider(
      { maximumPageSize: 100, now: () => NOW },
      new PlaidApiClient(apiConfiguration("sandbox"), secretResolver(), fetchImpl),
      { getAccessToken: async () => Buffer.from("access-sandbox-token", "utf8") },
    );
    const selection = { localAccountId: LOCAL_ACCOUNT_ID, providerAccountId: PROVIDER_ACCOUNT_ID };

    const result = await provider.listTransactions(selection, {
      from: "2026-09-01",
      to: "2026-09-07",
      pageSize: 50,
    });
    const statements = await provider.listStatements(selection);

    expect(result.data).toEqual({
      profile: "normalized_v1",
      account_id: PROVIDER_ACCOUNT_ID,
      transactions: [{
        id: "transaction-1",
        posted_at: "2026-09-02",
        authorized_at: "2026-09-01T23:30:00.000Z",
        description: "Coffee shop",
        merchant_name: "Coffee shop",
        merchant_country: "US",
        amount: "-42.10",
        currency: "USD",
        category_id: "FOOD_AND_DRINK_COFFEE",
        memo: "COFFEE SHOP 123",
      }],
      next_cursor: null,
    });
    expect(statements.data).toEqual({
      profile: "normalized_v1",
      account_id: PROVIDER_ACCOUNT_ID,
      statements: [],
    });
    const transactionCall = calls.find((call) => call.path === "/transactions/get")!;
    expect(transactionCall.body).toMatchObject({
      start_date: "2026-09-01",
      end_date: "2026-09-07",
      options: { account_ids: [PROVIDER_ACCOUNT_ID], count: 50, offset: 0 },
    });
    expect(calls.filter((call) => call.path === "/institutions/get_by_id")).toHaveLength(2);
  });
});

function apiConfiguration(environment: PlaidEnvironment) {
  return {
    environment,
    clientIdReference: "test:client-id",
    secretReference: "test:secret",
  } as const;
}

function secretResolver(resolved: Uint8Array[] = []): SecretReferenceResolver {
  return {
    supports: (reference) => reference.startsWith("test:"),
    resolve: async (reference) => {
      const bytes = Buffer.from(reference.endsWith("client-id") ? "test-client-id" : "test-secret", "utf8");
      resolved.push(bytes);
      return bytes;
    },
  };
}

function plaidFetchRouter(
  environment: PlaidEnvironment,
  calls: Array<{ path: string; body: Record<string, unknown> }>,
  responses: Readonly<Record<string, unknown>>,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(`https://${environment}.plaid.com`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path: url.pathname, body });
    const response = responses[url.pathname];
    if (response === undefined) throw new Error(`Unexpected Plaid request: ${url.pathname}`);
    return Response.json(response);
  }) as typeof fetch;
}

function hostedLinkCreateResponse(environment: PlaidEnvironment) {
  return {
    link_token: `link-${environment}-token`,
    hosted_link_url: "https://secure.plaid.com/hl/test-session",
    expiration: "2026-09-07T01:00:00.000Z",
    request_id: "link-create-request",
  };
}

function hostedLinkSuccessResponse() {
  return {
    link_sessions: [{
      finished_at: "2026-09-07T00:01:00.000Z",
      results: {
        item_add_results: [{
          public_token: "public-test-token",
          accounts: [{
            id: PROVIDER_ACCOUNT_ID,
            mask: "1000",
            name: "Plaid Credit Card",
            type: "credit",
            subtype: "credit card",
          }],
        }],
      },
    }],
    request_id: "link-get-request",
  };
}

function hostedLinkUpdateSuccessResponse() {
  return {
    link_sessions: [{
      finished_at: "2026-09-07T00:01:00.000Z",
      on_success: null,
      on_exit: null,
      results: { item_add_results: [] },
    }],
    request_id: "link-update-get-request",
  };
}

function itemResponse(institutionId = SANDBOX_INSTITUTION_ID) {
  return {
    item: {
      item_id: ITEM_ID,
      institution_id: institutionId,
      consent_expiration_time: null,
      error: null,
    },
    request_id: "item-request",
  };
}

function institutionResponse(institutionId: string, name: string) {
  return {
    institution: {
      institution_id: institutionId,
      name,
      country_codes: ["US"],
      products: ["transactions"],
    },
    request_id: "institution-request",
  };
}

function cardAccount() {
  return {
    account_id: PROVIDER_ACCOUNT_ID,
    balances: {
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    mask: "1000",
    name: "Plaid Credit Card",
    official_name: "Plaid Credit Card",
    type: "credit",
    subtype: "credit card",
  };
}

function accountsResponse() {
  return { accounts: [cardAccount()], request_id: "accounts-request" };
}

function transactionsResponse() {
  return {
    accounts: [cardAccount()],
    transactions: [{
      account_id: PROVIDER_ACCOUNT_ID,
      transaction_id: "transaction-1",
      amount: 42.1,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
      date: "2026-09-02",
      authorized_datetime: "2026-09-01T23:30:00.000Z",
      name: "Coffee shop",
      merchant_name: "Coffee shop",
      original_description: "COFFEE SHOP 123",
      pending: false,
      personal_finance_category: {
        primary: "FOOD_AND_DRINK",
        detailed: "FOOD_AND_DRINK_COFFEE",
      },
      location: { country: "us" },
    }],
    total_transactions: 1,
    request_id: "transactions-request",
  };
}

class MemoryTokenStore implements ProviderTokenStore {
  private readonly values = new Map<string, ProviderTokenSet>();

  public async get(providerId: string, localAccountId: string): Promise<ProviderTokenSet | undefined> {
    const value = this.values.get(`${providerId}:${localAccountId}`);
    return value === undefined ? undefined : cloneTokenSet(value);
  }

  public async put(providerId: string, localAccountId: string, tokens: ProviderTokenSet): Promise<void> {
    this.values.set(`${providerId}:${localAccountId}`, cloneTokenSet(tokens));
  }

  public async delete(providerId: string, localAccountId: string): Promise<boolean> {
    return this.values.delete(`${providerId}:${localAccountId}`);
  }

  public async text(providerId: string, localAccountId: string): Promise<string | undefined> {
    const value = await this.get(providerId, localAccountId);
    if (value === undefined) return undefined;
    try {
      return Buffer.from(value.accessToken).toString("utf8");
    } finally {
      value.accessToken.fill(0);
      value.refreshToken?.fill(0);
    }
  }
}

function cloneTokenSet(value: ProviderTokenSet): ProviderTokenSet {
  return {
    accessToken: Uint8Array.from(value.accessToken),
    ...(value.refreshToken === undefined ? {} : { refreshToken: Uint8Array.from(value.refreshToken) }),
    tokenType: value.tokenType,
    scopes: [...value.scopes],
    expiresAt: value.expiresAt,
  };
}
