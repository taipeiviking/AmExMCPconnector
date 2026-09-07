import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { ExportPlan, HumanExportApproval } from "./types";
import { ExportApprovalError } from "../errors";

const CONFIRMATION_PHRASE = "CREATE_EXPORT_FILES";

interface ApprovalTokenPayload {
  readonly version: 1;
  readonly planId: string;
  readonly requestDigest: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

/**
 * Produces short-lived, plan-bound approvals. Construct it with a key obtained from encrypted local storage.
 */
export class HmacExportApprovalAuthority {
  readonly #secret: Buffer;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #consumedTokenDigests = new Map<string, number>();
  #closed = false;

  public constructor(secret: Uint8Array, options: { readonly now?: () => Date; readonly ttlMs?: number } = {}) {
    if (secret.byteLength < 32) {
      throw new ExportApprovalError("Export approval key must contain at least 32 bytes");
    }
    this.#secret = Buffer.from(secret);
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  }

  public approve(input: {
    readonly plan: ExportPlan;
    readonly approvedBy: string;
    readonly confirmation: string;
  }): HumanExportApproval {
    this.#assertOpen();
    if (input.confirmation !== CONFIRMATION_PHRASE) {
      throw new ExportApprovalError("The human approval confirmation phrase was not provided");
    }
    if (input.approvedBy.trim().length === 0) {
      throw new ExportApprovalError("Approval actor must be recorded");
    }
    const approvedAt = this.#now().toISOString();
    const payload: ApprovalTokenPayload = {
      version: 1,
      planId: input.plan.id,
      requestDigest: input.plan.requestDigest,
      approvedAt,
      approvedBy: input.approvedBy.trim(),
      expiresAt: new Date(this.#now().getTime() + this.#ttlMs).toISOString(),
      nonce: randomUUID(),
    };
    return {
      approved: true,
      planId: payload.planId,
      requestDigest: payload.requestDigest,
      approvedAt,
      approvedBy: payload.approvedBy,
      token: this.#encode(payload),
    };
  }

  public assertApproved(plan: ExportPlan, approval: HumanExportApproval): void {
    this.#assertOpen();
    this.#validateApproval(plan, approval);
  }

  /**
   * Atomically validates and consumes one approval for generation. The check
   * and insertion are synchronous, so competing calls on this authority cannot
   * both pass before either records consumption.
   */
  public consumeApproval(plan: ExportPlan, approval: HumanExportApproval): void {
    this.#assertOpen();
    const payload = this.#validateApproval(plan, approval);
    this.#pruneConsumed();
    const tokenDigest = createHash("sha256").update(approval.token, "utf8").digest("hex");
    if (this.#consumedTokenDigests.has(tokenDigest)) {
      throw new ExportApprovalError("Export approval token has already been used", { planId: plan.id });
    }
    this.#consumedTokenDigests.set(tokenDigest, Date.parse(payload.expiresAt));
  }

  #validateApproval(plan: ExportPlan, approval: HumanExportApproval): ApprovalTokenPayload {
    if (approval.approved !== true || approval.planId !== plan.id || approval.requestDigest !== plan.requestDigest) {
      throw new ExportApprovalError("Approval does not match this export plan");
    }
    const [payloadPart, signaturePart, extra] = approval.token.split(".");
    if (payloadPart === undefined || signaturePart === undefined || extra !== undefined) {
      throw new ExportApprovalError("Approval token is malformed");
    }
    const expected = createHmac("sha256", this.#secret).update(payloadPart).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signaturePart, "base64url");
    } catch {
      throw new ExportApprovalError("Approval token signature is malformed");
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ExportApprovalError("Approval token signature is invalid");
    }
    let payload: ApprovalTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as ApprovalTokenPayload;
    } catch {
      throw new ExportApprovalError("Approval token payload is invalid");
    }
    if (
      payload.version !== 1 ||
      payload.planId !== plan.id ||
      payload.requestDigest !== plan.requestDigest ||
      payload.approvedAt !== approval.approvedAt ||
      payload.approvedBy !== approval.approvedBy ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length === 0
    ) {
      throw new ExportApprovalError("Approval token is not bound to this plan and actor");
    }
    if (Date.parse(payload.expiresAt) <= this.#now().getTime()) {
      throw new ExportApprovalError("Approval token has expired");
    }
    return payload;
  }

  #encode(payload: ApprovalTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  #pruneConsumed(): void {
    const now = this.#now().getTime();
    for (const [digest, expiresAt] of this.#consumedTokenDigests) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) this.#consumedTokenDigests.delete(digest);
    }
  }

  /** Overwrites the retained approval key when the encrypted runtime locks. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#secret.fill(0);
    this.#consumedTokenDigests.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new ExportApprovalError("Export approval authority is closed");
  }
}

export const HUMAN_EXPORT_CONFIRMATION_PHRASE = CONFIRMATION_PHRASE;
