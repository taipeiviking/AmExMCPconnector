import { describe, expect, it, vi } from "vitest";
import {
  CompositeSecretReferenceResolver,
  SecretReferenceError,
  withResolvedSecret,
  type SecretReferenceResolver,
} from "../../src/security/secret-reference";
import {
  WindowsGenericCredentialResolver,
  parseWindowsCredentialReference,
} from "../../src/security/windows-generic-credential-resolver";

describe("secret references", () => {
  it("routes only supported references and never treats an unknown reference as a value", async () => {
    const resolver: SecretReferenceResolver = {
      supports: (reference) => reference.startsWith("test:"),
      resolve: async () => Uint8Array.from([1, 2, 3]),
    };
    const composite = new CompositeSecretReferenceResolver([resolver]);

    await expect(composite.resolve("literal-secret")).rejects.toMatchObject({
      code: "UNSUPPORTED_REFERENCE",
    });
    await expect(composite.resolve("test:key")).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("overwrites resolved bytes even when the consumer fails", async () => {
    const secret = Uint8Array.from([9, 8, 7]);
    const resolver: SecretReferenceResolver = {
      supports: () => true,
      resolve: async () => secret,
    };

    await expect(
      withResolvedSecret(resolver, "test:key", async () => {
        throw new Error("consumer failed");
      }),
    ).rejects.toThrow("consumer failed");
    expect(secret).toEqual(Uint8Array.from([0, 0, 0]));
  });
});

describe("Windows Generic Credential resolver", () => {
  it("parses only explicit wincred references", () => {
    expect(parseWindowsCredentialReference("wincred:Amex%2Fprovider%2Fclient-secret")).toBe(
      "Amex/provider/client-secret",
    );
    expect(() => parseWindowsCredentialReference("plain:secret")).toThrow(SecretReferenceError);
    expect(() => parseWindowsCredentialReference("wincred:%00bad")).toThrow(/printable/u);
  });

  it("retrieves decoded bytes through the fixed Windows runner", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.from(Buffer.from("credential-value", "utf8").toString("base64"), "ascii"),
    }));
    const resolver = new WindowsGenericCredentialResolver({
      platform: "win32",
      windowsDirectory: "C:\\Windows",
      runner,
    });

    const resolved = await resolver.resolve("wincred:AmexLocal%2Fprovider");
    expect(Buffer.from(resolved).toString("utf8")).toBe("credential-value");
    expect(runner).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.stringContaining("CredRead"),
      "AmexLocal/provider",
    );
  });

  it("fails closed off Windows, when missing, or for malformed helper output", async () => {
    const offWindows = new WindowsGenericCredentialResolver({
      platform: "linux",
      windowsDirectory: "C:\\Windows",
      runner: vi.fn(),
    });
    await expect(offWindows.resolve("wincred:test")).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });

    const missing = new WindowsGenericCredentialResolver({
      platform: "win32",
      windowsDirectory: "C:\\Windows",
      runner: async () => ({ exitCode: 3, stdout: new Uint8Array() }),
    });
    await expect(missing.resolve("wincred:test")).rejects.toMatchObject({ code: "SECRET_NOT_FOUND" });

    const malformed = new WindowsGenericCredentialResolver({
      platform: "win32",
      windowsDirectory: "C:\\Windows",
      runner: async () => ({ exitCode: 0, stdout: Buffer.from("not base64!", "ascii") }),
    });
    await expect(malformed.resolve("wincred:test")).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
  });
});
