import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(resolve(process.cwd(), "src/main/main.ts"), "utf8");
const helper = readFileSync(resolve(process.cwd(), "scripts/install-latest.ps1"), "utf8");
const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");

describe("silent local update contract", () => {
  it("lets the installed app exit cleanly for a local update", () => {
    expect(main).toContain('process.argv.includes("--quit-for-update")');
    expect(main).toContain('commandLine.includes("--quit-for-update")');
    expect(main).toContain("void controller.quit()");
  });

  it("uses a versioned NSIS installer silently and verifies the result", () => {
    expect(helper).toContain('ArgumentList "/S"');
    expect(helper).toContain("Get-InstallerVersion");
    expect(helper).toContain("ProductVersion");
    expect(helper).toContain("-ForceCloseRunningApp");
    expect(packageJson).toContain('"install:win:latest"');
  });
});
