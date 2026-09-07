import type { PlaidEnvironment } from "./plaid-api-client";

/**
 * Production is intentionally fail-closed on Plaid's exact institution name.
 * Plaid institution IDs are not stable deployment configuration: an institution
 * can have multiple IDs and can migrate between IDs. The ID returned by
 * /item/get is still bound to (and verified against) /institutions/get_by_id.
 */
export const PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES = Object.freeze([
  "American Express",
] as const);

/** Official Plaid Sandbox test institution; it never represents a live account. */
export const PLAID_SANDBOX_TEST_INSTITUTION_NAMES = Object.freeze([
  "First Platypus Bank",
] as const);

export interface PlaidInstitutionPolicy {
  readonly kind: "american-express-production" | "plaid-sandbox-test";
  readonly synthetic: boolean;
  readonly allowedExactNames: ReadonlySet<string>;
}

export function plaidInstitutionPolicyForEnvironment(
  environment: PlaidEnvironment,
): PlaidInstitutionPolicy {
  if (environment === "production") {
    return {
      kind: "american-express-production",
      synthetic: false,
      allowedExactNames: new Set(PLAID_PRODUCTION_AMEX_INSTITUTION_NAMES),
    };
  }
  return {
    kind: "plaid-sandbox-test",
    synthetic: true,
    allowedExactNames: new Set(PLAID_SANDBOX_TEST_INSTITUTION_NAMES),
  };
}
