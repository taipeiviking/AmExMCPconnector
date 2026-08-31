export class FinanceCoreError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends FinanceCoreError {
  public constructor(resource: string, id: string) {
    super(`${resource} was not found`, "NOT_FOUND", { resource, id });
  }
}

export class AuthorizationRequiredError extends FinanceCoreError {
  public constructor(accountId: string, reason?: string) {
    super("Account reauthorization is required before financial data can be read", "REAUTHORIZATION_REQUIRED", {
      accountId,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

export class AccountUnavailableError extends FinanceCoreError {
  public constructor(accountId: string, state: string, reason?: string) {
    super("Account is not currently available for financial queries", "ACCOUNT_UNAVAILABLE", {
      accountId,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

export class ValidationError extends FinanceCoreError {
  public constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message, "VALIDATION_ERROR", details);
  }
}

export class ExportApprovalError extends FinanceCoreError {
  public constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message, "EXPORT_APPROVAL_REQUIRED", details);
  }
}

export class DuplicateExportError extends FinanceCoreError {
  public constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message, "DUPLICATE_EXPORT", details);
  }
}
