import type {
  AccountSummaryView,
  AlertSummaryView,
  AuditSummaryView,
  DesktopAction,
  DesktopActionResult,
  DesktopRequest,
  LocalTestDriveResult,
  DesktopSnapshot,
  UsProviderReadiness
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
let latestSnapshot: DesktopSnapshot | undefined;
let latestProviderReadiness: UsProviderReadiness | undefined;
let pendingImportPreviewId: string | undefined;

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
byId("add-account-type").addEventListener("change", updateAccountTypeGuidance);
byId("open-guided-setup").addEventListener("click", () => {
  wizardStep = 1;
  showWizardStep();
  showSection("getting-started");
});
byId("import-button").addEventListener("click", () => void importStatement());
byId("approve-import-button").addEventListener("click", () => void approveImport());
byId("cancel-import-button").addEventListener("click", () => void cancelImport());
byId("export-button").addEventListener("click", () => void prepareExport());
byId("save-portfolio").addEventListener("click", () => void savePortfolio());
byId("export-format").addEventListener("change", updateExportFields);
byId("tunnel-start").addEventListener("click", () => void performAction({ kind: "set-tunnel-running", running: true }));
byId("tunnel-stop").addEventListener("click", () => void performAction({ kind: "set-tunnel-running", running: false }));
updateExportFields();
byId("restart-onboarding").addEventListener("click", () => {
  wizardStep = 1;
  showWizardStep();
  showSection("getting-started");
});
byId("screenshot-protection-toggle").addEventListener("click", () => {
  const enabled = latestSnapshot?.privacy.screenshotProtectionEnabled;
  if (enabled !== undefined) void performAction({ kind: "set-screenshot-protection", enabled: !enabled });
});
byId("restore-screenshot-protection").addEventListener("click", () => {
  void performAction({ kind: "set-screenshot-protection", enabled: true });
});
byId("open-plaid-dashboard").addEventListener("click", () => void performAction("open-plaid-dashboard"));
byId("save-plaid-settings").addEventListener("click", () => void configurePlaid());
byId("cancel-plaid-setup").addEventListener("click", () => {
  byId("plaid-setup-card").hidden = true;
});
byId("plaid-environment").addEventListener("change", updatePlaidEnvironmentHelp);
byId("remove-plaid-credentials").addEventListener("click", () => {
  void performAction({ kind: "remove-plaid-credentials" });
});
updatePlaidEnvironmentHelp();

showSection(readLocalSetting("amex-onboarding-complete") === "true" ? "overview" : "getting-started");
void initializeRenderer();

async function initializeRenderer(): Promise<void> {
  await refresh();
  try {
    const result = await window.amexConnector.performAction("preflight-us-provider");
    if (result.providerReadiness) renderProviderReadiness(result.providerReadiness);
  } catch {
    // Snapshot-based gating remains fail-closed if the optional readiness check fails.
  }
}

function showSection(section: string): void {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.getAttribute("data-section") === section));
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === section));
  setText("page-title", titles[section] ?? "Overview");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function performAction(request: DesktopRequest): Promise<void> {
  try {
    const result = await window.amexConnector.performAction(request);
    showToast(result.message);
    if (result.providerReadiness) renderProviderReadiness(result.providerReadiness);
    if (result.testDrive) renderTestDrive(result.testDrive);
    if (result.importPreview) {
      renderImportPreview(result.importPreview);
      showSection("imports");
      focusPanel("import-preview");
    }
    if (result.importSummary) renderImportSummary(result.importSummary);
    if (result.exportSummary) renderExportSummary(result.exportSummary);
    if (
      typeof request !== "string" &&
      request.kind === "cancel-jp-import" &&
      result.ok
    ) {
      clearImportPreview("Preview canceled; no local records were changed.");
    }
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
  latestSnapshot = snapshot;
  const environmentPill = byId("environment-pill");
  environmentPill.textContent = snapshot.demoMode ? "Practice data" : "Local data";
  environmentPill.className = `pill ${snapshot.demoMode ? "warn" : "neutral"}`;

  const screenshotsAllowed = !snapshot.privacy.screenshotProtectionEnabled;
  byId("screenshot-pill").hidden = !screenshotsAllowed;
  byId("screenshot-warning").hidden = !screenshotsAllowed;
  const screenshotToggle = byId("screenshot-protection-toggle") as HTMLButtonElement;
  screenshotToggle.hidden = !snapshot.privacy.screenshotControlAvailable;
  screenshotToggle.classList.toggle("capture-allowed", screenshotsAllowed);
  screenshotToggle.setAttribute("aria-pressed", String(screenshotsAllowed));
  setText(
    "screenshot-protection-title",
    screenshotsAllowed ? "Turn screenshot protection back on" : "Allow screenshots this session"
  );
  setText(
    "screenshot-protection-detail",
    screenshotsAllowed
      ? "Capture protection is off. Turn it back on before showing personal financial data."
      : "For development and testing only; this Settings choice is never saved."
  );

  const mcpPill = byId("mcp-pill");
  mcpPill.textContent = snapshot.mcp.state === "running" ? "ChatGPT access · ready" : "ChatGPT · not connected";
  mcpPill.className = `pill ${snapshot.mcp.state === "running" ? "good" : "warn"}`;

  setText("account-count", String(snapshot.accounts.length));
  setText("account-detail", `${snapshot.accounts.filter((account) => account.queryReady).length} ready for ChatGPT questions`);
  setText("alert-count", String(snapshot.alerts.filter((alert) => alert.status === "open").length));
  setText("storage-state", snapshot.storage.state);
  setText("storage-detail", snapshot.storage.protection);
  setText("tunnel-state", snapshot.tunnel.state.replaceAll("-", " "));
  setText("portfolio-name", snapshot.portfolio.name);
  setText("portfolio-id", snapshot.portfolio.id);
  setText("base-currency", snapshot.baseCurrency);
  setText("mcp-endpoint", snapshot.mcp.endpoint ?? "Disabled");
  setText(
    "provider-status",
    snapshot.provider.configured
      ? snapshot.provider.adapter === "plaid"
        ? "Plaid · U.S. personal Transactions only"
        : `${snapshot.provider.adapter} · normalized read-only adapter`
      : snapshot.provider.setupSupported
        ? "Plaid setup available"
        : "Not configured"
  );
  setText("provider-environment", snapshot.provider.configured ? snapshot.provider.environment : "Local-only");
  setText("connection-tunnel-status", snapshot.tunnel.state.replaceAll("-", " "));
  setText("footer-version", `Version ${snapshot.version} · ${new Date(snapshot.generatedAt).toLocaleString()}`);
  updateProviderAvailability(snapshot);
  updatePathGuidance();

  renderAccountOverview(snapshot.accounts);
  renderAccountCards(snapshot.accounts);
  renderPortfolioConfiguration(snapshot);
  renderAlerts(snapshot.alerts);
  renderAudit(snapshot.audit);
  renderOperationAccountChoices(snapshot.accounts);

  const tunnelStart = byId("tunnel-start") as HTMLButtonElement;
  const tunnelStop = byId("tunnel-stop") as HTMLButtonElement;
  tunnelStart.disabled = !snapshot.tunnel.configured || snapshot.tunnel.state === "running" || snapshot.tunnel.state === "starting";
  tunnelStop.disabled = snapshot.tunnel.state !== "running" && snapshot.tunnel.state !== "starting";

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
      element("span", "secure-tag", "Local · encrypted"),
      element("span", account.inPortfolio ? "portfolio-tag" : "muted-tag", account.inPortfolio ? "In portfolio" : "Outside portfolio")
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
      !account.active
        ? "Disconnected"
        : account.connectionType === "read_only_consent"
          ? "Reconnect"
          : "Choose statement"
    );
    reconnect.type = "button";
    reconnect.disabled = !account.active;
    if (!account.active) {
      reconnect.title = "Add a new separately identified account entry to connect again without mixing source history.";
    }
    reconnect.addEventListener("click", () => {
      if (account.connectionType === "official_statement_import") {
        void chooseStatementForAccount(account.id);
        return;
      }
      if (!latestProviderReadiness?.canStartConsent) {
        selectAccountPath(`US-${account.accountClass}`);
        wizardStep = 2;
        showWizardStep();
        showSection("getting-started");
        showToast("U.S. access is not configured yet. The setup guide explains what is needed and offers a safe local test.");
        return;
      }
      void performAction({ kind: "authorize-us-account", accountId: account.id });
    });
    const disconnect = element("button", "button danger-outline", "Disconnect");
    disconnect.type = "button";
    disconnect.disabled = !account.active;
    disconnect.addEventListener("click", () =>
      void performAction({ kind: "disconnect-account", accountId: account.id })
    );
    actions.append(reconnect, disconnect);
    if (!account.active) {
      actions.append(
        element(
          "small",
          "disconnected-guidance",
          "To connect again, add a new account entry so retained history cannot be merged with a different source account."
        )
      );
    }
    card.append(header, tags, labelRow, details, actions);
    container.append(card);
  }
}

