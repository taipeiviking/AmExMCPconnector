import { describe, expect, it } from "vitest";
import {
  parsePlaidAccounts,
  requireSinglePlaidPersonalCard,
  toNormalizedPlaidAccount,
} from "../../src/integrations/plaid-response-mapping";

describe("Plaid U.S. personal account classification", () => {
  it("preserves and accepts Plaid's explicit personal holder category", () => {
    const account = parseSingleAccount("personal");

    expect(account.holder_category).toBe("personal");
    expect(requireSinglePlaidPersonalCard([account])).toBe(account);
    expect(toNormalizedPlaidAccount(account, "active")).toMatchObject({
      account_class: "personal",
      country: "US",
      currency: "USD",
    });
  });

  it("rejects a card that Plaid explicitly classifies as business", () => {
    const account = parseSingleAccount("business");

    expect(() => requireSinglePlaidPersonalCard([account])).toThrow(/business account/iu);
    expect(() => toNormalizedPlaidAccount(account, "active")).toThrow(/personal card/iu);
  });

  it.each([undefined, null, "unrecognized"] as const)(
    "allows holder_category=%s only under the owner's explicit U.S.-personal attestation",
    (holderCategory) => {
      const account = parseSingleAccount(holderCategory);

      expect(account.holder_category).toBe(holderCategory);
      expect(toNormalizedPlaidAccount(account, "active").account_class).toBe("personal");
    },
  );

  it("fails closed on a future or malformed holder category", () => {
    expect(() => parseSingleAccount("corporate")).toThrow(/account list/iu);
  });
});

function parseSingleAccount(holderCategory: unknown) {
  const account = {
    account_id: "plaid-card-account",
    balances: {
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    mask: "1000",
    name: "Plaid Credit Card",
    official_name: "Plaid Credit Card",
    type: "credit",
    subtype: "credit card",
    ...(holderCategory === undefined ? {} : { holder_category: holderCategory }),
  };
  return parsePlaidAccounts({ accounts: [account] })[0]!;
}
