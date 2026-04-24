/**
 * Wraith Result Type -- Explicit error handling via discriminated union.
 *
 * Adapted from Shannon's Result pattern. Forces callers to handle both
 * success and failure paths at every module boundary -- no silent swallowing
 * of errors, no unchecked exceptions leaking through scan pipelines.
 *
 * Usage:
 *   const result = await runModule(scope, config);
 *   if (result.ok) {
 *     // result.value is typed as T
 *   } else {
 *     // result.error is typed as E
 *   }
 */

/** Success variant */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure variant */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Discriminated union: either Ok<T> or Err<E> */
export type Result<T, E> = Ok<T> | Err<E>;

/** Create a success Result */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Create a failure Result */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard for Ok variant */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/** Type guard for Err variant */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

/**
 * Unwrap a Result, throwing the error if it's an Err.
 * Use sparingly -- prefer pattern matching via ok/err checks.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof Error) {
    throw result.error;
  }
  throw new Error(String(result.error));
}

/**
 * Unwrap a Result with a fallback value for the Err case.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Map the success value of a Result, leaving errors untouched.
 */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Wrap an async operation in a Result, catching thrown errors.
 * Returns Ok<T> on success, Err<Error> on throw.
 */
export async function tryCatch<T>(
  fn: () => Promise<T>,
): Promise<Result<T, Error>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (thrown: unknown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    return err(error);
  }
}
