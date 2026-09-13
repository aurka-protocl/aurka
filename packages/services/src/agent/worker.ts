import { randomUUID } from "node:crypto";

import type { DelegatedSessionService } from "./delegated.js";
import type { ServiceRepository } from "../db/repository.js";

export class DelegatedAgentWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private readonly leaseId = randomUUID();
  private readonly intervalMs: number;
  private readonly leaseSeconds: number;
  private readonly ready: (() => boolean) | undefined;
  private readonly readyRetryMs = 10_000;

  constructor(
    private readonly delegated: DelegatedSessionService,
    private readonly repository: ServiceRepository,
    options: {
      readonly intervalMs?: number;
      readonly leaseSeconds?: number;
      readonly ready?: () => boolean;
    } = {},
  ) {
    this.intervalMs =
      options.intervalMs ??
      Number(process.env.AURKA_AGENT_WORKER_INTERVAL_MS ?? "15000");
    this.leaseSeconds =
      options.leaseSeconds ??
      Math.max(
        180,
        Number(process.env.AURKA_AGENT_WORKER_LEASE_SECONDS ?? "180"),
      );
    this.ready = options.ready;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.runAndSchedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopping || (this.ready && !this.ready())) return;
    this.running = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const sessions = this.repository
        .listDelegatedSessions()
        .filter(
          (session) =>
            session.state === "ACTIVE" &&
            (session.nextCheckAt === undefined ||
              session.nextCheckAt === null ||
              session.nextCheckAt <= now),
        );
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

  private async runAndSchedule(): Promise<void> {
    try {
      await this.tick();
    } catch {
      // Keep the worker alive if repository or readiness checks fail once.
    } finally {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.stopping || this.timer) return;
    const now = Math.floor(Date.now() / 1000);
    const ready = !this.ready || this.ready();
    let delayMs = ready ? this.intervalMs : this.readyRetryMs;
    if (ready) {
      const nextCheckAt = this.repository
        .listDelegatedSessions()
        .filter((session) => session.state === "ACTIVE")
        .map((session) => session.nextCheckAt)
        .filter((value): value is number => value !== undefined && value !== null)
        .sort((left, right) => left - right)[0];
      if (nextCheckAt !== undefined)
        delayMs = Math.min(
          delayMs,
          Math.max(1_000, (nextCheckAt - now) * 1_000),
        );
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndSchedule();
    }, delayMs);
    this.timer.unref();
  }
}
