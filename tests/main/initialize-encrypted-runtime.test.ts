import { describe, expect, it, vi } from "vitest";
import { initializeEncryptedRuntime } from "../../src/main/initialize-encrypted-runtime";

const emptySnapshot = {
  accounts: [],
  portfolios: [],
  transactions: [],
  statements: [],
  fraudAlerts: []
} as const;

function runtime() {
  return {
    store: {
      loadSnapshot: vi.fn(async () => emptySnapshot),
      replaceSnapshotWithAudit: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    }
  };
}

describe("encrypted first-run initialization", () => {
  it.each(["load", "atomic mutation"] as const)("closes decrypted state when %s fails", async (step) => {
    const encrypted = runtime();
    if (step === "load") encrypted.store.loadSnapshot.mockRejectedValueOnce(new Error("load failed"));
    if (step === "atomic mutation") {
      encrypted.store.replaceSnapshotWithAudit.mockRejectedValueOnce(new Error("atomic mutation failed"));
    }

    await expect(
      initializeEncryptedRuntime(encrypted, "owner-main", () => new Date("2026-08-31T00:00:00.000Z"))
    ).rejects.toThrow(`${step} failed`);
    expect(encrypted.store.close).toHaveBeenCalledWith({ save: false });
  });

  it("creates the empty owner portfolio and records its local audit event", async () => {
    const encrypted = runtime();
    await expect(
      initializeEncryptedRuntime(encrypted, "owner-main", () => new Date("2026-08-31T00:00:00.000Z"))
    ).resolves.toBe(encrypted);

    expect(encrypted.store.replaceSnapshotWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({ portfolios: [expect.objectContaining({ id: "owner-main", accountIds: [] })] }),
      expect.objectContaining({ action: "portfolio_initialized", portfolioId: "owner-main" })
    );
    expect(encrypted.store.replaceSnapshotWithAudit).toHaveBeenCalledTimes(1);
    expect(encrypted.store.close).not.toHaveBeenCalled();
  });
});
