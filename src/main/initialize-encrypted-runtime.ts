import { randomUUID } from "node:crypto";
import type { AuditEvent, CoreSnapshot } from "../core";

interface InitializableRuntime {
  store: {
    loadSnapshot(): Promise<CoreSnapshot>;
    replaceSnapshotWithAudit(snapshot: CoreSnapshot, event: AuditEvent): Promise<void>;
    close(options?: { save?: boolean }): Promise<void>;
  };
}

/** Completes first-run initialization or closes the decrypted runtime before
 * propagating any initialization failure. */
export async function initializeEncryptedRuntime<T extends InitializableRuntime>(
  encrypted: T,
  portfolioId: string,
  now: () => Date = () => new Date()
): Promise<T> {
  try {
    const snapshot = await encrypted.store.loadSnapshot();
    if (!snapshot.portfolios.some((portfolio) => portfolio.id === portfolioId)) {
      const occurredAt = now().toISOString();
      const initializedSnapshot: CoreSnapshot = {
        ...snapshot,
        portfolios: [
          ...snapshot.portfolios,
          {
            id: portfolioId,
            name: "Owner portfolio",
            accountIds: [],
            ownerControlled: true,
            storageScope: "this_device_only",
            createdAt: occurredAt,
            updatedAt: occurredAt
          }
        ]
      };
      const auditEvent: AuditEvent = {
        id: randomUUID(),
        occurredAt,
        action: "portfolio_initialized",
        outcome: "success",
        accountIds: [],
        portfolioId,
        metadata: { source: "desktop_first_run" }
      };
      await encrypted.store.replaceSnapshotWithAudit(initializedSnapshot, auditEvent);
    }
    return encrypted;
  } catch (error) {
    await encrypted.store.close({ save: false }).catch(() => undefined);
    throw error;
  }
}