async function savePortfolio(): Promise<void> {
  const name = inputValue("portfolio-display-name");
  const accountIds = [...document.querySelectorAll<HTMLInputElement>("#portfolio-membership input[type='checkbox']:checked")]
    .map((input) => input.value);
  if (!name) {
    showToast("Enter a portfolio name before saving its account selection.");
    return;
  }
  await performAction({ kind: "update-portfolio", name, accountIds });
}

function renderPortfolioConfiguration(snapshot: DesktopSnapshot): void {
  const name = byId("portfolio-display-name") as HTMLInputElement;
  if (document.activeElement !== name) name.value = snapshot.portfolio.name;
  name.disabled = !snapshot.portfolio.editable;
  const save = byId("save-portfolio") as HTMLButtonElement;
  save.disabled = !snapshot.portfolio.editable;
  const container = byId("portfolio-membership");
  container.replaceChildren();
  container.classList.toggle("empty-state", snapshot.accounts.length === 0);
  if (snapshot.accounts.length === 0) {
    container.textContent = "Add an account first. New accounts are selected automatically.";
    return;
  }
  for (const account of snapshot.accounts) {
    const row = element("label", "portfolio-account-option");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = account.id;
    checkbox.checked = snapshot.portfolio.accountIds.includes(account.id);
    checkbox.disabled = !snapshot.portfolio.editable || !account.active;
    const detail = element("span");
    detail.append(
      element("strong", undefined, account.name),
      element("small", undefined, `${account.country} · ${account.accountClass} · ${account.legalEntity}${account.active ? "" : " · disconnected"}`),
    );
    row.append(checkbox, detail);
    container.append(row);
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
  if (country === "US" && !latestProviderReadiness?.canStartConsent) {
    updateAccountTypeGuidance();
    showPlaidSetup();
    showToast("Complete the four U.S. personal setup steps first. No account was added and no Amex sign-in was opened.");
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

function showPlaidSetup(): void {
  const type = byId("add-account-type") as HTMLSelectElement;
  type.value = "US-personal";
  updateAccountTypeGuidance();
  const panel = byId("plaid-setup-card");
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  (byId("plaid-environment") as HTMLSelectElement).focus();
}

function updatePlaidEnvironmentHelp(): void {
  const production = (byId("plaid-environment") as HTMLSelectElement).value === "production";
  byId("plaid-redirect-field").hidden = !production;
  byId("plaid-sandbox-help").hidden = production;
  setText("plaid-secret-label", production ? "Plaid Production secret" : "Plaid Sandbox secret");
  setText(
    "plaid-environment-help",
    production
      ? "Production can connect a real account only after Plaid has approved and enabled your app for Transactions."
      : "Sandbox uses synthetic institutions and never connects to your real Amex account."
  );
}

async function configurePlaid(): Promise<void> {
  const environment = (byId("plaid-environment") as HTMLSelectElement).value;
  const clientIdInput = byId("plaid-client-id") as HTMLInputElement;
  const secretInput = byId("plaid-client-secret") as HTMLInputElement;
  const redirectUriInput = byId("plaid-redirect-uri") as HTMLInputElement;
  const confirmed = (byId("plaid-read-only-confirm") as HTMLInputElement).checked;
  const resultPanel = byId("plaid-setup-result");
  const saveButton = byId("save-plaid-settings") as HTMLButtonElement;
  if (!clientIdInput.value.trim() || !secretInput.value.trim()) {
    showToast("Enter the Plaid client ID and the secret for the selected environment.");
    return;
  }
  if (!confirmed) {
    showToast("Confirm the read-only boundary before saving provider credentials.");
    return;
  }
  if (environment !== "sandbox" && environment !== "production") {
    showToast("Choose Sandbox or Production.");
    return;
  }
  saveButton.disabled = true;
  resultPanel.classList.remove("empty-state");
  resultPanel.textContent = `Checking whether Plaid accepts the ${environment} credentials… No account consent is being created.`;
  try {
    const result = await window.amexConnector.performAction({
      kind: "configure-plaid",
      environment,
      clientId: clientIdInput.value.trim(),
      clientSecret: secretInput.value.trim(),
      ...(environment === "production" && redirectUriInput.value.trim()
        ? { redirectUri: redirectUriInput.value.trim() }
        : {}),
      confirmedReadOnly: true
    });
    clientIdInput.value = "";
    secretInput.value = "";
    resultPanel.textContent = result.message;
    showToast(result.message);
    if (result.providerReadiness) renderProviderReadiness(result.providerReadiness);
    if (result.ok) {
      await refresh();
      const readiness = await window.amexConnector.performAction("preflight-us-provider");
      if (readiness.providerReadiness) renderProviderReadiness(readiness.providerReadiness);
    }
  } catch {
    clientIdInput.value = "";
    secretInput.value = "";
    resultPanel.textContent = "Plaid setup could not be verified. No Amex credentials or account authorization were requested.";
    showToast("Plaid setup could not be verified.");
  } finally {
    saveButton.disabled = false;
  }
}

async function chooseStatementForAccount(accountId: string): Promise<void> {
  const select = byId("import-account") as HTMLSelectElement;
  if ([...select.options].some((option) => option.value === accountId)) select.value = accountId;
  showSection("imports");
  byId("import-button").focus();
  await performAction({ kind: "import-jp-statement", accountId });
}

async function importStatement(): Promise<void> {
  const accountId = (byId("import-account") as HTMLSelectElement).value;
  if (!accountId) {
    showToast("Add and select a Japan account before choosing a statement.");
    return;
  }
  const periodStart = inputValue("import-period-start");
  const periodEnd = inputValue("import-period-end");
  const openingBalance = inputValue("import-opening-balance");
  const closingBalance = inputValue("import-closing-balance");
  const reconciliationValues = [periodStart, periodEnd, openingBalance, closingBalance];
  if (reconciliationValues.some(Boolean) && !reconciliationValues.every(Boolean)) {
    showToast("For reconciliation, enter both period dates and both signed balances—or leave all four blank.");
    return;
  }
  await performAction({
    kind: "import-jp-statement",
    accountId,
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    ...(openingBalance ? { openingBalance } : {}),
    ...(closingBalance ? { closingBalance } : {})
  });
}

async function approveImport(): Promise<void> {
  if (pendingImportPreviewId === undefined) {
    showToast("Choose and review a statement before approving it.");
    return;
  }
  await performAction({ kind: "approve-jp-import", previewId: pendingImportPreviewId });
}

async function cancelImport(): Promise<void> {
  if (pendingImportPreviewId === undefined) return;
  await performAction({ kind: "cancel-jp-import", previewId: pendingImportPreviewId });
}

async function prepareExport(): Promise<void> {
  const accountId = (byId("export-account") as HTMLSelectElement).value;
  const account = latestSnapshot?.accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    showToast("Select an account with imported or synchronized transactions.");
    return;
  }
  const format = (byId("export-format") as HTMLSelectElement).value as Extract<DesktopRequest, { kind: "prepare-export" }>["format"];
  const accountName = inputValue("export-account-name") || account.name;
  const accountReference = inputValue("export-account-reference");
  const bankId = inputValue("export-bank-id");
  const liabilityAccount = inputValue("export-liability");
  const expenseAccount = inputValue("export-expense");
  const department = inputValue("export-department");
  const taxCategory = inputValue("export-tax-category");
  const encoding = (byId("export-encoding") as HTMLSelectElement).value as "utf8_bom" | "shift_jis";
  await performAction({
    kind: "prepare-export",
    accountId,
    format,
    accountName,
    ...(accountReference ? { accountReference } : {}),
    ...(bankId ? { bankId } : {}),
    ...(liabilityAccount ? { liabilityAccount } : {}),
    ...(expenseAccount ? { expenseAccount } : {}),
    ...(department ? { department } : {}),
    ...(taxCategory ? { taxCategory } : {}),
    ...(format.startsWith("money_forward_") ? { encoding } : {})
  });
}

function renderOperationAccountChoices(accounts: AccountSummaryView[]): void {
  replaceAccountOptions(
    byId("import-account") as HTMLSelectElement,
    accounts.filter((account) => account.active && account.country === "JP" && account.connectionType === "official_statement_import"),
    "Add a Japan account first"
  );
  replaceAccountOptions(
    byId("export-account") as HTMLSelectElement,
    accounts.filter((account) => account.active && account.queryReady),
    "Import or synchronize transactions first"
  );
}

function replaceAccountOptions(select: HTMLSelectElement, accounts: AccountSummaryView[], emptyLabel: string): void {
  const selected = select.value;
  select.replaceChildren();
  if (accounts.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = `${account.name} · ${account.country} · ${account.accountClass}`;
    select.append(option);
  }
  if (accounts.some((account) => account.id === selected)) select.value = selected;
}

function updateExportFields(): void {
  const format = (byId("export-format") as HTMLSelectElement).value;
  const quickBooks = format.startsWith("quickbooks_");
  const qbo = format === "quickbooks_qbo";
  document.querySelectorAll<HTMLElement>("[data-export-field='quickbooks']").forEach((field) => { field.hidden = !quickBooks; });
  document.querySelectorAll<HTMLElement>("[data-export-field='qbo']").forEach((field) => { field.hidden = !qbo; });
  document.querySelectorAll<HTMLElement>("[data-export-field='money-forward']").forEach((field) => { field.hidden = quickBooks; });
}

function renderImportSummary(summary: NonNullable<Awaited<ReturnType<Window["amexConnector"]["performAction"]>>["importSummary"]>): void {
  pendingImportPreviewId = undefined;
  setImportApprovalButtons(false);
  const result = byId("import-result");
  result.classList.remove("empty-state");
  result.textContent = `${summary.fileName}: imported ${summary.imported} of ${summary.parsed} parsed transactions into the selected encrypted account; skipped ${summary.duplicatesSkipped} duplicate(s); ${summary.warnings} warning(s).`;
}

function renderImportPreview(preview: NonNullable<DesktopActionResult["importPreview"]>): void {
  pendingImportPreviewId = preview.previewId;
  const container = byId("import-preview");
  container.replaceChildren();
  container.classList.remove("empty-state");

  const summary = element("div", "import-preview-summary");
  summary.append(
    detailPair("File", preview.fileName),
    detailPair("Format", `${preview.format.toUpperCase()}${preview.encoding ? ` · ${preview.encoding}` : ""}`),
    detailPair("Rows to review", String(preview.rows.length)),
    detailPair("Signed total", preview.totals.map((total) => `${total.signedTotal} ${total.currency}`).join(" · ") || "—"),
    detailPair("Duplicates", String(preview.duplicateCount)),
    detailPair("Reconciliation", `${preview.reconciliationStatus.replaceAll("_", " ")}${preview.reconciliationDifference ? ` · difference ${preview.reconciliationDifference}` : ""}`),
    detailPair("Local mappings", `${preview.mappingMatchedCount} matched${preview.mappingFingerprint ? ` · ${preview.mappingFingerprint.slice(0, 12)}…` : ""}`),
    detailPair("Source fingerprint", preview.sourceFingerprint),
  );

  const tableWrap = element("div", "import-preview-table-wrap");
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Source row", "Date", "Description", "Signed amount", "Category", "Business purpose"]) {
    const heading = document.createElement("th");
    heading.textContent = label;
    headRow.append(heading);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of preview.rows) {
    const tableRow = document.createElement("tr");
    tableRow.append(
      cell(String(row.sourceRow)),
      cell(row.postedAt),
      cell(row.description),
      cell(`${row.amount} ${row.currency}`),
      cell(row.categoryId ?? "Unassigned"),
      cell(row.businessPurpose ?? "Unassigned"),
    );
    body.append(tableRow);
  }
  table.append(head, body);
  tableWrap.append(table);

  const warningBox = element("div", preview.warningCount > 0 ? "import-warnings" : "import-warnings clear");
  warningBox.append(element("strong", undefined, `${preview.warningCount} warning${preview.warningCount === 1 ? "" : "s"}`));
  if (preview.warnings.length === 0) warningBox.append(element("p", undefined, "No parser warnings."));
  else {
    const list = document.createElement("ul");
    for (const warning of preview.warnings) list.append(element("li", undefined, warning));
    warningBox.append(list);
  }
  const approvalNotice = element(
    "p",
    "guardrail",
    `Review every row above, especially the sign of each amount, before approving. This preview expires at ${new Date(preview.expiresAt).toLocaleTimeString()}; changing the file, account data, or category mapping invalidates it.`,
  );
  container.append(summary, tableWrap, warningBox, approvalNotice);
  setImportApprovalButtons(true);
}

function clearImportPreview(message: string): void {
  pendingImportPreviewId = undefined;
  const container = byId("import-preview");
  container.replaceChildren();
  container.classList.add("empty-state");
  container.textContent = message;
  setImportApprovalButtons(false);
}

function setImportApprovalButtons(visible: boolean): void {
  const approve = byId("approve-import-button") as HTMLButtonElement;
  const cancel = byId("cancel-import-button") as HTMLButtonElement;
  approve.hidden = !visible;
  cancel.hidden = !visible;
}

function renderExportSummary(summary: NonNullable<Awaited<ReturnType<Window["amexConnector"]["performAction"]>>["exportSummary"]>): void {
  const result = byId("export-result");
  result.classList.remove("empty-state");
  const formatNames: Record<string, string> = {
    quickbooks_csv: "QuickBooks CSV",
    quickbooks_qbo: "QuickBooks QBO",
    quickbooks_qfx: "QuickBooks QFX",
    money_forward_statement_csv: "Money Forward statement CSV",
    money_forward_journal_csv: "Money Forward journal CSV",
    money_forward_ledger_csv: "Money Forward ledger CSV"
  };
  result.textContent = summary.warning
    ? `FILES WERE CREATED at ${summary.destinationDirectory}, but local completion evidence needs attention: ${summary.warning} Do not recreate this package. Nothing was uploaded.`
    : `Created and checksum-verified ${summary.files.length} local ${formatNames[summary.format] ?? summary.format} data file(s) plus a manifest for ${summary.exported} transactions at ${summary.destinationDirectory}; skipped ${summary.duplicatesSkipped} duplicate(s). Nothing was uploaded.`;
}

function inputValue(id: string): string {
  return (byId(id) as HTMLInputElement).value.trim();
}

function setupWizard(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-account-path]").forEach((button) => {
    const selected = button.dataset.accountPath === selectedAccountPath;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => {
      selectAccountPath(button.dataset.accountPath ?? "");
    });
  });
  byId("choose-us-personal").addEventListener("click", () => selectAccountPath("US-personal"));
  byId("wizard-safe-start").addEventListener("click", () => void startSafeTest());
  byId("switch-to-safe-path").addEventListener("click", () => void startSafeTest("JP-personal"));
  byId("open-us-setup-from-wizard").addEventListener("click", () => {
    showSection("accounts");
    showPlaidSetup();
  });
  byId("review-us-requirements").addEventListener("click", () => {
    const guidance = byId("path-guidance");
    guidance.textContent = latestProviderReadiness
      ? `${latestProviderReadiness.headline}. ${latestProviderReadiness.explanation}`
      : "U.S. access needs a supported read-only data provider, reviewed OAuth consent settings, and protected Windows secret references. Until this page says Ready for consent, no U.S. account can be added and no sign-in will open. Never enter an Amex password here.";
    guidance.classList.add("setup");
    byId("us-readiness-steps").hidden = false;
    focusPanel("path-guidance");
  });
  byId("wizard-back").addEventListener("click", () => {
    wizardStep = Math.max(1, wizardStep - 1);
    showWizardStep();
  });
  byId("wizard-start-over").addEventListener("click", () => {
    selectAccountPath("");
    wizardStep = 1;
    showWizardStep();
  });
  byId("wizard-next").addEventListener("click", () => {
    if (wizardStep === 2 && !selectedAccountPath) {
      showToast("Choose one of the available paths before continuing.");
      return;
    }
    if (wizardStep === 2 && selectedAccountPath === "US-company") {
      showToast("U.S. company connection is not enabled in this test release. Choose U.S. personal, a Japan path, or the safe test.");
      return;
    }
    wizardStep = Math.min(5, wizardStep + 1);
    showWizardStep();
  });
  byId("wizard-finish").addEventListener("click", () => {
    writeLocalSetting("amex-onboarding-complete", "true");
    if (selectedAccountPath) {
      const type = byId("add-account-type") as HTMLSelectElement;
      const option = [...type.options].find((candidate) => candidate.value === selectedAccountPath);
      if (option && !option.disabled) type.value = selectedAccountPath;
      updateAccountTypeGuidance();
      showSection("accounts");
      if (selectedAccountPath === "US-personal" && !latestProviderReadiness?.canStartConsent) {
        showPlaidSetup();
        showToast("Start with the numbered Plaid setup steps. Never enter an Amex password in this app.");
      } else {
        (byId("add-account-label") as HTMLInputElement).focus();
        showToast("Next, enter a nickname and owner or company. Do not enter a card number or password.");
      }
      return;
    }
    showSection("overview");
    showToast("Safe local setup complete. No real account or external connection was created.");
  });
  showWizardStep();
}

