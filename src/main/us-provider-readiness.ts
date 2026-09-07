import type { AppConfiguration } from "../config/environment";
import {
  SecretReferenceError,
  type SecretReferenceResolver
} from "../security/secret-reference";
import type {
  UsProviderReadiness,
  UsProviderReadinessStep
} from "../shared/ipc";

export interface UsProviderReadinessInput {
  readonly configuration: AppConfiguration;
  readonly storageState: "locked" | "unlocked" | "unavailable";
  readonly runtimeAvailable: boolean;
  readonly runtimeError?: string;
  readonly credentialResolver: SecretReferenceResolver;
  readonly providerEnvironment?: "sandbox" | "production";
  readonly now?: () => Date;
}

const SAFEGUARDS = Object.freeze({
  readOnly: true as const,
  amexPasswordAccepted: false as const,
  secretsExposed: false as const
});

/**
 * Performs the local checks needed before opening an approved provider's
 * consent page. The result is intentionally safe to expose to the trusted
 * renderer: it contains no credential target names, secret bytes, endpoints,
 * OAuth values, or provider response details.
 */
export async function preflightUsProvider(
  input: UsProviderReadinessInput
): Promise<UsProviderReadiness> {
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  if (input.storageState !== "unlocked") {
    return result(
      "storage-unavailable",
      checkedAt,
      "Unlock local data first",
      input.storageState === "locked"
        ? "Your encrypted local data is locked. Open the app from the system tray, then check U.S. setup again."
        : "Encrypted local data is unavailable, so the app cannot safely save a separate account authorization.",
      [
        step(
          "restart-app",
          "action-required",
          "Unlock the encrypted app",
          "Open the dashboard from the system tray. If unlocking fails, review the local storage notice before continuing."
        ),
        japanImportStep()
      ]
    );
  }

  const raw = input.configuration.raw;
  const plaid = raw.AMEX_US_AGGREGATOR === "plaid";
  if (raw.AMEX_US_AGGREGATOR === "disabled") {
    return result(
      "disabled",
      checkedAt,
      "U.S. connection is not set up yet",
      "This installation does not include direct American Express access. A separately approved read-only data provider must be arranged and configured before U.S. sign-in can start.",
      [
        step(
          "provider-access",
          "action-required",
          "Arrange approved provider access",
          "Choose a consent-based provider that is contractually approved for the U.S. personal or company accounts you need. Confirm its actual Amex coverage and read-only scopes."
        ),
        step(
          "provider-settings",
          "action-required",
          "Enter the reviewed provider settings",
          "An administrator must configure the provider's HTTPS and OAuth settings for this installation. The app does not guess endpoints or scrape the Amex website."
        ),
        step(
          "windows-credentials",
          "action-required",
          "Store provider app credentials in Windows",
          "Save the provider client values as Windows Generic Credentials and configure only their protected references. Never put secrets or an Amex password in an environment file."
        ),
        step(
          "restart-app",
          "action-required",
          "Restart and check setup",
          "Restart the tray app after changing provider settings, then run the U.S. setup check again before adding an account."
        ),
        japanImportStep()
      ]
    );
  }

  if (!input.runtimeAvailable) {
    return result(
      "configuration-error",
      checkedAt,
      plaid ? "Plaid setup needs attention" : "U.S. provider settings need attention",
      plaid
        ? "The built-in Plaid read-only connector could not start safely. Re-save the U.S. personal setup or restart the tray app; no account was added and no sign-in was opened."
        : "The approved provider adapter could not be started safely. No account was added and no sign-in was opened.",
      [
        step(
          "provider-settings",
          "action-required",
          "Review the provider configuration",
          input.runtimeError
            ? "Correct the provider settings described in the app notice, then restart the tray app. Do not paste credentials into logs or support messages."
            : "Confirm that the reviewed HTTPS endpoints, loopback redirect, response profile, and read-only scopes are complete, then restart the tray app."
        ),
        step(
          "windows-credentials",
          "action-required",
          "Keep credentials in Windows Credential Manager",
          "Configuration must contain protected credential references only, never provider secret values or an Amex password."
        ),
        japanImportStep()
      ]
    );
  }

  const references = [
    raw.AMEX_US_AGGREGATOR_CLIENT_ID_REF,
    raw.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF
  ];
  if (references.some((reference) => reference === undefined || !input.credentialResolver.supports(reference))) {
    return invalidCredentialReference(checkedAt);
  }

  try {
    for (const reference of references as string[]) {
      const secret = await input.credentialResolver.resolve(reference);
      try {
        if (!isValidCredentialText(secret)) return invalidCredentialValue(checkedAt);
      } finally {
        secret.fill(0);
      }
    }
  } catch (error) {
    return credentialFailure(checkedAt, error);
  }

  return result(
    "ready",
    checkedAt,
    plaid ? "Ready to connect a U.S. personal card" : "Ready for read-only provider consent",
    plaid
      ? `The Plaid ${input.providerEnvironment ?? raw.AMEX_US_AGGREGATOR_ENVIRONMENT} app credentials are present in Windows Credential Manager. The next step opens Plaid Hosted Link in your browser; your Amex sign-in is never entered in this app.`
      : "The approved provider adapter and both protected Windows credential references passed local checks. The next step may open that provider's consent page in your browser.",
    [
      step(
        "provider-settings",
        "complete",
        plaid ? "Plaid connector settings loaded" : "Approved provider settings validated",
        plaid
          ? "The connector will use Plaid's fixed HTTPS API, Hosted Link, U.S. credit/charge-card filtering, and the Transactions product only. Production availability is checked during consent."
          : "The configured adapter uses explicit HTTPS endpoints, an IPv4 loopback callback, and reviewed read-only scopes."
      ),
      step(
        "windows-credentials",
        "complete",
        "Protected credentials found",
        "Both provider application credentials were read from Windows Credential Manager and immediately cleared from check memory."
      ),
      step(
        "provider-access",
        "available",
        plaid ? "Continue to Plaid Hosted Link" : "Continue to provider consent",
        "Review the provider page carefully and authorize only the single intended account. This app will never ask you to type an Amex password into its own window."
      )
    ],
    true
  );
}

