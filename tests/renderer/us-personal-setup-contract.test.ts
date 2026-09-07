import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "src/renderer/index.html"), "utf8");
const renderer = readFileSync(resolve(process.cwd(), "src/renderer/renderer.ts"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = renderer.indexOf(`function ${name}`);
  const end = renderer.indexOf(`function ${nextName}`, start + 1);
  expect(start, `${name} should exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} should follow ${name}`).toBeGreaterThan(start);
  return renderer.slice(start, end);
}

function tagContaining(fragment: string, tagName: "button" | "input" | "option"): string {
  const pattern = new RegExp(`<${tagName}[^>]*${fragment}[^>]*>`, "i");
  const match = html.match(pattern);
  expect(match, `expected a ${tagName} containing ${fragment}`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("U.S. personal onboarding contract", () => {
  it("keeps U.S. personal visibly actionable before provider credentials exist", () => {
    const pathButton = tagContaining('data-account-path="US-personal"', "button");
    const typeOption = tagContaining('value="US-personal"', "option");
    const availability = functionSource("updateProviderAvailability", "renderProviderReadiness");

    expect(pathButton).not.toMatch(/\bdisabled\b/i);
    expect(pathButton).not.toMatch(/aria-disabled=["']true["']/i);
    expect(pathButton).not.toMatch(/class=["'][^"']*\bunavailable\b/i);
    expect(typeOption).not.toMatch(/\bdisabled\b/i);
    expect(html).toContain("U.S. setup included");
    expect(html).toContain("Set up U.S. personal access");

    expect(availability).toContain('card.classList.remove("unavailable")');
    expect(availability).toContain('card.classList.toggle("setup-needed", !ready)');
    expect(availability).toContain('card.removeAttribute("aria-disabled")');
    expect(availability).toContain('if (option.dataset.usPersonal === "true") option.disabled = false');
    expect(styles).toContain(".path-card.setup-needed");
    expect(styles).toContain(".path-card.setup-needed:hover");
  });

  it("keeps U.S. company explicitly unavailable while offering U.S. personal", () => {
    const companyOption = tagContaining('value="US-company"', "option");
    const wizard = functionSource("setupWizard", "selectAccountPath");
    const guidance = functionSource("updatePathGuidance", "updateProviderAvailability");

    expect(companyOption).toMatch(/\bdisabled\b/i);
    expect(html).toContain("U.S. · company — not in this test release");
    expect(wizard).toContain('selectedAccountPath === "US-company"');
    expect(wizard).toContain("U.S. company connection is not enabled in this test release");
    expect(guidance).toContain("U.S. personal setup is available now");
  });

  it("clearly separates fake Sandbox testing from approved Production access", () => {
    expect(html).toContain("Sandbox — fake account, recommended first");
    expect(html).toContain("Sandbox never connects to your real Amex account");
    expect(html).toContain("Production — real account, Plaid approval required");
    expect(html).toContain("Production access is granted by Plaid, not by this installer");
    expect(html).toContain("requests only transaction access");
    expect(html).toContain("Plaid is a separate service");

    const environmentHelp = functionSource("updatePlaidEnvironmentHelp", "configurePlaid");
    expect(environmentHelp).toContain("only after Plaid has approved and enabled your app for Transactions");
    expect(environmentHelp).toContain("Sandbox uses synthetic institutions");
  });

  it("treats provider credentials as secrets and never asks for an Amex password", () => {
    for (const id of ["plaid-client-id", "plaid-client-secret"]) {
      const input = tagContaining(`id="${id}"`, "input");
      expect(input).toMatch(/type=["']password["']/i);
      expect(input).toMatch(/autocomplete=["']off["']/i);
      expect(input).toMatch(/spellcheck=["']false["']/i);
    }

    expect(html).toContain("Saved for this Windows user in Windows Credential Manager");
    expect(html).toContain("not written to <code>.env</code>, the database, logs, or Git");
    expect(html).toContain("these fields are Plaid app credentials—not my Amex username or password");
    expect(html).toContain("Do not paste an Amex password, card number, OAuth token, or account data into these fields");
    expect(html).not.toMatch(/<input[^>]*(?:amex-password|amex-username)/i);
  });

  it("requires explicit read-only confirmation and clears secret inputs after every request", () => {
    const configure = functionSource("configurePlaid", "chooseStatementForAccount");
    const confirmationCheck = configure.indexOf("if (!confirmed)");
    const request = configure.indexOf("window.amexConnector.performAction");

    expect(confirmationCheck).toBeGreaterThanOrEqual(0);
    expect(request).toBeGreaterThan(confirmationCheck);
    expect(configure).toContain('kind: "configure-plaid"');
    expect(configure).toContain("confirmedReadOnly: true");
    expect(configure).toContain("No account consent is being created");
    expect(configure.match(/clientIdInput\.value = "";/g)).toHaveLength(2);
    expect(configure.match(/secretInput\.value = "";/g)).toHaveLength(2);
    expect(configure).not.toContain("localStorage");
    expect(configure).not.toContain("sessionStorage");
    expect(configure).not.toMatch(/resultPanel\.textContent\s*=.*(?:clientIdInput|secretInput|clientSecret)/);
  });

  it("announces verification results and moves keyboard focus into the setup", () => {
    const setupResult = html.match(/<div id="plaid-setup-result"[^>]*>/)?.[0] ?? "";
    const showSetup = functionSource("showPlaidSetup", "updatePlaidEnvironmentHelp");
    const configure = functionSource("configurePlaid", "chooseStatementForAccount");

    expect(setupResult).toContain('role="status"');
    expect(setupResult).toContain('aria-live="polite"');
    expect(showSetup).toContain('(byId("plaid-environment") as HTMLSelectElement).focus()');
    expect(configure).toContain("saveButton.disabled = true");
    expect(configure).toContain("saveButton.disabled = false");
  });
});