function selectAccountPath(path: string): void {
  selectedAccountPath = path;
  writeLocalSetting("amex-onboarding-path", path);
  document.querySelectorAll<HTMLElement>("[data-account-path]").forEach((candidate) => {
    const selected = candidate.dataset.accountPath === path;
    candidate.classList.toggle("selected", selected);
    candidate.setAttribute("aria-pressed", String(selected));
  });
  updatePathGuidance();
  updateSetupPlan();
  updateFinishGuidance();
  showWizardStep();
}

async function startSafeTest(path?: string): Promise<void> {
  selectAccountPath(path ?? "");
  wizardStep = 4;
  showWizardStep();
  await performAction("run-safe-test-drive");
}

function updatePathGuidance(): void {
  const guidance = byId("path-guidance");
  const recovery = byId("unavailable-path-actions");
  byId("us-readiness-steps").hidden = true;
  guidance.classList.remove("ready", "setup", "blocked");
  recovery.hidden = true;
  if (!selectedAccountPath) {
    setText("path-guidance", "Select one path to see exactly what happens next.");
    return;
  }
  if (!selectedAccountPath.startsWith("US-")) {
    guidance.classList.add("ready");
    setText(
      "path-guidance",
      "Ready now. Create a nickname-only local account, choose an official statement, review every parsed row, and approve the import. No Amex sign-in or password is used."
    );
    return;
  }
  if (selectedAccountPath === "US-company") {
    guidance.classList.add("blocked");
    recovery.hidden = false;
    setText("path-guidance", "U.S. company cards remain unavailable in this test release while their separate business-account behavior is verified. U.S. personal setup is available now.");
    return;
  }
  const configured = latestProviderReadiness?.canStartConsent === true;
  guidance.classList.add(configured ? "ready" : "setup");
  recovery.hidden = false;
  setText(
    "path-guidance",
    configured
      ? `Ready for consent through the configured ${latestSnapshot?.provider.adapter} read-only provider. This is not direct Amex connectivity, and this app never asks for your Amex password.`
      : latestProviderReadiness
        ? `${latestProviderReadiness.headline}. ${latestProviderReadiness.explanation}`
        : "The guided Plaid setup is available now. Add your own Sandbox credentials for a fake test, or Production credentials after Plaid approval for a real Amex connection. No account is added until setup passes."
  );
}

