import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "src/renderer/index.html"), "utf8");
const renderer = readFileSync(resolve(process.cwd(), "src/renderer/renderer.ts"), "utf8");
const controller = readFileSync(resolve(process.cwd(), "src/main/controller.ts"), "utf8");

describe("nontechnical onboarding contract", () => {
  it("offers a prominent no-real-data test and plainly distinguishes current availability", () => {
    expect(html).toContain('id="wizard-safe-start"');
    expect(html).toContain("Recommended first");
    expect(html).toContain("Japan personal and company cards");
    expect(html).toContain("Sandbox never connects to your real Amex account");
    expect(html).toContain("Plaid Production approval");
  });

  it("keeps U.S. personal actionable while gating consent until setup passes", () => {
    expect(html).toContain('data-account-path="US-personal" data-us-personal="true"');
    expect(html).toContain('value="US-personal" data-us-personal="true"');
    expect(html).toContain('value="US-company" data-provider-required="true" disabled');
    expect(html).toContain('id="save-plaid-settings"');
    expect(html).toContain("Windows Credential Manager");
    expect(renderer).toContain('performAction("preflight-us-provider")');
    expect(renderer).toContain("latestProviderReadiness?.canStartConsent");
    expect(renderer).toContain("showPlaidSetup();");
    expect(renderer).toContain('addButton.textContent = "Set up U.S. personal access"');
    expect(renderer).toContain('card.removeAttribute("aria-disabled")');
    expect(renderer).toContain("showWizardStep();");
    expect(renderer).toContain("No account was added");
    expect(renderer).toContain('kind: "configure-plaid"');
    expect(controller).toContain('account.authorization.state === "authorized"');
    expect(controller).toContain('account.authorization.state === "unavailable"');
    expect(controller).toContain('return await this.syncUsAccount(active, provider, accountId)');
    expect(controller).toContain('recovered.state === "pending"');
  });

  it("moves a Japan statement action to the visible import review workflow", () => {
    const workflow = renderer.slice(
      renderer.indexOf("async function chooseStatementForAccount"),
      renderer.indexOf("async function importStatement")
    );
    expect(workflow.indexOf('showSection("imports")')).toBeGreaterThan(-1);
    expect(workflow.indexOf('performAction({ kind: "import-jp-statement"')).toBeGreaterThan(
      workflow.indexOf('showSection("imports")')
    );
    expect(renderer).toContain('focusPanel("import-preview")');
  });

  it("keeps screenshot capture a warned, session-only development control", () => {
    expect(html).toContain('id="screenshot-quick-toggle"');
    expect(html).toContain('id="screenshot-protection-toggle"');
    expect(html).toContain("Allow screenshots this session");
    expect(html).toContain('id="screenshot-warning"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Screenshot capture is allowed for this session");
    expect(renderer).toContain('{ kind: "set-screenshot-protection", enabled: !enabled }');
    expect(renderer).toContain('{ kind: "set-screenshot-protection", enabled: true }');
    expect(renderer).toContain("screenshotQuickToggle.hidden = !snapshot.privacy.screenshotControlAvailable || screenshotsAllowed");
    expect(renderer).toContain('screenshotToggle.hidden = !snapshot.privacy.screenshotControlAvailable');
    expect(controller).toContain("window.setContentProtection(enabled)");
    expect(controller).toContain("This Settings change is not saved");
  });
});
