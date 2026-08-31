import type {
  AccountSummaryView,
  AlertSummaryView,
  AuditSummaryView,
  DesktopAction,
  DesktopRequest,
  LocalTestDriveResult,
  DesktopSnapshot
} from "../shared/ipc";

const titles: Record<string, string> = {
  "getting-started": "Getting started",
  overview: "Overview",
  accounts: "Accounts",
  portfolio: "Portfolio",
  imports: "Statement imports",
  exports: "Export packages",
  alerts: "Fraud review",
  audit: "Audit log",
  connection: "ChatGPT connection",
  settings: "Settings"
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let wizardStep = 1;
let selectedAccountPath = readLocalSetting("amex-onboarding-path");

document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => {
  button.addEventListener("click", () => showSection(button.dataset.section ?? "overview"));
});

document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    void performAction(button.dataset.action as DesktopAction);
  });
});

setupWizard();
byId("add-account-button").addEventListener("click", () => void addAccount());
byId("restart-onboarding").addEventListener("click", () => {
  wizardStep = 1;
  showWizardStep();
  showSection("getting-started");
});

showSection(readLocalSetting("amex-onboarding-complete") === "true" ? "overview" : "getting-started");
void refresh();

function showSection(section: string): void {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.getAttribute("data-section") === section));
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === section));
  setText("page-title", titles[section] ?? "Overview");
}

async function performAction(request: DesktopRequest): Promise<void> {
  try {
    const result = await window.amexConnector.performAction(request);
    showToast(result.message);
    if (result.testDrive) renderTestDrive(result.testDrive);
    if (result.ok) await refresh();
  } catch {
    showToast("The local desktop action could not be completed.");
  }
}

async function refresh(): Promise<void> {
  try {
    render(await window.amexConnector.getSnapshot());
  } catch {
    showToast("The local runtime is not ready. Try again after the encrypted store unlocks.");
  }
}

function render(snapshot: DesktopSnapshot): void {
  const environmentPill = byId("environment-pill");
  environmentPill.textContent = snapshot.demoMode ? "Synthetic demo data" : snapshot.environment;
  environmentPill.className = `pill ${snapshot.demoMode ? "warn" : "neutral"}`;

  const mcpPill = byId("mcp-pill");
  mcpPill.textContent = snapshot.mcp.state === "running" ? "MCP local · ready" : `MCP · ${snapshot.mcp.state}`;
  mcpPill.className = `pill ${snapshot.mcp.state === "running" ? "good" : "warn"}`;

  setText("account-count", String(snapshot.accounts.length));
  setText("account-detail", `${snapshot.accounts.filter((account) => account.queryReady).length} ready for read-only queries`);
  setText("alert-count", String(snapshot.alerts.filter((alert) => alert.status === "open").length));
  setText("storage-state", snapshot.storage.state);
  setText("storage-detail", snapshot.storage.protection);
  setText("tunnel-state", snapshot.tunnel.state.replaceAll("-", " "));
  setText("portfolio-name", snapshot.portfolioId);
  setText("base-currency", snapshot.baseCurrency);
  setText("mcp-endpoint", snapshot.mcp.endpoint ?? "Disabled");
  setText("connection-tunnel-status", snapshot.tunnel.state.replaceAll("-", " "));
  setText("footer-version", `Version ${snapshot.version} · ${new Date(snapshot.generatedAt).toLocaleString()}`);

  renderAccountOverview(snapshot.accounts);
  renderAccountCards(snapshot.accounts);
  renderAlerts(snapshot.alerts);
  renderAudit(snapshot.audit);

  if (snapshot.notices.length) showToast(snapshot.notices[0]!);
}

function renderAccountOverview(accounts: AccountSummaryView[]): void {
  const container = byId("overview-accounts");
  container.replaceChildren();
  container.classList.toggle("empty-state", accounts.length === 0);
  if (accounts.length === 0) {
    container.textContent = "No accounts configured. Add consent-based U.S. access or import an official Japan statement from the desktop UI.";
    return;
  }
  for (const account of accounts.slice(0, 5)) {
    const row = element("div", "account-row");
    const avatar = element("div", "account-avatar", account.country);
    const details = element("div");
    details.append(element("strong", undefined, `${account.name} · ${account.localIdentifier}`));
    details.append(element("small", undefined, `${account.legalEntity} · ${account.currency} · ${account.accountClass}`));
    const readiness = accountState(account);
    const status = element(
      "span",
      `status ${readiness.tone === "connected" ? "" : readiness.tone === "muted" ? "bad" : "warn"}`,
      readiness.label
    );
    row.append(avatar, details, status);
    container.append(row);
  }
}