function updateProviderAvailability(snapshot: DesktopSnapshot): void {
  const ready = latestProviderReadiness?.canStartConsent === true;
  document.querySelectorAll<HTMLElement>("[data-account-path][data-us-personal='true']").forEach((card) => {
    card.classList.remove("unavailable");
    card.classList.toggle("setup-needed", !ready);
    card.removeAttribute("aria-disabled");
    const status = card.querySelector<HTMLElement>("[data-provider-status]");
    if (status) {
      status.textContent = ready ? "Ready to connect" : "Setup available";
      status.className = `path-status ${ready ? "current" : "future"}`;
    }
  });
  const welcome = byId("welcome-us-availability");
  welcome.classList.toggle("ready", ready);
  welcome.classList.toggle("waiting", !ready);
  setText("welcome-us-badge", ready ? "Ready to connect" : "Setup available");
  setText("welcome-us-copy", ready
      ? `Plaid ${snapshot.provider.environment} credentials are present in Windows Credential Manager. Each U.S. personal card starts its own read-only Hosted Link consent.`
    : "Open the built-in U.S. personal setup. Sandbox is a fake test; Production requires your own Plaid approval before a real Amex connection.");

  const accountType = byId("add-account-type") as HTMLSelectElement;
  for (const option of [...accountType.options]) {
    if (option.dataset.usPersonal === "true") option.disabled = false;
    if (option.value === "US-company") option.disabled = true;
  }
  if (accountType.selectedOptions[0]?.disabled) accountType.value = "US-personal";
  const availability = byId("account-setup-availability");
  availability.classList.toggle("ready", ready);
  availability.classList.toggle("waiting", !ready);
  setText("account-availability-badge", ready ? "U.S. personal ready" : "U.S. setup included");
  setText("account-availability-title", ready ? "Your Plaid setup is ready for account consent" : "Start with your U.S. personal card");
  setText("account-availability-copy", ready
    ? `Choose U.S. personal below. ${snapshot.provider.environment === "sandbox" ? "This will use fake Sandbox data." : "A real account can connect only if Plaid enabled your Production app."}`
    : "Open the numbered Plaid setup below. You can verify Sandbox without a real account, or use Production after provider approval.");
  setText("plaid-setup-state", ready ? `Ready · ${snapshot.provider.environment}` : "Credentials needed");
  byId("plaid-setup-state").className = `status ${ready ? "" : "warn"}`;
  updateAccountTypeGuidance();
  showWizardStep();
}

