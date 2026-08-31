import type { AmexAccount, AuthorizationSnapshot } from "./domain";
import { AccountUnavailableError, AuthorizationRequiredError } from "./errors";

export interface AuthorizationChecker {
  /** Checks local/import state and, when configured, the approved provider's current consent state. */
  check(account: AmexAccount): Promise<AuthorizationSnapshot>;
}

export class StoredAuthorizationChecker implements AuthorizationChecker {
  readonly #now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public async check(account: AmexAccount): Promise<AuthorizationSnapshot> {
    const current = account.authorization;
    if (
      current.state === "authorized" &&
      current.expiresAt !== undefined &&
      Date.parse(current.expiresAt) <= this.#now().getTime()
    ) {
      return {
        state: "reauthorization_required",
        checkedAt: this.#now().toISOString(),
        reason: "authorization_expired",
      };
    }
    return structuredClone(current);
  }
}

export function authorizationAction(snapshot: AuthorizationSnapshot):
  | "none"
  | "reauthorize"
  | "wait"
  | "check_provider" {
  switch (snapshot.state) {
    case "authorized":
    case "import_only":
      return "none";
    case "reauthorization_required":
    case "revoked":
      return "reauthorize";
    case "pending":
      return "wait";
    case "unavailable":
      return "check_provider";
  }
}

export function assertAccountReadable(account: AmexAccount, snapshot: AuthorizationSnapshot): void {
  if (!account.active) {
    throw new AccountUnavailableError(account.id, "inactive", "account_disabled_locally");
  }
  if (snapshot.state === "authorized" || snapshot.state === "import_only") return;
  if (snapshot.state === "reauthorization_required" || snapshot.state === "revoked") {
    throw new AuthorizationRequiredError(account.id, snapshot.reason);
  }
  throw new AccountUnavailableError(account.id, snapshot.state, snapshot.reason);
}