function renderAccountCards(accounts: AccountSummaryView[]): void {
  const container = byId("accounts-cards");
  container.replaceChildren();
  container.classList.toggle("empty-state", accounts.length === 0);
  if (accounts.length === 0) {
    container.textContent = "No accounts configured. Use the quiet add-account row above or open Getting started.";
    return;
  }
  for (const account of accounts) {
    const card = element("article", "compact-account-card");
    const header = element("div", "account-card-header");
    const identity = element("div", "account-card-identity");
    identity.append(element("div", "account-avatar", account.country === "JP" ? "JP" : "US"));
    const identityText = element("div");
    identityText.append(element("strong", undefined, account.name));
    identityText.append(element("small", undefined, account.localIdentifier));
    identity.append(identityText);
    const state = accountState(account);
    const status = element("span", `connection-status ${state.tone}`, state.label);
    status.prepend(element("i", "status-dot"));
    header.append(identity, status);

    const tags = element("div", "account-tags");
    tags.append(
      element("span", undefined, account.country === "JP" ? "Japan" : "United States"),
      element("span", undefined, account.accountClass),
      element("span", undefined, account.connectionType === "read_only_consent" ? "Read-only consent" : "Official statement import"),
      element("span", "secure-tag", "Local · encrypted")
    );

    const labelRow = element("div", "label-control");
    const label = document.createElement("label");
    label.textContent = "Account label";
    const input = document.createElement("input");
    input.value = account.name;
    input.maxLength = 80;
    input.setAttribute("aria-label", `Account label for ${account.name}`);
    const save = element("button", "button quiet", "Save label");
    save.type = "button";
    save.addEventListener("click", () =>
      void performAction({ kind: "rename-account", accountId: account.id, label: input.value })
    );
    labelRow.append(label, input, save);

    const details = element("div", "account-card-details");
    details.append(
      detailPair("Owner / entity", account.legalEntity),
      detailPair("Local readiness", account.syncState.replaceAll("_", " "))
    );

    const actions = element("div", "account-card-actions");
    const reconnect = element(
      "button",
      "button secondary",
      account.connectionType === "read_only_consent" ? "Reconnect" : "Choose statement"
    );
    reconnect.type = "button";
    reconnect.addEventListener("click", () =>
      void performAction(account.connectionType === "read_only_consent" ? "authorize-us-account" : "import-jp-statement")
    );
    const disconnect = element("button", "button danger-outline", "Disconnect");
    disconnect.type = "button";
    disconnect.disabled = !account.active;
    disconnect.addEventListener("click", () =>
      void performAction({ kind: "disconnect-account", accountId: account.id })
    );
    actions.append(reconnect, disconnect);
    card.append(header, tags, labelRow, details, actions);
    container.append(card);
  }
}

function accountState(account: AccountSummaryView): { label: string; tone: string } {
  if (!account.active) return { label: "Disconnected", tone: "muted" };
  if (account.authorizationState === "authorized") return { label: "Consent stored", tone: "connected" };
  if (account.authorizationState === "import_only" && account.queryReady) return { label: "Import data available", tone: "connected" };
  if (account.authorizationState === "import_only") return { label: "Configured · first import needed", tone: "attention" };
  if (account.authorizationState === "reauthorization_required") return { label: "Reconnect needed", tone: "attention" };
  return { label: account.authorizationState.replaceAll("_", " "), tone: "attention" };
}

function detailPair(label: string, value: string): HTMLElement {
  const pair = element("div");
  pair.append(element("span", undefined, label), element("strong", undefined, value));
  return pair;
}

async function addAccount(): Promise<void> {
  const label = (byId("add-account-label") as HTMLInputElement).value.trim();
  const legalEntityName = (byId("add-account-entity") as HTMLInputElement).value.trim();
  const selection = (byId("add-account-type") as HTMLSelectElement).value;
  const [country, accountClass] = selection.split("-");
  if (!label || !legalEntityName || !["US", "JP"].includes(country ?? "") || !["personal", "company"].includes(accountClass ?? "")) {
    showToast("Enter an account label and owner/company name, then choose one of the four account types.");
    return;
  }
  await performAction({
    kind: "add-account",
    country: country as "US" | "JP",
    accountClass: accountClass as "personal" | "company",
    label,
    legalEntityName
  });
}

function setupWizard(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-account-path]").forEach((button) => {
    if (button.dataset.accountPath === selectedAccountPath) button.classList.add("selected");
    button.addEventListener("click", () => {
      selectedAccountPath = button.dataset.accountPath ?? "";
      writeLocalSetting("amex-onboarding-path", selectedAccountPath);
      document.querySelectorAll("[data-account-path]").forEach((candidate) =>
        candidate.classList.toggle("selected", candidate === button)
      );
      const isUs = selectedAccountPath.startsWith("US-");
      setText(
        "path-guidance",
        isUs
          ? "Current status: no live U.S. provider is configured. A future approved consent flow will open the provider's page and will never collect your Amex password in this app."
          : "Current status: you can create a local Japan import-only account. The chooser accepts official CSV/Excel/QIF/PDF files for preview selection; only CSV/QIF parser foundations exist in this scaffold, and nothing is committed yet."
      );
    });
  });
  byId("wizard-back").addEventListener("click", () => {
    wizardStep = Math.max(1, wizardStep - 1);
    showWizardStep();
  });
  byId("wizard-next").addEventListener("click", () => {
    if (wizardStep === 2 && !selectedAccountPath) {
      showToast("Choose one of the four account paths before continuing.");
      return;
    }
    wizardStep = Math.min(5, wizardStep + 1);
    showWizardStep();
  });
  byId("wizard-finish").addEventListener("click", () => {
    writeLocalSetting("amex-onboarding-complete", "true");
    if (selectedAccountPath) (byId("add-account-type") as HTMLSelectElement).value = selectedAccountPath;
    showSection("overview");
    showToast("Getting started is complete. You can reopen it from the sidebar or Settings.");
  });
  showWizardStep();
}