function renderProviderReadiness(readiness: UsProviderReadiness): void {
  latestProviderReadiness = readiness;
  const list = byId("us-readiness-steps");
  list.replaceChildren();
  for (const step of readiness.steps) {
    const item = element("li");
    item.append(
      element("strong", undefined, `${step.status === "complete" ? "Ready" : step.status === "available" ? "Option" : "Action needed"}: ${step.label}`),
      document.createTextNode(step.guidance)
    );
    list.append(item);
  }
  if (readiness.canStartConsent) list.hidden = true;
  if (latestSnapshot) updateProviderAvailability(latestSnapshot);
  updatePathGuidance();
}

function updateAccountTypeGuidance(): void {
  const selection = (byId("add-account-type") as HTMLSelectElement).value;
  const usSelected = selection.startsWith("US-");
  const ready = latestProviderReadiness?.canStartConsent === true;
  const guidance = byId("account-type-guidance");
  const addButton = byId("add-account-button") as HTMLButtonElement;
  guidance.classList.toggle("setup", usSelected && !ready);
  guidance.classList.remove("blocked");
  if (usSelected && !ready) {
    guidance.innerHTML = "<strong>Next:</strong> open the numbered Plaid setup, save your app credentials in Windows Credential Manager, and verify them. No account is added and no Amex sign-in opens during this setup check.";
    addButton.textContent = "Set up U.S. personal access";
    addButton.disabled = false;
  } else if (usSelected) {
    guidance.innerHTML = "<strong>Next:</strong> create the local label, then complete the configured provider’s read-only consent. The app never asks for an Amex password.";
    addButton.textContent = "Continue to read-only consent";
    addButton.disabled = false;
  } else {
    guidance.innerHTML = "<strong>Next:</strong> create the local account, then open Statement imports and choose an official statement. Nothing is imported until you approve the preview.";
    addButton.textContent = "Create local Japan account";
    addButton.disabled = false;
  }
}

