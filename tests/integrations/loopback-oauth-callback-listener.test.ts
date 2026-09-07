import { createServer } from "node:http";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLoopbackOAuthCallbackListener } from "../../src/integrations/loopback-oauth-callback-listener";

const expectedState = "abcdefghijklmnopqrstuvwxyz0123456789_STATE";

describe("loopback OAuth callback listener", () => {
  it("binds a one-shot IPv4 loopback callback and releases a state-matched code", async () => {
    const port = await unusedPort();
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const session = await startLoopbackOAuthCallbackListener({
      redirectUri,
      expectedState,
      timeoutMs: 2000,
    });

    const response = await get(`${redirectUri}?state=${expectedState}&code=provider-code`);
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("provider-code");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    await expect(session.callback).resolves.toEqual({ state: expectedState, code: "provider-code" });
    await expect(get(`${redirectUri}?state=${expectedState}&code=second-code`)).rejects.toThrow();
  });

  it("does not consume the session on one mismatched state", async () => {
    const port = await unusedPort();
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const session = await startLoopbackOAuthCallbackListener({
      redirectUri,
      expectedState,
      timeoutMs: 2000,
      maximumInvalidAttempts: 2,
    });

    expect((await get(`${redirectUri}?state=${"x".repeat(40)}&code=attacker-code`)).status).toBe(400);
    const validRequest = get(`${redirectUri}?state=${expectedState}&code=valid-code`);
    await expect(session.callback).resolves.toEqual({ state: expectedState, code: "valid-code" });
    expect((await validRequest).status).toBe(200);
  });

  it("does not let an error callback cancel consent without the matching state", async () => {
    const port = await unusedPort();
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const session = await startLoopbackOAuthCallbackListener({
      redirectUri,
      expectedState,
      timeoutMs: 2000,
      maximumInvalidAttempts: 3,
    });

    expect((await get(`${redirectUri}?error=access_denied&state=${"x".repeat(40)}`)).status).toBe(400);
    const validRequest = get(`${redirectUri}?state=${expectedState}&code=valid-after-forged-error`);
    await expect(session.callback).resolves.toEqual({
      state: expectedState,
      code: "valid-after-forged-error",
    });
    expect((await validRequest).status).toBe(200);
  });

  it("accepts a bounded provider error only with the exact state", async () => {
    const port = await unusedPort();
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const session = await startLoopbackOAuthCallbackListener({
      redirectUri,
      expectedState,
      timeoutMs: 2000,
    });

    expect((await get(`${redirectUri}?error=access_denied&state=${expectedState}`)).status).toBe(400);
    await expect(session.callback).rejects.toMatchObject({ code: "CONSENT_CANCELLED" });
  });

  it("times out and rejects non-loopback callback configuration", async () => {
    const port = await unusedPort();
    const session = await startLoopbackOAuthCallbackListener({
      redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
      expectedState,
      timeoutMs: 100,
    });
    await expect(session.callback).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
    await expect(
      startLoopbackOAuthCallbackListener({
        redirectUri: "http://0.0.0.0:43122/oauth/callback",
        expectedState,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return port;
}

async function get(url: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return await new Promise((resolvePromise, reject) => {
    const outgoing = request(url, { method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        resolvePromise({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
