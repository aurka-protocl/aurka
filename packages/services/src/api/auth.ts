import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  authChallengeTypedData,
  authVerifyRequestSchema,
  type AuthChallengeResponse,
  type AuthSession,
} from "@aurka/shared";
import { hashTypedData, recoverAddress } from "viem";

import { ServiceError } from "../service.js";
import type {
  AuthChallengeRecord,
  AuthSessionRecord,
  ServiceRepository,
} from "../db/repository.js";

const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;
const COOKIE_NAME = "aurka_session";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cookieToken(request: IncomingMessage): string | undefined {
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .map((part) => part.split("="))
    .find(([name]) => name === COOKIE_NAME)?.[1];
}

function validAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function originForRequest(request: IncomingMessage): string {
  const header = request.headers.origin;
  if (typeof header === "string" && header.trim()) return header.trim();
  const host = request.headers.host?.trim() || "localhost";
  return `http://${host}`;
}

function allowedOrigins(): Set<string> | undefined {
  const raw = process.env.AURKA_ALLOWED_ORIGINS?.trim();
  if (!raw) return undefined;
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function assertOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ServiceError(
      "AUTH_ORIGIN_INVALID",
      "Wallet login origin is invalid",
      400,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ServiceError(
      "AUTH_ORIGIN_INVALID",
      "Wallet login origin is invalid",
      400,
    );
  const configured = allowedOrigins();
  if (configured) {
    if (!configured.has(origin))
      throw new ServiceError(
        "AUTH_ORIGIN_NOT_ALLOWED",
        "Wallet login origin is not allowed",
        403,
      );
    return;
  }
  // Development defaults are deliberately narrow. Production deployments
  // should set AURKA_ALLOWED_ORIGINS to their exact HTTPS origin.
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
    process.env.NODE_ENV === "production"
  )
    throw new ServiceError(
      "AUTH_ORIGIN_NOT_ALLOWED",
      "Set AURKA_ALLOWED_ORIGINS for this hosted origin",
      403,
    );
}

export interface AuthenticatedRequest {
  readonly ownerAddress: string;
  readonly chainId: number;
  readonly expiresAt: number;
}

export class AuthService {
  constructor(
    private readonly repository: ServiceRepository,
    private readonly sessionSeconds = Number(
      process.env.AURKA_SESSION_SECONDS ?? DEFAULT_SESSION_SECONDS,
    ),
    private readonly expectedChainId?: number,
  ) {}

  challenge(input: {
    readonly address: string;
    readonly chainId: number;
    readonly origin: string;
  }): AuthChallengeResponse {
    if (!validAddress(input.address))
      throw new ServiceError(
        "AUTH_ADDRESS_INVALID",
        "Wallet address is invalid",
        400,
      );
    if (
      this.expectedChainId !== undefined &&
      input.chainId !== this.expectedChainId
    )
      throw new ServiceError(
        "CHAIN_MISMATCH",
        "Wallet authentication is only available on the configured Sepolia chain",
        409,
      );
    assertOrigin(input.origin);
    const issuedAt = now();
    const expiresAt = issuedAt + CHALLENGE_SECONDS;
    const record: AuthChallengeRecord = {
      id: randomUUID(),
      address: input.address.toLowerCase(),
      chainId: input.chainId,
      nonce: randomBytes(32).toString("hex"),
      origin: input.origin,
      expiresAt,
      consumedAt: null,
    };
    this.repository.saveAuthChallenge(record);
    return {
      challengeId: record.id,
      address: record.address,
      chainId: record.chainId,
      nonce: record.nonce,
      origin: record.origin,
      expiresAt,
      typedData: authChallengeTypedData(record),
    };
  }

  async verify(
    input: unknown,
    requestOrigin?: string,
  ): Promise<{ readonly session: AuthSession; readonly token: string }> {
    const value = authVerifyRequestSchema.parse(input);
    if (requestOrigin !== undefined) assertOrigin(requestOrigin);
    const challenge = this.repository.consumeAuthChallenge(value.challengeId);
    if (!challenge)
      throw new ServiceError(
        "AUTH_CHALLENGE_INVALID",
        "Login challenge is missing, expired, or already used",
        401,
      );
    if (
      challenge.chainId !== value.chainId ||
      challenge.address.toLowerCase() !== value.address.toLowerCase()
    )
      throw new ServiceError(
        "AUTH_CHALLENGE_MISMATCH",
        "Wallet login does not match the challenge",
        401,
      );
    if (requestOrigin !== undefined && challenge.origin !== requestOrigin)
      throw new ServiceError(
        "AUTH_ORIGIN_MISMATCH",
        "Wallet login must be completed from the same application origin",
        401,
      );
    let signer: string;
    try {
      signer = await recoverAddress({
        hash: hashTypedData(authChallengeTypedData(challenge) as never),
        signature: value.signature as `0x${string}`,
      });
    } catch {
      throw new ServiceError(
        "AUTH_SIGNATURE_INVALID",
        "Wallet login signature is invalid",
        401,
      );
    }
    if (signer.toLowerCase() !== challenge.address.toLowerCase())
      throw new ServiceError(
        "AUTH_SIGNATURE_INVALID",
        "Wallet login signature is not from the requested wallet",
        401,
      );
    const token = randomBytes(32).toString("base64url");
    const session: AuthSessionRecord = {
      tokenHash: digest(token),
      ownerAddress: challenge.address,
      chainId: challenge.chainId,
      expiresAt: now() + Math.max(300, this.sessionSeconds),
    };
    this.repository.saveAuthSession(session);
    return {
      token,
      session: {
        address: session.ownerAddress,
        chainId: session.chainId,
        expiresAt: session.expiresAt,
      },
    };
  }

  authenticate(request: IncomingMessage): AuthenticatedRequest {
    const token = cookieToken(request);
    if (!token)
      throw new ServiceError(
        "AUTH_REQUIRED",
        "Connect and sign in with a wallet before using this feature",
        401,
      );
    const session = this.repository.getAuthSession(digest(token));
    if (!session)
      throw new ServiceError(
        "AUTH_REQUIRED",
        "Wallet session is missing or expired; connect again",
        401,
      );
    return {
      ownerAddress: session.ownerAddress,
      chainId: session.chainId,
      expiresAt: session.expiresAt,
    };
  }

  cookie(token: string): string {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.max(300, this.sessionSeconds)}${secure}`;
  }

  clearCookie(request: IncomingMessage): string {
    const token = cookieToken(request);
    if (token) this.repository.deleteAuthSession(digest(token));
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  }

  static cookieName(): string {
    return COOKIE_NAME;
  }
}

export function requestOrigin(request: IncomingMessage): string {
  return originForRequest(request);
}