function updateSetupPlan(): void {
  const list = byId("setup-plan-checklist");
  list.replaceChildren();
  const usPath = selectedAccountPath.startsWith("US-");
  const classLabel = selectedAccountPath.endsWith("company") ? "company" : "personal";
  setText("setup-plan-title", usPath ? `Set up a U.S. ${classLabel} card` : `Set up a Japan ${classLabel} card`);
  setText("setup-plan-intro", usPath
    ? "Each account gets separate read-only consent and keeps its own owner or company label."
    : "The workflow stays local. Start with fake data, then repeat with an official statement when comfortable.");
  const steps: Array<[string, string]> = usPath
    ? [["Create a local label", "Use a nickname and owner/company only—never a card number or password."], ["Review provider consent", "Grant read-only access for this account only."], ["Check status", "The account is query-ready only after consent and synchronization succeed."], ["Choose portfolio access", "Explicitly choose whether it appears in combined local reports."]]
    : [["Create a local label", "Use a nickname and owner/company only—never a card number or password."], ["Choose an official statement", "Use CSV, Excel, QIF, or a text-based PDF exported from Amex Japan."], ["Review every row", "Check dates, amount signs, warnings, duplicates, and reconciliation."], ["Approve or cancel", "Approval stores reviewed rows locally; cancel stores no transactions."], ["Choose portfolio access", "Explicitly choose whether it appears in combined local reports."]];
  for (const [title, detail] of steps) {
    const item = element("li");
    item.append(element("strong", undefined, title), element("span", undefined, detail));
    list.append(item);
  }
}

