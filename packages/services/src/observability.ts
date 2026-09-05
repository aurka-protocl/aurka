export interface LogContext {
  readonly requestId?: string;
  readonly intentHash?: string;
  readonly proposalHash?: string;
  readonly executionHash?: string;
  readonly chainId?: number;
  readonly blockNumber?: string;
  readonly [key: string]: unknown;
}

function safeContext(context: LogContext): LogContext {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (/private|secret|password|signature|payload/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

/** JSON-lines logger; secrets and full signed payloads are deliberately omitted. */
export class StructuredLogger {
  constructor(private readonly sink: (line: string) => void = console.log) {}

  info(message: string, context: LogContext = {}): void {
    this.sink(
      JSON.stringify({ level: "info", message, ...safeContext(context) }),
    );
  }

  warn(message: string, context: LogContext = {}): void {
    this.sink(
      JSON.stringify({ level: "warn", message, ...safeContext(context) }),
    );
  }

  error(message: string, context: LogContext = {}): void {
    this.sink(
      JSON.stringify({ level: "error", message, ...safeContext(context) }),
    );
  }
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function retryBounded<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const initialDelay = options.delayMs ?? 50;
  const maxDelay = options.maxDelayMs ?? 1_000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
    throw new RangeError("Retry attempts must be between 1 and 10");
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 === attempts) break;
      const delay = Math.min(maxDelay, initialDelay * 2 ** attempt);
      await (
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)))
      )(delay);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Bounded retry failed");
}
