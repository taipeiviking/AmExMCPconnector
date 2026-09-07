import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceReadService } from "../../src/mcp/create-mcp-server";
import { McpHttpServer } from "../../src/mcp/http-server";

const running: McpHttpServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

function service(): FinanceReadService {
  const empty = vi.fn().mockResolvedValue({});
  return {
    listAccounts: empty,
    getAccountStatus: empty,
    listTransactions: empty,
    getStatement: empty,
    getPortfolioReport: empty,
    listFraudAlerts: empty,
    explainAlert: empty
  };
}

describe("McpHttpServer", () => {
  it("rejects invalid concurrent-request caps", () => {
    expect(() => new McpHttpServer(service(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      rateLimitPerMinute: 10,
      maxConcurrentRequests: 0
    })).toThrow(/concurrent request cap/u);
  });

  it("binds a private health endpoint and rejects browser origins", async () => {
    const server = new McpHttpServer(service(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      rateLimitPerMinute: 10
    });
    running.push(server);
    const status = await server.start();
    const endpoint = new URL(status.endpoint!);

    const health = await fetch(`${endpoint.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", scope: "loopback" });

    const browserRequest = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: "{}"
    });
    expect(browserRequest.status).toBe(403);
  });

  it("supports an optional local bearer boundary", async () => {
    const server = new McpHttpServer(service(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      rateLimitPerMinute: 10,
      bearerToken: "synthetic-test-token"
    });
    running.push(server);
    const status = await server.start();

    const response = await fetch(status.endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(401);
  });

  it("does not let failed authentication consume the authenticated request budget", async () => {
    const server = new McpHttpServer(service(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      rateLimitPerMinute: 1,
      unauthenticatedRateLimitPerMinute: 1,
      bearerToken: "synthetic-test-token"
    });
    running.push(server);
    const status = await server.start();
    const health = `${new URL(status.endpoint!).origin}/healthz`;

    const unauthorized = await fetch(health);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(health, {
      headers: { Authorization: "Bearer synthetic-test-token" }
    });
    expect(authorized.status).toBe(200);

    const boundedUnauthorized = await fetch(health);
    expect(boundedUnauthorized.status).toBe(429);

    const boundedAuthorized = await fetch(health, {
      headers: { Authorization: "Bearer synthetic-test-token" }
    });
    expect(boundedAuthorized.status).toBe(429);
  });
});
