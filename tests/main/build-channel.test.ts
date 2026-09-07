import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canControlScreenshotProtection, readBuildChannel } from "../../src/main/build-channel";

describe("screenshot build-channel policy", () => {
  it("keeps the source screenshot command synthetic and isolated", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.["dev:screenshots"];

    expect(command).toContain("AMEX_SCREENSHOT_PROTECTION=false");
    expect(command).toContain("AMEX_DEMO_MODE=true");
    expect(command).toContain("AMEX_DATA_DIR=./local-data/screenshot-development");
  });

  it("fails closed when packaged build metadata is absent, malformed, or production", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-build-channel-"));
    const malformed = join(directory, "malformed.json");
    const production = join(directory, "production.json");
    await writeFile(malformed, "not-json", "utf8");
    await writeFile(production, JSON.stringify({ channel: "production" }), "utf8");

    expect(readBuildChannel(join(directory, "missing.json"))).toBe("production");
    expect(readBuildChannel(malformed)).toBe("production");
    expect(readBuildChannel(production)).toBe("production");
    expect(canControlScreenshotProtection({
      environment: "production",
      packaged: true,
      buildChannel: "production"
    })).toBe(false);
  });

  it("allows the control only in source development/test or an explicitly marked unsigned alpha", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-build-channel-"));
    const unsignedAlpha = join(directory, "unsigned-alpha.json");
    await writeFile(unsignedAlpha, JSON.stringify({ channel: "unsigned-alpha" }), "utf8");

    expect(readBuildChannel(unsignedAlpha)).toBe("unsigned-alpha");
    expect(canControlScreenshotProtection({
      environment: "production",
      packaged: true,
      buildChannel: "unsigned-alpha"
    })).toBe(true);
    expect(canControlScreenshotProtection({
      environment: "development",
      packaged: false,
      buildChannel: "production"
    })).toBe(true);
    expect(canControlScreenshotProtection({
      environment: "production",
      packaged: false,
      buildChannel: "unsigned-alpha"
    })).toBe(false);
  });
});
