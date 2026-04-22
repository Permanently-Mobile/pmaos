/**
 * AI Defense Scan -- barrel export for basic tier modules.
 */

// Types
export type {
  Severity,
  Finding,
  ModuleResult,
  ScanConfig,
  TargetScope,
  AttackModule,
  NotifyMode,
} from './types.js';

// Scope
export {
  loadScope,
  getDefaultScope,
  validateTarget,
  validatePath,
  isInScope,
} from './scope.js';

// Report
export {
  generateReport,
  writeReportToVault,
  notifyPrimaryAgent,
  notifyTelegram,
} from './report.js';

// Guardrails (self-defense)
export { scanContent, wrapExternalContent, validateOutput, isContainerized } from './guardrails.js';

// Basic Tier Attack Modules
export { promptInjectionModule } from './prompt-injection.js';
export { secretExposureModule } from './secret-exposure.js';
export { bridgeExploitModule } from './bridge-exploit.js';
export { guardrailsModule } from './guardrails.js';
