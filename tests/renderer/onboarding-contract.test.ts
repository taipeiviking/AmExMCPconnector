import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "src/renderer/index.html"), "utf8");
const renderer = readFileSync(resolve(process.cwd(), "src/renderer/renderer.ts"), "utf8");

describe("nontechnical onboarding contract", () => {
  it("offers a prominent no-real-data test and plainly distinguishes current availability", () => {
    expect(html).toContain('id="wizard-safe-start"');
    expect(html).toContain("Recommended first");
    expect(html).toContain("Japan personal and company cards");
    expect(html).toContain("This test build does not connect directly to Amex");
  });

  it("gates U.S. choices before account creation until preflight allows consent", () => {
    expect(html.match(/data-provider-required="true"/g)).toHaveLength(4);
    expect(renderer).toContain('performAction("preflight-us-provider")');
    expect(renderer).toContain("latestProviderReadiness?.canStartConsent");
    expect(renderer).toContain("addButton.disabled = true");
    expect(renderer).toContain('card.removeAttribute("aria-disabled")');
    expect(renderer).toContain("showWizardStep();");
    expect(renderer).toContain("No account was added");
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
});
