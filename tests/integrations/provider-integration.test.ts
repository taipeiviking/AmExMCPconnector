import { describe, expect, it, vi } from "vitest";
import { GenericProviderOAuthClient } from "../../src/integrations/generic-provider-oauth-client";
import { GenericReadOnlyProviderHttpClient } from "../../src/integrations/generic-read-only-provider-client";
import type { ProviderTokenSet, ProviderTokenStore } from "../../src/integrations/provider-types";
import type { SecretReferenceResolver } from "../../src/security/secret-reference";

const oauthConfiguration = {
  providerId: "approved-us-provider",
  authorizationEndpoint: "https://consent.provider.example/oauth/authorize",
  tokenEndpoint: "https://consent.provider.example/oauth/token",
  revocationEndpoint: "https://consent.provider.example/oauth/revoke",
  clientIdReference: "test:client-id",
  clientSecretReference: "test:client-secret",
  readOnlyScopes: ["accounts.read", "transactions.read", "statements.read"],
  redirectUri: "http://127.0.0.1:43122/oauth/callback",
} as const;

describe("generic provider OAuth adapter", () => {
  it("uses PKCE/state and isolates completed authorization by local account", async () => {
    const store = new MemoryTokenStore();
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("public-client-id");
      expect(body.get("client_secret")).toBe("protected-client-secret");
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return Response.json({
        access_token: `access-for-${body.get("code")}`,
        refresh_token: "refresh-account-a",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "accounts.read transactions.read statements.read",
      });
    });
    const oauth = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      store,
      fetchImpl as typeof fetch,
      () => new Date("2026-09-07T00:00:00.000Z"),
    );

    const accountA = await oauth.beginConsent("local-account-a");
    const accountB = await oauth.beginConsent("local-account-b");
    const accountAUrl = new URL(accountA.authorizationUrl);
    expect(accountAUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(accountAUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(accountAUrl.searchParams.get("scope")).toBe(
      "accounts.read transactions.read statements.read",
    );

    const completed = await oauth.completeConsent("local-account-a", {
      state: accountAUrl.searchParams.get("state") ?? "",
      code: "authorization-code-a",
    });
    expect(completed.state).toBe("authorized");
    expect(await store.get("approved-us-provider", "local-account-b")).toBeUndefined();
    expect((await oauth.checkAuthorization("local-account-b")).state).toBe("pending");
    expect(new URL(accountB.authorizationUrl).searchParams.get("state")).not.toBe(
      accountAUrl.searchParams.get("state"),
    );

    const access = await oauth.getAccessToken("local-account-a");
    expect(Buffer.from(access).toString("utf8")).toBe("access-for-authorization-code-a");
    access.fill(0);
  });

  it("consumes a mismatched state once and never contacts the token endpoint", async () => {
    const fetchImpl = vi.fn();
    const oauth = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      new MemoryTokenStore(),
      fetchImpl as typeof fetch,
    );
    const started = await oauth.beginConsent("local-account-a");

    await expect(
      oauth.completeConsent("local-account-a", { state: "wrong-state", code: "code" }),
    ).rejects.toMatchObject({ code: "CONSENT_MISMATCH" });
    await expect(
      oauth.completeConsent("local-account-a", {
        state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
        code: "code",
      }),
    ).rejects.toMatchObject({ code: "CONSENT_MISMATCH" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes only the selected account and requests reauthorization on rejected refresh", async () => {
    const store = new MemoryTokenStore();
    await store.put("approved-us-provider", "account-a", tokenSet("expired-a", "refresh-a", "2026-01-01T00:00:00.000Z"));
    await store.put("approved-us-provider", "account-b", tokenSet("fresh-b", "refresh-b", "2030-01-01T00:00:00.000Z"));
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("refresh_token")).toBe("refresh-a");
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const oauth = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      store,
      fetchImpl as typeof fetch,
      () => new Date("2026-09-07T00:00:00.000Z"),
    );

    await expect(oauth.getAccessToken("account-a")).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    const accountB = await oauth.getAccessToken("account-b");
    expect(Buffer.from(accountB).toString("utf8")).toBe("fresh-b");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats only explicit invalid-grant refresh responses as requiring authorization", async () => {
    const invalidGrantStore = new MemoryTokenStore();
    await invalidGrantStore.put(
      "approved-us-provider",
      "account-a",
      tokenSet("expired-a", "refresh-a", "2026-01-01T00:00:00.000Z"),
    );
    const invalidGrant = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      invalidGrantStore,
      (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch,
      () => new Date("2026-09-07T00:00:00.000Z"),
    );
    await expect(invalidGrant.refreshAuthorization("account-a")).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    });

    const throttledStore = new MemoryTokenStore();
    await throttledStore.put(
      "approved-us-provider",
      "account-a",
      tokenSet("expired-a", "refresh-a", "2026-01-01T00:00:00.000Z"),
    );
    const throttled = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      throttledStore,
      (async () => Response.json({ error: "temporarily_unavailable" }, { status: 429 })) as typeof fetch,
    );
    await expect(throttled.refreshAuthorization("account-a")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });

    const genericRejectionStore = new MemoryTokenStore();
    await genericRejectionStore.put(
      "approved-us-provider",
      "account-a",
      tokenSet("expired-a", "refresh-a", "2026-01-01T00:00:00.000Z"),
    );
    const genericRejection = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      genericRejectionStore,
      (async () => Response.json({ error: "invalid_client" }, { status: 401 })) as typeof fetch,
    );
    await expect(genericRejection.refreshAuthorization("account-a")).rejects.toMatchObject({
      code: "PROVIDER_REJECTED",
    });
  });

  it("rejects write-like scopes and non-loopback redirects", () => {
    expect(
      () =>
        new GenericProviderOAuthClient(
          { ...oauthConfiguration, readOnlyScopes: ["transactions.write"] },
          createSecretResolver(),
          new MemoryTokenStore(),
        ),
    ).toThrow(/read-only/u);
    expect(
      () =>
        new GenericProviderOAuthClient(
          { ...oauthConfiguration, redirectUri: "https://desktop.example/callback" },
          createSecretResolver(),
          new MemoryTokenStore(),
        ),
    ).toThrow(/loopback/u);
  });

  it("bounds token exchange with an abort signal", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    const oauth = new GenericProviderOAuthClient(
      { ...oauthConfiguration, requestTimeoutMs: 100 },
      createSecretResolver(),
      new MemoryTokenStore(),
      fetchImpl as typeof fetch,
    );
    const started = await oauth.beginConsent("local-account-a");

    await expect(oauth.completeConsent("local-account-a", {
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      code: "authorization-code-a",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts active and future authorization requests when the runtime closes", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    const oauth = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      new MemoryTokenStore(),
      fetchImpl as typeof fetch,
    );
    const started = await oauth.beginConsent("local-account-a");
    const completing = oauth.completeConsent("local-account-a", {
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      code: "authorization-code-a",
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    oauth.abortPending();

    await expect(completing).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(oauth.beginConsent("local-account-b")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("deletes local token material before attempting bounded remote revocation", async () => {
    const store = new MemoryTokenStore();
    await store.put(
      "approved-us-provider",
      "local-account-a",
      tokenSet("access-a", "refresh-a", "2030-01-01T00:00:00.000Z"),
    );
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(await store.get("approved-us-provider", "local-account-a")).toBeUndefined();
      expect(new URLSearchParams(String(init?.body)).get("token")).toBe("refresh-a");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({});
    });
    const oauth = new GenericProviderOAuthClient(
      oauthConfiguration,
      createSecretResolver(),
      store,
      fetchImpl as typeof fetch,
    );

    await expect(oauth.disconnect("local-account-a")).resolves.toEqual({
      localCredentialsDeleted: true,
      remoteRevocation: "succeeded",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled revocation after local token deletion", async () => {
    const store = new MemoryTokenStore();
    await store.put(
      "approved-us-provider",
      "local-account-a",
      tokenSet("access-a", "refresh-a", "2030-01-01T00:00:00.000Z"),
    );
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    const oauth = new GenericProviderOAuthClient(
      { ...oauthConfiguration, requestTimeoutMs: 100 },
      createSecretResolver(),
      store,
      fetchImpl as typeof fetch,
    );

    await expect(oauth.disconnect("local-account-a")).resolves.toEqual({
      localCredentialsDeleted: true,
      remoteRevocation: "failed",
    });
    expect(await store.get("approved-us-provider", "local-account-a")).toBeUndefined();
  });
});

describe("generic read-only provider client", () => {
  const readConfiguration = {
    providerId: "approved-us-provider",
    apiBaseUrl: "https://api.provider.example/v1/",
    endpoints: {
      accounts: "/accounts",
      accountStatus: "/accounts/{providerAccountId}/status",
      transactions: "/accounts/{providerAccountId}/transactions",
      statements: "/accounts/{providerAccountId}/statements",
      statement: "/accounts/{providerAccountId}/statements/{providerStatementId}",
    },
    maximumPageSize: 200,
  } as const;

  it("performs GET-only requests with an explicitly selected account token", async () => {
    const requestedAccounts: string[] = [];
    const issuedTokens: Uint8Array[] = [];
    const tokenSource = {
      getAccessToken: async (localAccountId: string) => {
        requestedAccounts.push(localAccountId);
        const token = Buffer.from(`token-${localAccountId}`, "utf8");
        issuedTokens.push(token);
        return token;
      },
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-local-account-a");
      expect(url.pathname).toBe("/accounts/provider%2Faccount-a/transactions");
      expect(url.searchParams.get("from")).toBe("2026-08-01");
      expect(url.searchParams.get("page_size")).toBe("25");
      return Response.json({ transactions: [] }, { headers: { "x-request-id": "provider-request-1" } });
    });
    const client = new GenericReadOnlyProviderHttpClient(
      readConfiguration,
      tokenSource,
      fetchImpl as typeof fetch,
    );

    const result = await client.listTransactions(
      { localAccountId: "local-account-a", providerAccountId: "provider/account-a" },
      { from: "2026-08-01", pageSize: 25 },
    );
    expect(result).toEqual({ data: { transactions: [] }, providerRequestId: "provider-request-1" });
    expect(requestedAccounts).toEqual(["local-account-a"]);
    expect(issuedTokens[0]).toEqual(Buffer.alloc("token-local-account-a".length));
  });

  it("maps provider authorization and availability failures to safe codes", async () => {
    const tokenSource = { getAccessToken: async () => Buffer.from("token", "utf8") };
    const unauthorized = new GenericReadOnlyProviderHttpClient(
      readConfiguration,
      tokenSource,
      (async () => new Response("denied", { status: 401 })) as typeof fetch,
    );
    await expect(
      unauthorized.getAccountStatus({ localAccountId: "local-a", providerAccountId: "provider-a" }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });

    const unavailable = new GenericReadOnlyProviderHttpClient(
      readConfiguration,
      tokenSource,
      (async () => new Response("busy", { status: 503 })) as typeof fetch,
    );
    await expect(
      unavailable.listStatements({ localAccountId: "local-a", providerAccountId: "provider-a" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects absolute, escaping, or incomplete endpoint templates", () => {
    expect(
      () =>
        new GenericReadOnlyProviderHttpClient(
          {
            ...readConfiguration,
            endpoints: { ...readConfiguration.endpoints, transactions: "https://evil.example/{providerAccountId}" },
          },
          { getAccessToken: async () => Buffer.from("token") },
        ),
    ).toThrow(/template/u);
    expect(
      () =>
        new GenericReadOnlyProviderHttpClient(
          {
            ...readConfiguration,
            endpoints: { ...readConfiguration.endpoints, statement: "/statements/{providerAccountId}" },
          },
          { getAccessToken: async () => Buffer.from("token") },
        ),
    ).toThrow(/placeholder/u);
  });

  it("aborts active and future provider reads when the runtime closes", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    const client = new GenericReadOnlyProviderHttpClient(
      readConfiguration,
      { getAccessToken: async () => Buffer.from("token", "utf8") },
      fetchImpl as typeof fetch,
    );
    const reading = client.getAccountStatus({
      localAccountId: "local-account-a",
      providerAccountId: "provider-account-a",
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    client.abortPending();

    await expect(reading).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(client.getAccountStatus({
      localAccountId: "local-account-a",
      providerAccountId: "provider-account-a",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

class MemoryTokenStore implements ProviderTokenStore {
  private readonly values = new Map<string, ProviderTokenSet>();

  public async get(providerId: string, localAccountId: string): Promise<ProviderTokenSet | undefined> {
    const found = this.values.get(`${providerId}\0${localAccountId}`);
    return found === undefined ? undefined : cloneTokenSet(found);
  }

  public async put(providerId: string, localAccountId: string, tokens: ProviderTokenSet): Promise<void> {
    this.values.set(`${providerId}\0${localAccountId}`, cloneTokenSet(tokens));
  }

  public async delete(providerId: string, localAccountId: string): Promise<boolean> {
    return this.values.delete(`${providerId}\0${localAccountId}`);
  }
}

function cloneTokenSet(tokens: ProviderTokenSet): ProviderTokenSet {
  return {
    accessToken: Uint8Array.from(tokens.accessToken),
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: Uint8Array.from(tokens.refreshToken) }),
    tokenType: "Bearer",
    scopes: [...tokens.scopes],
    expiresAt: tokens.expiresAt,
  };
}

function tokenSet(access: string, refresh: string, expiresAt: string): ProviderTokenSet {
  return {
    accessToken: Buffer.from(access, "utf8"),
    refreshToken: Buffer.from(refresh, "utf8"),
    tokenType: "Bearer",
    scopes: ["accounts.read", "transactions.read", "statements.read"],
    expiresAt,
  };
}

function createSecretResolver(): SecretReferenceResolver {
  return {
    supports: (reference) => reference.startsWith("test:"),
    resolve: async (reference) => {
      if (reference === "test:client-id") return Buffer.from("public-client-id", "utf8");
      if (reference === "test:client-secret") return Buffer.from("protected-client-secret", "utf8");
      throw new Error("missing test reference");
    },
  };
}