function showWizardStep(): void {
  document.querySelectorAll<HTMLElement>("[data-wizard-step]").forEach((step) => {
    step.hidden = Number(step.dataset.wizardStep) !== wizardStep;
  });
  document.querySelectorAll<HTMLElement>("[data-wizard-dot]").forEach((dot) => {
    dot.classList.toggle("active", Number(dot.dataset.wizardDot) <= wizardStep);
  });
  setText("wizard-step-number", String(wizardStep));
  (byId("wizard-back") as HTMLButtonElement).disabled = wizardStep === 1;
  (byId("wizard-next") as HTMLButtonElement).hidden = wizardStep === 5;
  (byId("wizard-finish") as HTMLButtonElement).hidden = wizardStep !== 5;
}

function renderTestDrive(result: LocalTestDriveResult): void {
  const container = byId("test-drive-results");
  container.replaceChildren();
  container.classList.remove("empty-state");
  for (const check of result.checks) {
    const row = element("div", `test-result ${check.passed ? "passed" : "failed"}`);
    row.append(
      element("span", "test-icon", check.passed ? "✓" : "!"),
      element("strong", undefined, check.label),
      element("small", undefined, check.detail)
    );
    container.append(row);
  }
}

function readLocalSetting(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeLocalSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Onboarding still works for the current run if local UI preferences cannot persist.
  }
}

function renderAlerts(alerts: AlertSummaryView[]): void {
  const container = byId("alerts-list");
  container.replaceChildren();
  container.classList.toggle("empty-state", alerts.length === 0);
  if (alerts.length === 0) {
    container.textContent = "No review alerts in this portfolio.";
    return;
  }
  for (const alert of alerts) {
    const card = element("article", "alert-card");
    const icon = element("div", "alert-icon", "!");
    const details = element("div");
    details.append(element("strong", undefined, alert.title));
    details.append(element("p", undefined, alert.explanation));
    const meta = element("small", undefined, `${alert.accountId} · ${new Date(alert.detectedAt).toLocaleString()} · ${alert.severity}`);
    card.append(icon, details, meta);
    container.append(card);
  }
}

function renderAudit(audit: AuditSummaryView[]): void {
  const overview = byId("overview-audit");
  overview.replaceChildren();
  overview.classList.toggle("empty-state", audit.length === 0);
  if (audit.length === 0) overview.textContent = "No audit events yet.";
  for (const event of audit.slice(0, 5)) {
    const row = element("div", "timeline-row");
    const details = element("div");
    details.append(element("strong", undefined, event.action.replaceAll("_", " ")));
    details.append(element("small", undefined, `${event.target} · ${event.outcome}`));
    row.append(element("span", "timeline-dot"), details, element("time", undefined, new Date(event.occurredAt).toLocaleTimeString()));
    overview.append(row);
  }

  const body = byId("audit-body");
  body.replaceChildren();
  if (audit.length === 0) {
    const row = document.createElement("tr");
    const empty = element("td", "empty-cell", "No audit events yet.");
    empty.setAttribute("colspan", "4");
    row.append(empty);
    body.append(row);
    return;
  }
  for (const event of audit) {
    const row = document.createElement("tr");
    row.append(cell(new Date(event.occurredAt).toLocaleString()), cell(event.action), cell(event.target), statusCell(event.outcome));
    body.append(row);
  }
}

function statusCell(value: string): HTMLTableCellElement {
  const tableCell = document.createElement("td");
  tableCell.append(element("span", `status ${statusClass(value)}`, value.replaceAll("_", " ")));
  return tableCell;
}

function statusClass(value: string): string {
  const normalized = value.toLowerCase();
  if (["authorized", "import_only", "available", "success", "synced", "current"].some((term) => normalized.includes(term))) return "";
  if (["failed", "denied", "expired", "revoked", "error"].some((term) => normalized.includes(term))) return "bad";
  return "warn";
}

function isAuthorized(value: string): boolean {
  return value === "authorized" || value === "import_only" || value === "not_applicable";
}

function showToast(message: string): void {
  const toast = byId("notice");
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 6500);
}

function cell(value: string): HTMLTableCellElement {
  return element("td", undefined, value);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing renderer element: ${id}`);
  return node;
}
