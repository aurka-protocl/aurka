import { randomUUID } from "node:crypto";

import type { DelegatedSessionService } from "./delegated.js";
import type { ServiceRepository } from "../db/repository.js";

export class DelegatedAgentWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly leaseId = randomUUID();
  private readonly intervalMs: number;
  private readonly leaseSeconds: number;

  constructor(
    private readonly delegated: DelegatedSessionService,
    private readonly repository: ServiceRepository,
    options: {
      readonly intervalMs?: number;
      readonly leaseSeconds?: number;
    } = {},
  ) {
    this.intervalMs =
      options.intervalMs ??
      Number(process.env.AURKA_AGENT_WORKER_INTERVAL_MS ?? "15000");
    this.leaseSeconds = options.leaseSeconds ?? 60;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const sessions = this.repository
        .listDelegatedSessions()
        .filter((session) => session.state === "ACTIVE");
      for (const session of sessions) {
        const expiresAt = now + this.leaseSeconds;
        if (
          !this.repository.claimDelegatedWorkerLease(
            session.id,
            this.leaseId,
            expiresAt,
            now,
          )
        )
          continue;
        try {
          await this.delegated.tick(
            session.id,
            "Continue the previously approved mandate using only its reviewed Space and limits.",
          );
        } catch {
          // The session and trade state contain the durable failure. The next
          // loop may reconcile a transient RPC/receipt problem.
        } finally {
          this.repository.releaseDelegatedWorkerLease(session.id, this.leaseId);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
