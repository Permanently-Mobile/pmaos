/**
 * Wraith Error Classification
 *
 * Structured error types for scan modules. Every error carries its module origin,
 * classification, retryability, and the original error for debugging.
 *
 * Adapted from Shannon's PentestError pattern -- tuned for Wraith's scan modules
 * instead of Shannon's Temporal workflow retry system.
 */

/**
 * Error type categories for scan module failures.
 * Each type maps to a distinct failure mode with different retry/escalation behavior.
 */
export enum WraithErrorType {
  /** Module exceeded its time budget */
  TIMEOUT = 'TIMEOUT',
  /** Module output could not be parsed into expected format */
  PARSE_FAILURE = 'PARSE_FAILURE',
  /** Network-level failure (DNS, connection refused, unreachable) */
  NETWORK = 'NETWORK',
  /** Insufficient permissions to access target resource */
  PERMISSION = 'PERMISSION',
  /** Module configuration missing or invalid */
  CONFIG = 'CONFIG',
  /** Module runtime failure (crash, assertion, unexpected state) */
  EXECUTION = 'EXECUTION',
  /** Module input or output failed validation checks */
  VALIDATION = 'VALIDATION',
  /** Unclassified error -- escalate for review */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Map of error types to their default retryability.
 * Transient failures (network, timeout) are retryable.
 * Permanent failures (config, permission) are not.
 */
const DEFAULT_RETRYABLE: Record<WraithErrorType, boolean> = {
  [WraithErrorType.TIMEOUT]: true,
  [WraithErrorType.PARSE_FAILURE]: false,
  [WraithErrorType.NETWORK]: true,
  [WraithErrorType.PERMISSION]: false,
  [WraithErrorType.CONFIG]: false,
  [WraithErrorType.EXECUTION]: false,
  [WraithErrorType.VALIDATION]: false,
  [WraithErrorType.UNKNOWN]: false,
};

/**
 * Context bag for WraithScanError. Structured metadata about the failure
 * without leaking implementation details into the error message.
 */
export interface WraithErrorContext {
  /** The specific target that triggered the error (host, path, endpoint) */
  target?: string;
  /** Duration in ms before the error occurred */
  durationMs?: number;
  /** Retry attempt number (0 = first try) */
  attempt?: number;
  /** Additional structured data relevant to debugging */
  [key: string]: unknown;
}

/**
 * Structured error class for Wraith scan modules.
 *
 * Every module failure should be wrapped in a WraithScanError so the orchestrator
 * can make informed decisions about retry, skip, or abort.
 */
export class WraithScanError extends Error {
  override readonly name = 'WraithScanError' as const;

  /** Which module produced this error */
  readonly module: string;

  /** Error classification */
  readonly type: WraithErrorType;

  /** Whether the orchestrator should retry this module */
  readonly retryable: boolean;

  /** The original error that caused this failure, if any */
  readonly originalError: Error | undefined;

  /** Structured context for debugging */
  readonly context: WraithErrorContext;

  /** ISO timestamp of when the error occurred */
  readonly timestamp: string;

  constructor(
    message: string,
    module: string,
    type: WraithErrorType,
    options: {
      retryable?: boolean;
      originalError?: Error;
      context?: WraithErrorContext;
    } = {},
  ) {
    super(message);
    this.module = module;
    this.type = type;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[type];
    this.originalError = options.originalError;
    this.context = options.context ?? {};
    this.timestamp = new Date().toISOString();

    // Preserve original stack trace when wrapping
    if (options.originalError?.stack) {
      this.stack = `${this.stack}\n--- caused by ---\n${options.originalError.stack}`;
    }
  }

  /** Serialize to a plain object for logging/reporting */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      module: this.module,
      type: this.type,
      retryable: this.retryable,
      timestamp: this.timestamp,
      context: this.context,
      originalError: this.originalError
        ? { name: this.originalError.name, message: this.originalError.message }
        : undefined,
    };
  }
}

/**
 * Classify an unknown thrown value into a WraithScanError.
 * Use this at module boundaries to normalize errors from external tools (nmap, nuclei, etc).
 */
export function classifyError(
  thrown: unknown,
  module: string,
): WraithScanError {
  if (thrown instanceof WraithScanError) {
    return thrown;
  }

  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  const message = error.message.toLowerCase();

  // Timeout patterns
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('etimedout') ||
    message.includes('deadline exceeded')
  ) {
    return new WraithScanError(
      error.message,
      module,
      WraithErrorType.TIMEOUT,
      { originalError: error },
    );
  }

  // Network patterns
  if (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('network') ||
    message.includes('dns') ||
    message.includes('socket hang up')
  ) {
    return new WraithScanError(
      error.message,
      module,
      WraithErrorType.NETWORK,
      { originalError: error },
    );
  }

  // Permission patterns
  if (
    message.includes('eacces') ||
    message.includes('permission denied') ||
    message.includes('forbidden') ||
    message.includes('403')
  ) {
    return new WraithScanError(
      error.message,
      module,
      WraithErrorType.PERMISSION,
      { originalError: error },
    );
  }

  // Config patterns
  if (
    message.includes('enoent') ||
    message.includes('no such file') ||
    message.includes('not found') ||
    message.includes('missing config') ||
    message.includes('not installed')
  ) {
    return new WraithScanError(
      error.message,
      module,
      WraithErrorType.CONFIG,
      { originalError: error },
    );
  }

  // Parse patterns
  if (
    message.includes('unexpected token') ||
    message.includes('json') ||
    message.includes('parse error') ||
    message.includes('syntax error')
  ) {
    return new WraithScanError(
      error.message,
      module,
      WraithErrorType.PARSE_FAILURE,
      { originalError: error },
    );
  }

  // Validation patterns
  if (
    message.includes('validation') ||
    message.includes('invalid') ||
    message.includes('schema')
  ) {
    return new WraithScanError(
      error.message,
      module,
      WraithErrorType.VALIDATION,
      { originalError: error },
    );
  }

  // Default: unknown, not retryable
  return new WraithScanError(
    error.message,
    module,
    WraithErrorType.UNKNOWN,
    { originalError: error },
  );
}

/**
 * Check if a WraithScanError (or any error) is retryable.
 * Convenience function for orchestrator retry logic.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof WraithScanError) {
    return error.retryable;
  }
  // For non-WraithScanError, classify conservatively
  return false;
}
