/**
 * Wraith Types -- Barrel Export
 *
 * Single import point for all Wraith foundational types:
 *   import { ok, err, Result, WraithScanError, ValidatedFinding } from './types/index.js';
 */

// Result type (discriminated union for explicit error handling)
export {
  type Ok,
  type Err,
  type Result,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  mapResult,
  tryCatch,
} from './result.js';

// Error classification
export {
  WraithErrorType,
  WraithScanError,
  classifyError,
  isRetryable,
  type WraithErrorContext,
} from './errors.js';

// Finding schemas and validation
export {
  SeveritySchema,
  BaseFindingSchema,
  ValidatedFindingSchema,
  ModuleFindingsSchema,
  type SeverityLevel,
  type BaseFinding,
  type ValidatedFinding,
  type ModuleFindings,
  validateFinding,
  safeParseFinding,
  validateAndExtend,
  validateFindings,
  toJSONSchema,
  toBaseJSONSchema,
} from './findings.js';
