import type { z } from "zod";
import {
  riskEvaluateRequestSchema,
  riskCertificateRequestSchema,
  riskPositionResponseSchema,
  hashActiveBounds,
  hashRiskCertificate,
  type RiskEvaluation,
} from "@aurka/shared";
import { evaluateRisk, watchtowerStateSchema } from "@aurka/watchtower";
import { hashBytes } from "./solver/hash.js";
import { verifySignature } from "./solver/signing.js";
import { ServiceError } from "./service.js";
import type { ServiceRepository } from "./db/repository.js";
export {
  riskEvaluateRequestSchema,
  riskEvaluateResponseSchema,
  riskCertificateRequestSchema,
  riskCertificateResponseSchema,
  riskPositionResponseSchema,
} from "@aurka/shared";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
export type EffectiveRisk = z.infer<
  typeof riskPositionResponseSchema
>["effective"];
export type RegistryRiskReader = (
  positionId: string,
  policyId: string,
) => Promise<EffectiveRisk>;
export class RiskService {
  private reader: RegistryRiskReader | undefined;
  private certificateRegistry: string | undefined;
  get diagnostics(): "not_configured" | "unverified" {
    return this.reader || this.certificateRegistry
      ? "unverified"
      : "not_configured";
  }
  configureCertificateRegistry(registry: string): void {
    if (!/^0x[0-9a-fA-F]{40}$/.test(registry))
      throw new Error("Invalid risk registry address");
    this.certificateRegistry = registry;
  }
  configureRegistryReader(reader: RegistryRiskReader): void {
    this.reader = reader;
  }
  async getPositionLive(
    positionId: string,
  ): Promise<z.infer<typeof riskPositionResponseSchema>> {
    const position = this.getPosition(positionId);
    if (!this.reader) return position;
    const policy = this.repository.getPosition(positionId)!;
    const effective = await this.reader(positionId, policy.policy.id);
    return riskPositionResponseSchema.parse({ ...position, effective });
  }
  constructor(
    private readonly repository: ServiceRepository,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  evaluate(
    raw: unknown,
    namespace: "api" | "worker" = "api",
  ): { positionId: string; evaluation: RiskEvaluation } {
    return this.repository.transaction(() => {
      const input = riskEvaluateRequestSchema.parse(raw);
      const position = this.repository.getPosition(input.positionId);
      if (!position)
        throw new ServiceError(
          "POSITION_NOT_FOUND",
          "Position was not found",
          404,
        );
      if (
        input.chainId !== position.chainId ||
        input.hardMaximumTradeValue !==
          position.policy.maximumTransactionValue ||
        canonical(
          input.hardBounds.map((b) => ({
            token: b.token.toLowerCase(),
            minimumWeightBps: b.minimumWeightBps,
            maximumWeightBps: b.maximumWeightBps,
          })),
        ) !==
          canonical(
            position.policy.assets.map((b) => ({
              token: b.token.toLowerCase(),
              minimumWeightBps: b.minimumWeightBps,
              maximumWeightBps: b.maximumWeightBps,
            })),
          )
      )
        throw new ServiceError(
          "RISK_POLICY_MISMATCH",
          "Evaluation must use the position hard policy",
          409,
        );
      if (Math.abs(input.nowSeconds - this.now()) > 5)
        throw new ServiceError(
          "STALE_EVALUATION",
          "Evaluation clock differs from server time",
          409,
        );
      const stateKey = `${namespace}:${input.positionId}`;
      const saved = this.repository.getRiskState(stateKey);
      const currentState = saved
        ? watchtowerStateSchema.parse(saved.state)
        : undefined;
      const configurationHash = hashBytes(canonical(input.configuration));
      if (saved && saved.configurationHash !== configurationHash)
        throw new ServiceError(
          "RISK_CONFIGURATION_CHANGED",
          "A configuration change requires an operator state migration",
          409,
        );
      if (saved && input.nowSeconds < Number(saved.evaluatedAt))
        throw new ServiceError(
          "STALE_EVALUATION",
          "Evaluation predates persisted evidence",
          409,
        );
      if (currentState && input.nowSeconds < currentState.changedAt)
        throw new ServiceError(
          "STALE_EVALUATION",
          "Evaluation predates persisted state",
          409,
        );
      let evaluation;
      const canonicalInput = riskEvaluateRequestSchema
        .omit({ currentState: true })
        .strip()
        .parse(input);
      try {
        evaluation = evaluateRisk({
          ...canonicalInput,
          canonicalBlock: BigInt(input.canonicalBlock),
          ...(currentState ? { currentState } : {}),
        });
      } catch (error) {
        throw new ServiceError(
          "RISK_CONFIGURATION_INVALID",
          error instanceof Error ? error.message : "Invalid evaluation",
          400,
        );
      }
      const changed =
        !currentState ||
        currentState.mode !== evaluation.mode ||
        currentState.activeBoundsHash !== evaluation.activeBoundsHash;
      const state = {
        mode: evaluation.mode,
        activeBounds: evaluation.selectedBounds,
        sourceDigest: evaluation.sourceDigest,
        activeBoundsHash: evaluation.activeBoundsHash,
        maximumTradeValue: evaluation.maximumTradeValue,
        changedAt: changed ? input.nowSeconds : currentState.changedAt,
        cooldownUntil: changed
          ? input.nowSeconds + input.configuration.cooldownSeconds
          : currentState.cooldownUntil,
      };
      const evaluationHash = hashBytes(
        canonical({ positionId: input.positionId, evaluation }),
      );
      this.repository.saveRiskState(stateKey, {
        state,
        configurationHash,
        evaluatedAt: input.nowSeconds,
      });
      for (const observation of input.observations)
        this.repository.saveRiskObservation(observation);
      this.repository.saveRiskEvaluation(
        evaluationHash,
        input.positionId,
        evaluation,
        input.configuration,
        hashBytes(canonical(input.configuration)),
      );
      this.repository.saveRiskAuditEvent({
        id: evaluationHash,
        positionId: input.positionId,
        eventType: "RISK_EVALUATED",
        actor: "watchtower",
        payload: {
          evaluationHash,
          mode: evaluation.mode,
          sourceDigest: evaluation.sourceDigest,
        },
      });
      return { positionId: input.positionId, evaluation };
    });
  }
  saveCertificate(
    raw: unknown,
    registry = this.certificateRegistry,
  ): {
    readonly positionId: string;
    readonly certificateHash: string;
    readonly certificate: Record<string, unknown>;
    readonly state: "SIGNED";
    readonly submissionState: "NOT_SUBMITTED";
  } {
    const input = riskCertificateRequestSchema.parse(raw);
    if (!registry)
      throw new ServiceError(
        "RISK_REGISTRY_UNAVAILABLE",
        "Configure the certificate verifying registry before accepting certificates",
        503,
      );
    const position = this.repository.getPosition(input.positionId);
    if (!position)
      throw new ServiceError(
        "POSITION_NOT_FOUND",
        "Position was not found",
        404,
      );
    if (
      input.certificate.policyId.toLowerCase() !==
        position.policy.id.toLowerCase() ||
      input.certificate.chainId !== position.chainId ||
      input.certificate.verifyingContract.toLowerCase() !==
        registry.toLowerCase() ||
      input.certificate.policyNonce !== position.policy.nonce
    )
      throw new ServiceError(
        "RISK_CERTIFICATE_CONTEXT_MISMATCH",
        "Risk certificate does not match the position policy",
        409,
      );
    const hardMaximum = BigInt(position.policy.maximumTransactionValue);
    const expectedMaximum =
      input.certificate.riskMode === "NORMAL"
        ? hardMaximum
        : input.certificate.riskMode === "CAUTIOUS"
          ? (hardMaximum * 75n) / 100n
          : input.certificate.riskMode === "SHOCK"
            ? (hardMaximum * 40n) / 100n
            : 0n;
    if (BigInt(input.certificate.maximumTradeValue) !== expectedMaximum)
      throw new ServiceError(
        "RISK_CERTIFICATE_WIDENS_POLICY",
        "Risk certificate cap does not match the approved mode ratio",
        400,
      );
    const hardByToken = new Map(
      position.policy.assets.map((asset) => [asset.token.toLowerCase(), asset]),
    );
    for (const bound of input.certificate.activeBounds) {
      const hard = hardByToken.get(bound.token.toLowerCase());
      if (
        !hard ||
        bound.minimumWeightBps < hard.minimumWeightBps ||
        bound.maximumWeightBps > hard.maximumWeightBps
      )
        throw new ServiceError(
          "RISK_CERTIFICATE_WIDENS_POLICY",
          "Risk certificate widens the hard asset policy",
          400,
        );
    }
    if (input.certificate.activeBounds.length !== hardByToken.size)
      throw new ServiceError(
        "RISK_CERTIFICATE_WIDENS_POLICY",
        "Risk certificate does not cover every managed asset",
        400,
      );
    for (const [index, bound] of input.certificate.activeBounds.entries()) {
      if (
        bound.token.toLowerCase() !==
        position.policy.assets[index]!.token.toLowerCase()
      )
        throw new ServiceError(
          "RISK_CERTIFICATE_WIDENS_POLICY",
          "Risk certificate assets are not in governance order",
          400,
        );
    }
    if (input.certificate.issuedAt > this.now())
      throw new ServiceError(
        "RISK_CERTIFICATE_FROM_FUTURE",
        "Certificate issue time is in the future",
        400,
      );
    if (
      input.certificate.riskMode !== "PAUSED" &&
      (input.certificate.activeBounds.reduce(
        (n, b) => n + b.minimumWeightBps,
        0,
      ) > 10000 ||
        input.certificate.activeBounds.reduce(
          (n, b) => n + b.maximumWeightBps,
          0,
        ) < 10000)
    )
      throw new ServiceError(
        "RISK_BOUNDS_INVALID",
        "Certificate bounds cannot hold a portfolio",
        400,
      );
    if (input.certificate.expiresAt <= input.certificate.issuedAt)
      throw new ServiceError(
        "RISK_CERTIFICATE_EXPIRED",
        "Risk certificate validity window is invalid",
        400,
      );
    if (input.certificate.expiresAt <= this.now())
      throw new ServiceError(
        "RISK_CERTIFICATE_EXPIRED",
        "Risk certificate is already expired",
        400,
      );
    if (
      hashActiveBounds(input.certificate.activeBounds) !==
      input.certificate.activeBoundsHash
    )
      throw new ServiceError(
        "RISK_BOUNDS_HASH_MISMATCH",
        "Risk certificate active bounds hash is invalid",
        400,
      );
    const certificate = input.certificate;
    const certificateHash = hashRiskCertificate(input.certificate);
    if (
      !verifySignature(
        input.certificate.watchtower,
        certificateHash,
        input.certificate.signature ?? "",
      )
    )
      throw new ServiceError(
        "RISK_CERTIFICATE_SIGNATURE_INVALID",
        "Risk certificate signature does not recover the watchtower",
        400,
      );
    this.repository.saveRiskCertificate(
      certificateHash,
      { ...certificate, status: "SIGNED" },
      false,
    );
    this.repository.saveRiskAuditEvent({
      id: certificateHash,
      positionId: input.positionId,
      eventType: "RISK_CERTIFICATE_SIGNED",
      actor: input.certificate.watchtower,
      payload: {
        certificateHash,
        nonce: input.certificate.nonce,
        expiresAt: input.certificate.expiresAt,
      },
    });
    this.repository.saveRiskJob({
      id: `renew:${input.positionId}:${input.certificate.nonce}`,
      positionId: input.positionId,
      kind: "CERTIFICATE_RENEWAL",
      status: "QUEUED",
      attempt: 0,
      nextRunAt: Math.max(0, input.certificate.expiresAt - 60),
    });
    return {
      positionId: input.positionId,
      certificateHash,
      certificate,
      state: "SIGNED",
      submissionState: "NOT_SUBMITTED",
    };
  }

  getPosition(positionId: string): z.infer<typeof riskPositionResponseSchema> {
    const position = this.repository.getPosition(positionId);
    if (!position)
      throw new ServiceError(
        "POSITION_NOT_FOUND",
        "Position was not found",
        404,
      );
    const stored = this.repository.getRiskPosition(positionId);
    const rawCertificate = stored.certificate;
    const certificate = rawCertificate
      ? riskCertificateRequestSchema.shape.certificate.parse(
          Object.fromEntries(
            Object.entries(rawCertificate).filter(([key]) => key !== "status"),
          ),
        )
      : null;
    return riskPositionResponseSchema.parse({
      positionId,
      hardPolicy: {
        maximumTransactionValue: position.policy.maximumTransactionValue,
        assets: position.policy.assets,
        nonce: position.policy.nonce,
        paused: position.policy.paused,
      },
      effective: {
        source: "UNAVAILABLE",
        mode: null,
        maximumTradeValue: null,
        activeBounds: [],
        observedAt: null,
      },
      proposed: stored.evaluation ?? null,
      certificate,
      certificateState:
        certificate && certificate.expiresAt <= this.now()
          ? "EXPIRED"
          : (stored.certificateStatus ?? "NONE"),
      signer: null,
    });
  }
}
