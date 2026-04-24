/**
 * Wraith Finding Schemas -- Zod-validated finding types.
 *
 * Runtime validation for scan module output. Every finding gets validated
 * before it enters the report pipeline, catching malformed output from
 * modules or external tools before it corrupts downstream data.
 *
 * Backward compatible with the existing Finding interface in ../types.ts.
 * New fields (validated, validation_evidence, confidence) extend the base
 * without breaking existing module output.
 */

import { z } from 'zod';

/**
 * Severity levels for scan findings.
 * Matches the existing Severity type in ../types.ts.
 */
export const SeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

export type SeverityLevel = z.infer<typeof SeveritySchema>;

/**
 * Base Finding schema -- matches the existing Finding interface exactly.
 * Modules that produce this shape will pass validation without changes.
 */
export const BaseFindingSchema = z.object({
  /** Unique finding ID (module-NNN format) */
  id: z.string().min(1),
  /** Severity level of the finding */
  severity: SeveritySchema,
  /** Clear one-line description */
  title: z.string().min(1),
  /** Which attack module produced this finding */
  module: z.string().min(1),
  /** What was tested (file path, endpoint, agent name, etc.) */
  target: z.string(),
  /** What was attempted (payload, method, technique) */
  attack: z.string(),
  /** What happened (success, failure, partial) */
  result: z.string(),
  /** Logs, payloads, output proving the finding */
  evidence: z.string(),
  /** How to fix (specific, actionable) */
  remediation: z.string(),
  /** Command or steps to verify fix works */
  retest: z.string(),
  /** When the finding was recorded (epoch ms) */
  timestamp: z.number(),
});

/**
 * Extended Finding schema -- adds validation metadata.
 * These fields are populated during the validation pass, not by modules directly.
 */
export const ValidatedFindingSchema = BaseFindingSchema.extend({
  /** Whether this finding has been through validation */
  validated: z.boolean().default(false),
  /** Evidence supporting the validation result (hash, proof, reproduction output) */
  validation_evidence: z.string().default(''),
  /** Confidence score from 0 (uncertain) to 1 (confirmed exploitable) */
  confidence: z.number().min(0).max(1).default(0.5),
});

/**
 * Schema for a collection of findings from a single module run.
 */
export const ModuleFindingsSchema = z.object({
  /** Module that produced these findings */
  module: z.string().min(1),
  /** Array of validated findings */
  findings: z.array(ValidatedFindingSchema),
  /** Execution duration in milliseconds */
  duration: z.number().nonnegative(),
  /** Error message if the module crashed */
  error: z.string().optional(),
});

/**
 * Inferred types from Zod schemas.
 * These are the runtime-validated versions of the types.
 */
export type BaseFinding = z.infer<typeof BaseFindingSchema>;
export type ValidatedFinding = z.infer<typeof ValidatedFindingSchema>;
export type ModuleFindings = z.infer<typeof ModuleFindingsSchema>;

/**
 * Validate a raw finding object against the base schema.
 * Returns the parsed finding if valid, throws ZodError if not.
 *
 * Use this for module output that matches the legacy Finding interface.
 */
export function validateFinding(raw: unknown): BaseFinding {
  return BaseFindingSchema.parse(raw);
}

/**
 * Safe validation -- returns a discriminated result instead of throwing.
 * Returns { success: true, data: BaseFinding } or { success: false, error: ZodError }.
 */
export function safeParseFinding(raw: unknown): z.ZodSafeParseResult<BaseFinding> {
  return BaseFindingSchema.safeParse(raw);
}

/**
 * Validate and upgrade a raw finding to the extended validated format.
 * Missing extended fields get defaults (validated=false, confidence=0.5).
 */
export function validateAndExtend(raw: unknown): ValidatedFinding {
  return ValidatedFindingSchema.parse(raw);
}

/**
 * Batch validate an array of raw findings.
 * Returns { valid, invalid } split so the caller can handle failures.
 */
export function validateFindings(rawFindings: unknown[]): {
  valid: ValidatedFinding[];
  invalid: Array<{ index: number; input: unknown; errors: z.ZodError }>;
} {
  const valid: ValidatedFinding[] = [];
  const invalid: Array<{ index: number; input: unknown; errors: z.ZodError }> = [];

  for (let i = 0; i < rawFindings.length; i++) {
    const result = ValidatedFindingSchema.safeParse(rawFindings[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      invalid.push({ index: i, input: rawFindings[i], errors: result.error });
    }
  }

  return { valid, invalid };
}

/**
 * Generate a JSON Schema from the ValidatedFinding schema.
 * Useful for cross-system compatibility (e.g., sharing schema with
 * external validators, bridge message validation, or API contracts).
 *
 * Returns draft-07 format for broad compatibility.
 */
export function toJSONSchema(): Record<string, unknown> {
  return z.toJSONSchema(ValidatedFindingSchema, {
    target: 'draft-07',
  }) as Record<string, unknown>;
}

/**
 * Generate JSON Schema for the base finding (legacy compatible).
 */
export function toBaseJSONSchema(): Record<string, unknown> {
  return z.toJSONSchema(BaseFindingSchema, {
    target: 'draft-07',
  }) as Record<string, unknown>;
}
