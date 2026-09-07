import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerSettingsPath,
  readPlaidProviderSettings,
  writePlaidProviderSettings
} from "../../src/main/plaid-provider-settings";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("Plaid provider settings", () => {
  it("uses the requested safe fallback when no file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-plaid-settings-"));
    cleanup.push(root);
    await expect(readPlaidProviderSettings(root, "sandbox")).resolves.toEqual({
      provider: "plaid",
      environment: "sandbox"
    });
  });

  it("round-trips only the non-secret provider environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-plaid-settings-"));
    cleanup.push(root);
    await writePlaidProviderSettings(root, "production");
    await expect(readPlaidProviderSettings(root, "sandbox")).resolves.toEqual({
      provider: "plaid",
      environment: "production"
    });
    const saved = await readFile(providerSettingsPath(root), "utf8");
    expect(saved).toContain('"schemaVersion": 1');
    expect(saved).not.toMatch(/client|secret|token|account/iu);
  });

  it("round-trips an optional non-secret production OAuth return URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-plaid-settings-"));
    cleanup.push(root);
    await writePlaidProviderSettings(root, "production", "https://connect.example.test/plaid-return");
    await expect(readPlaidProviderSettings(root, "sandbox")).resolves.toEqual({
      provider: "plaid",
      environment: "production",
      redirectUri: "https://connect.example.test/plaid-return"
    });
  });

  it("rejects unsafe production OAuth return URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-plaid-settings-"));
    cleanup.push(root);
    await expect(
      writePlaidProviderSettings(root, "production", "http://127.0.0.1/plaid-return")
    ).rejects.toThrow();
  });

  it("fails closed on unrecognized fields or values", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-plaid-settings-"));
    cleanup.push(root);
    await writeFile(
      providerSettingsPath(root),
      JSON.stringify({ schemaVersion: 1, provider: "plaid", environment: "development", secret: "no" }),
      "utf8"
    );
    await expect(readPlaidProviderSettings(root, "sandbox")).rejects.toThrow(/invalid/iu);
  });
});
