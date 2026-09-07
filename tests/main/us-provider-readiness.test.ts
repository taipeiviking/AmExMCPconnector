import { describe, expect, it, vi } from "vitest";
import { loadConfiguration } from "../../src/config/environment";
import {
  SecretReferenceError,
  type SecretReferenceResolver
} from "../../src/security/secret-reference";
import { preflightUsProvider } from "../../src/main/us-provider-readiness";

const baseEnvironment: NodeJS.ProcessEnv = {
  LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local"
};

function configuredProvider() {
  return loadConfiguration({
    environment: {
      ...baseEnvironment,
      AMEX_APP_ENV: "test",
      AMEX_US_AGGREGATOR: "approved-provider-generic",
      AMEX_US_AGGREGATOR_BASE_URL: "https://provider.example.test/api",
      AMEX_US_OAUTH_AUTHORIZATION_URL: "https://provider.example.test/authorize",
      AMEX_US_OAUTH_TOKEN_URL: "https://provider.example.test/token",
      AMEX_US_AGGREGATOR_CLIENT_ID_REF: "wincred:private-client-id-target",
      AMEX_US_AGGREGATOR_CLIENT_SECRET_REF: "wincred:private-client-secret-target"
    }
  });
}

describe("U.S. provider readiness", () => {
  it("explains the disabled first-run path without querying credentials", async () => {
    const resolver: SecretReferenceResolver = {
      supports: vi.fn(() => true),
      resolve: vi.fn()
    };

    const readiness = await preflightUsProvider({
      configuration: loadConfiguration({
        environment: { ...baseEnvironment, AMEX_US_AGGREGATOR: "disabled" }
      }),
      storageState: "unlocked",
      runtimeAvailable: false,
      credentialResolver: resolver,
      now: () => new Date("2026-09-07T12:00:00.000Z")
    });

    expect(readiness).toMatchObject({
      state: "disabled",
      canStartConsent: false,
      checkedAt: "2026-09-07T12:00:00.000Z",
      safeguards: {
        readOnly: true,
        amexPasswordAccepted: false,
        secretsExposed: false
      }
    });
    expect(readiness.steps.map((step) => step.id)).toEqual([
      "provider-access",
      "provider-settings",
      "windows-credentials",
      "restart-app",
      "choose-japan-import"
    ]);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("reports ready only after both protected credentials are found and wipes the returned bytes", async () => {
    const resolvedSecrets: Uint8Array[] = [];
    const resolver: SecretReferenceResolver = {
      supports: (reference) => reference.startsWith("wincred:"),
      resolve: vi.fn(async (reference) => {
        const secret = Buffer.from(reference.endsWith("id-target") ? "provider-client" : "provider-secret", "utf8");
        resolvedSecrets.push(secret);
        return secret;
      })
    };

    const readiness = await preflightUsProvider({
      configuration: configuredProvider(),
      storageState: "unlocked",
      runtimeAvailable: true,
      credentialResolver: resolver
    });

    expect(readiness.state).toBe("ready");
    expect(readiness.canStartConsent).toBe(true);
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(resolvedSecrets).toHaveLength(2);
    for (const secret of resolvedSecrets) expect(secret.every((byte) => byte === 0)).toBe(true);
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain("private-client-id-target");
    expect(serialized).not.toContain("private-client-secret-target");
    expect(serialized).not.toContain("provider-secret");
  });

  it("returns an actionable missing-credential result without exposing its target", async () => {
    const resolver: SecretReferenceResolver = {
      supports: () => true,
      resolve: vi.fn(async () => {
        throw new SecretReferenceError("SECRET_NOT_FOUND", "private-client-secret-target was not found");
      })
    };

    const readiness = await preflightUsProvider({
      configuration: configuredProvider(),
      storageState: "unlocked",
      runtimeAvailable: true,
      credentialResolver: resolver
    });

    expect(readiness).toMatchObject({ state: "credentials-missing", canStartConsent: false });
    expect(readiness.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "windows-credentials", status: "action-required" }),
        expect.objectContaining({ id: "choose-japan-import", status: "available" })
      ])
    );
    expect(JSON.stringify(readiness)).not.toContain("private-client-secret-target");
  });

  it("fails closed when the credential store cannot be queried", async () => {
    const resolver: SecretReferenceResolver = {
      supports: () => true,
      resolve: vi.fn(async () => {
        throw new SecretReferenceError("RESOLVER_FAILED", "internal helper detail");
      })
    };

    const readiness = await preflightUsProvider({
      configuration: configuredProvider(),
      storageState: "unlocked",
      runtimeAvailable: true,
      credentialResolver: resolver
    });

    expect(readiness).toMatchObject({ state: "credential-store-unavailable", canStartConsent: false });
    expect(JSON.stringify(readiness)).not.toContain("internal helper detail");
  });

  it("does not query credentials when storage or the provider runtime is unavailable", async () => {
    const resolver: SecretReferenceResolver = {
      supports: vi.fn(() => true),
      resolve: vi.fn()
    };
    const configuration = configuredProvider();

    const locked = await preflightUsProvider({
      configuration,
      storageState: "locked",
      runtimeAvailable: true,
      credentialResolver: resolver
    });
    const rejected = await preflightUsProvider({
      configuration,
      storageState: "unlocked",
      runtimeAvailable: false,
      runtimeError: "sensitive internal error detail",
      credentialResolver: resolver
    });

    expect(locked.state).toBe("storage-unavailable");
    expect(rejected.state).toBe("configuration-error");
    expect(JSON.stringify(rejected)).not.toContain("sensitive internal error detail");
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("rejects malformed protected credential text and clears it", async () => {
    const malformed = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const resolver: SecretReferenceResolver = {
      supports: () => true,
      resolve: vi.fn(async () => malformed)
    };

    const readiness = await preflightUsProvider({
      configuration: configuredProvider(),
      storageState: "unlocked",
      runtimeAvailable: true,
      credentialResolver: resolver
    });

    expect(readiness).toMatchObject({ state: "configuration-error", canStartConsent: false });
    expect(malformed).toEqual(Uint8Array.from([0, 0, 0]));
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });
});
