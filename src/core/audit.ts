export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly accountIds: readonly string[];
  readonly portfolioId?: string;
  /** Metadata must contain identifiers/counts only, never statement or transaction content. */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export class NullAuditSink implements AuditSink {
  public async append(_event: AuditEvent): Promise<void> {
    // Intentionally empty. Production wiring should supply an encrypted durable sink.
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly #events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.#events.push(structuredClone(event));
  }

  public list(): readonly AuditEvent[] {
    return structuredClone(this.#events);
  }
}