function updateFinishGuidance(): void {
  const finish = byId("wizard-finish") as HTMLButtonElement;
  if (!selectedAccountPath) {
    setText("finish-title", "Your safe local workspace is ready.");
    setText("finish-guidance", "No real account or connection was created. Explore locally or return to this guide any time.");
    finish.textContent = "Finish and explore locally";
  } else if (selectedAccountPath.startsWith("JP-")) {
    setText("finish-title", "Next: create your local Japan account.");
    setText("finish-guidance", "Enter a nickname and owner/company, then choose an official statement. No Amex sign-in is involved.");
    finish.textContent = "Finish and add my Japan account";
  } else {
    setText("finish-title", "Next: create the local label and review consent.");
    setText("finish-guidance", "The configured read-only provider handles consent. Stop if anything asks this app for an Amex password.");
    finish.textContent = "Finish and add my U.S. account";
  }
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
  const next = byId("wizard-next") as HTMLButtonElement;
  next.hidden = wizardStep === 5;
  next.disabled = wizardStep === 2 && selectedAccountPath === "US-company";
  next.textContent = wizardStep === 2 ? "Continue to my plan" : wizardStep === 4 ? "Continue to finish" : "Continue";
  (byId("wizard-finish") as HTMLButtonElement).hidden = wizardStep !== 5;
  if (wizardStep === 3) updateSetupPlan();
  if (wizardStep === 5) updateFinishGuidance();
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
    const actions = element("div", "alert-actions");
    if (alert.status === "open") {
      for (const [status, label] of [
        ["reviewed", "Mark reviewed"],
        ["dismissed", "Dismiss"],
        ["confirmed_suspicious", "Flag as suspicious"],
      ] as const) {
        const button = element("button", status === "confirmed_suspicious" ? "button danger-outline" : "button quiet", label);
        button.type = "button";
        button.addEventListener("click", () => void performAction({ kind: "set-alert-status", alertId: alert.id, status }));
        actions.append(button);
      }
    } else {
      actions.append(element("span", "tag", `Owner status: ${alert.status.replaceAll("_", " ")}`));
    }
    details.append(actions);
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

function focusPanel(id: string): void {
  const panel = byId(id);
  panel.setAttribute("tabindex", "-1");
  panel.focus({ preventScroll: true });
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
