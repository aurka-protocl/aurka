import { z } from "zod";
import {
  hashRiskCertificate,
  hashRiskReasonCode,
  riskCertificateSchema,
  type riskEvaluateRequestSchema,
  type RiskCertificate,
} from "@aurka/shared";
import {
  encodeRiskSubmission,
  type AurkaWalletAdapter,
  type AuthorizationContext,
  type WalletAction,
} from "@aurka/wallet";
import type { ServiceRepository } from "./db/repository.js";
import type { RiskService } from "./risk-service.js";

export interface RegistryContext {
  policyId: string;
  chainId: number;
  registry: string;
  watchtower: string;
  policyNonce: string;
  authorizationEpoch: string;
  nextNonce: string;
  authorized: boolean;
}
/** All inputs must come from configured server-side Graph/RPC adapters. */
export interface RiskWorkerSources {
  context(positionId: string): Promise<RegistryContext>;
  evaluation(
    positionId: string,
  ): Promise<z.input<typeof riskEvaluateRequestSchema>>;
  receipt(hash: string): Promise<{
    blockNumber: string;
    blockHash: string;
    success: boolean;
  } | null>;
  canonicalHash(blockNumber: string): Promise<string | null>;
  finalizedBlock(): Promise<bigint>;
}
const workflowSchema = z.object({
  certificate: riskCertificateSchema,
  state: z.enum([
    "SIGNED",
    "SUBMITTED",
    "ACTIVE",
    "REVOKED",
    "EXPIRED",
    "FAILED",
  ]),
  transactionHash: z.string().optional(),
  blockHash: z.string().optional(),
});
export interface RiskWorkerOptions {
  repository: ServiceRepository;
  risk: RiskService;
  wallet: AurkaWalletAdapter;
  sources: RiskWorkerSources;
  authorize: (
    request: RiskCertificate | WalletAction,
  ) => Promise<AuthorizationContext>;
  now?: () => number;
  certificateLifetimeSeconds?: number;
  renewalLeadSeconds?: number;
}
/** Durable outbox: persist signatures before sending, and reuse identical calldata on retry. */
export class RiskCertificateWorker {
  private readonly now: () => number;
  constructor(private readonly options: RiskWorkerOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  async tick(positionId: string): Promise<void> {
    const { repository, risk, wallet, sources } = this.options,
      id = `worker:${positionId}`;
    repository.ensureRiskJob(id, positionId, this.now());
    const claim = repository.claimRiskJob(id, this.now());
    if (!claim) return;
    const owns = () => {
      if (!repository.ownsRiskJob(id, claim.attempt))
        throw new Error("Risk worker lease was replaced");
    };
    repository.saveRiskAuditEvent({
      id: `${id}:${claim.attempt}`,
      positionId,
      eventType: "RISK_JOB_ATTEMPT",
      actor: "risk-worker",
      payload: { attempt: claim.attempt },
    });
    try {
      const context = await sources.context(positionId);
      owns();
      const stored = repository.getRiskWorkflow(positionId);
      let workflow = stored ? workflowSchema.parse(stored) : undefined;
      if (workflow && workflow.certificate.expiresAt <= this.now()) {
        repository.saveRiskCertificate(
          hashRiskCertificate(workflow.certificate),
          { ...workflow.certificate, status: "EXPIRED" },
          false,
        );
        repository.saveRiskWorkflow(positionId, {
          ...workflow,
          state: "EXPIRED",
        });
        workflow = undefined;
      }
      if (
        workflow &&
        workflow.state !== "FAILED" &&
        workflow.state !== "REVOKED" &&
        workflow.state !== "EXPIRED"
      ) {
        const c = workflow.certificate;
        if (
          !context.authorized ||
          c.policyNonce !== context.policyNonce ||
          c.watchtowerAuthorizationEpoch !== context.authorizationEpoch ||
          c.verifyingContract.toLowerCase() !==
            context.registry.toLowerCase() ||
          c.watchtower.toLowerCase() !== context.watchtower.toLowerCase() ||
          c.chainId !== context.chainId
        ) {
          workflow.state = "REVOKED";
          repository.saveRiskWorkflow(positionId, workflow);
          repository.saveRiskCertificate(
            hashRiskCertificate(c),
            { ...c, status: "REVOKED" },
            false,
          );
          return;
        }
        if (workflow.transactionHash) {
          const receipt = await sources.receipt(workflow.transactionHash);
          owns();
          const canonical = receipt
            ? await sources.canonicalHash(receipt.blockNumber)
            : null;
          owns();
          if (
            !receipt ||
            canonical?.toLowerCase() !== receipt.blockHash.toLowerCase()
          ) {
            workflow.state = "SUBMITTED";
            repository.saveRiskWorkflow(positionId, workflow);
            repository.saveRiskCertificate(
              hashRiskCertificate(c),
              { ...c, status: "SUBMITTED" },
              false,
            );
            return; // Wait for this hash; never issue a second nonce while outcome is unknown.
          }
          const finalized = await sources.finalizedBlock();
          owns();
          if (
            (
              await sources.canonicalHash(receipt.blockNumber)
            )?.toLowerCase() !== receipt.blockHash.toLowerCase()
          )
            return;
          owns();
          if (BigInt(receipt.blockNumber) > finalized) return;
          workflow.state = receipt.success ? "ACTIVE" : "FAILED";
          workflow.blockHash = receipt.blockHash;
          repository.saveRiskWorkflow(positionId, workflow);
          repository.saveRiskCertificate(
            hashRiskCertificate(c),
            { ...c, status: workflow.state },
            receipt.success,
          );
          if (!receipt.success) return;
          if (
            c.expiresAt >
            this.now() + (this.options.renewalLeadSeconds ?? 60)
          )
            return;
          workflow = undefined;
        } else if (c.expiresAt <= this.now() || c.nonce !== context.nextNonce) {
          repository.saveRiskWorkflow(positionId, {
            ...workflow,
            state: "EXPIRED",
          });
          workflow = undefined;
        }
      } else workflow = undefined;
      if (!context.authorized) throw new Error("Watchtower is not authorized");
      if (!workflow) {
        const input = await sources.evaluation(positionId);
        owns();
        if (
          input.positionId !== positionId ||
          input.chainId !== context.chainId
        )
          throw new Error("Risk source identity mismatch");
        const evaluation = risk.evaluate(
          { ...input, nowSeconds: this.now() },
          "worker",
        ).evaluation;
        const policy = await wallet.getPolicy();
        owns();
        const certificate: RiskCertificate = {
          policyId: context.policyId,
          chainId: context.chainId,
          verifyingContract: context.registry,
          signatureVersion: 2,
          riskMode: evaluation.mode,
          activeBounds: evaluation.selectedBounds,
          activeBoundsHash: evaluation.activeBoundsHash,
          maximumTradeValue: evaluation.maximumTradeValue,
          sourceDigest: evaluation.sourceDigest,
          reasonCode: hashRiskReasonCode(evaluation.reasonCode),
          issuedAt: this.now(),
          expiresAt: Math.min(
            this.now() + (this.options.certificateLifetimeSeconds ?? 300),
            policy.validUntil,
          ),
          nonce: context.nextNonce,
          watchtower: context.watchtower,
          watchtowerAuthorizationEpoch: context.authorizationEpoch,
          policyNonce: context.policyNonce,
        };
        const signature = await wallet.signTypedData(
          certificate,
          await this.options.authorize(certificate),
        );
        owns();
        workflow = {
          certificate: { ...certificate, signature },
          state: "SIGNED",
        };
        repository.saveRiskWorkflow(positionId, workflow);
        risk.saveCertificate(
          { positionId, certificate: workflow.certificate },
          context.registry,
        );
      }
      const policy = await wallet.getPolicy();
      owns();
      const action: WalletAction = {
        operation: "RISK_CERTIFICATE",
        chainId: workflow.certificate.chainId,
        to: workflow.certificate.verifyingContract,
        data: encodeRiskSubmission(workflow.certificate),
        value: "0",
        expiresAt: workflow.certificate.expiresAt,
        policyFingerprint: policy.fingerprint,
      };
      const authorization = await this.options.authorize(action);
      owns();
      const sent = await wallet.simulateAndSend(action, authorization);
      owns();
      if (!sent.transactionHash)
        throw new Error("Wallet returned no transaction hash");
      workflow = {
        ...workflow,
        state: "SUBMITTED",
        transactionHash: sent.transactionHash,
      };
      repository.saveRiskWorkflow(positionId, workflow);
      repository.saveRiskCertificate(
        hashRiskCertificate(workflow.certificate),
        { ...workflow.certificate, status: "SUBMITTED" },
        false,
      );
    } catch (error) {
      if (repository.ownsRiskJob(id, claim.attempt))
        repository.saveRiskAuditEvent({
          id: `${id}:${claim.attempt}:failed`,
          positionId,
          eventType: "RISK_JOB_FAILED",
          actor: "risk-worker",
          payload: { attempt: claim.attempt },
        });
      throw error;
    } finally {
      repository.releaseRiskJob(id, claim.attempt, this.now() + 10);
    }
  }
}

/** Starts a bounded polling loop. Shutdown waits for the current pass. */
export function startRiskWorker(
  worker: RiskCertificateWorker,
  positions: readonly string[],
  onError: (error: unknown) => void,
  intervalMs = 10000,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    running = (async () => {
      for (const position of positions) {
        if (stopped) break;
        try {
          await worker.tick(position);
        } catch (error) {
          onError(error);
        }
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(run, intervalMs);
    });
  };
  run();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