function credentialFailure(checkedAt: string, error: unknown): UsProviderReadiness {
  if (error instanceof SecretReferenceError && error.code === "SECRET_NOT_FOUND") {
    return result(
      "credentials-missing",
      checkedAt,
      "Provider credentials were not found",
      "One or both protected provider application credentials are missing from Windows Credential Manager. No account was added and no sign-in was opened.",
      [
        step(
          "windows-credentials",
          "action-required",
          "Save the provider app credentials",
          "Use the built-in U.S. personal setup to save the client ID and matching environment secret in Windows Credential Manager. Never enter an Amex password here."
        ),
        japanImportStep()
      ]
    );
  }
  if (
    error instanceof SecretReferenceError &&
    (error.code === "INVALID_REFERENCE" || error.code === "UNSUPPORTED_REFERENCE")
  ) {
    return invalidCredentialReference(checkedAt);
  }
  return result(
    "credential-store-unavailable",
    checkedAt,
    "Windows Credential Manager could not be checked",
    "The protected credential store is unavailable right now. No account was added and no sign-in was opened.",
    [
      step(
        "windows-credentials",
        "action-required",
        "Check Windows Credential Manager",
        "Confirm that Windows Credential Manager is available for this signed-in Windows user, then retry. Do not move secret values into an environment file as a workaround."
      ),
      japanImportStep()
    ]
  );
}

function invalidCredentialReference(checkedAt: string): UsProviderReadiness {
  return result(
    "configuration-error",
    checkedAt,
    "Protected credential references need attention",
    "The provider configuration does not contain two supported Windows Credential Manager references. No secret value was read or exposed.",
    [
      step(
        "provider-settings",
        "action-required",
        "Correct the protected references",
        "Use wincred references for the provider client ID and client secret. Store the values themselves only as Windows Generic Credentials."
      ),
      japanImportStep()
    ]
  );
}

function invalidCredentialValue(checkedAt: string): UsProviderReadiness {
  return result(
    "configuration-error",
    checkedAt,
    "A protected provider credential is invalid",
    "A referenced Windows credential was found but is not valid provider application text. Its value was cleared from check memory and was not displayed.",
    [
      step(
        "windows-credentials",
        "action-required",
        "Replace the invalid provider credential",
        "Update the referenced Windows Generic Credential with the exact provider-issued application value, then check setup again. Never use an Amex password."
      ),
      japanImportStep()
    ]
  );
}

function isValidCredentialText(secret: Uint8Array): boolean {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(secret);
    return value.length >= 1 && value.length <= 8192 && !/[\u0000\r\n]/u.test(value);
  } catch {
    return false;
  }
}

function result(
  state: UsProviderReadiness["state"],
  checkedAt: string,
  headline: string,
  explanation: string,
  steps: UsProviderReadinessStep[],
  canStartConsent = false
): UsProviderReadiness {
  return {
    state,
    canStartConsent,
    checkedAt,
    headline,
    explanation,
    steps,
    safeguards: { ...SAFEGUARDS }
  };
}

function step(
  id: UsProviderReadinessStep["id"],
  status: UsProviderReadinessStep["status"],
  label: string,
  guidance: string
): UsProviderReadinessStep {
  return { id, status, label, guidance };
}

function japanImportStep(): UsProviderReadinessStep {
  return step(
    "choose-japan-import",
    "available",
    "Or test with a Japan statement now",
    "Japan personal and company accounts use official CSV, Excel, QIF, or text-based PDF exports locally and do not need provider credentials."
  );
}
