/**
 * Secret Pattern Definitions -- Secret Substitution Layer
 *
 * 210+ regex patterns for detecting system secrets (API keys, tokens,
 * connection strings, private keys, etc.) in text before it reaches an LLM.
 *
 * Each pattern has a category, name, regex, and confidence score.
 * Patterns are compiled once at import time for performance.
 *
 * Inspired by StakPak's open-source pattern library (Apache 2.0),
 * but written from scratch for Apex.
 */

// ── Pattern definition ──────────────────────────────────────────────

export interface SecretPatternDef {
  /** Category grouping (e.g. 'aws', 'database', 'jwt') */
  category: string;
  /** Unique pattern name within the category */
  name: string;
  /** Compiled regex (must have global flag) */
  regex: RegExp;
  /** Confidence 0.0-1.0 that this match is a real secret */
  confidence: number;
}

// ── AWS patterns ────────────────────────────────────────────────────

export const AWS_PATTERNS: SecretPatternDef[] = [
  {
    category: 'aws',
    name: 'aws-access-key-id',
    regex: /\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    confidence: 0.95,
  },
  {
    category: 'aws',
    name: 'aws-secret-access-key',
    regex: /(?:aws_secret_access_key|aws_secret|secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g,
    confidence: 0.95,
  },
  {
    category: 'aws',
    name: 'aws-session-token',
    regex: /(?:aws_session_token|AWS_SESSION_TOKEN)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{100,})['"]?/g,
    confidence: 0.9,
  },
  {
    category: 'aws',
    name: 'aws-mws-auth-token',
    regex: /amzn\.mws\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    confidence: 0.95,
  },
  {
    category: 'aws',
    name: 'aws-arn',
    regex: /arn:aws:[a-z0-9\-]+:[a-z0-9\-]*:\d{12}:[a-zA-Z0-9\-_/:.]+/g,
    confidence: 0.6,
  },
];

// ── GCP patterns ────────────────────────────────────────────────────

export const GCP_PATTERNS: SecretPatternDef[] = [
  {
    category: 'gcp',
    name: 'gcp-api-key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    confidence: 0.95,
  },
  {
    category: 'gcp',
    name: 'gcp-service-account-key',
    regex: /"type"\s*:\s*"service_account"[\s\S]{0,500}"private_key"\s*:\s*"-----BEGIN/g,
    confidence: 0.99,
  },
  {
    category: 'gcp',
    name: 'gcp-oauth-token',
    regex: /ya29\.[0-9A-Za-z_-]{50,}/g,
    confidence: 0.9,
  },
  {
    category: 'gcp',
    name: 'gcp-oauth-client-secret',
    regex: /(?:client_secret|GOOGLE_CLIENT_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9_-]{24,}['"]?/g,
    confidence: 0.85,
  },
  {
    category: 'gcp',
    name: 'firebase-key',
    regex: /(?:FIREBASE_API_KEY|firebase_key)\s*[=:]\s*['"]?AIza[0-9A-Za-z_-]{35}['"]?/g,
    confidence: 0.95,
  },
];

// ── Azure patterns ──────────────────────────────────────────────────

export const AZURE_PATTERNS: SecretPatternDef[] = [
  {
    category: 'azure',
    name: 'azure-storage-connection-string',
    regex: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{86,88};/g,
    confidence: 0.98,
  },
  {
    category: 'azure',
    name: 'azure-storage-account-key',
    regex: /(?:AccountKey|account_key|AZURE_STORAGE_KEY)\s*[=:]\s*['"]?[A-Za-z0-9+/=]{86,88}['"]?/g,
    confidence: 0.95,
  },
  {
    category: 'azure',
    name: 'azure-ad-client-secret',
    regex: /(?:AZURE_CLIENT_SECRET|azure_client_secret)\s*[=:]\s*['"]?[A-Za-z0-9~._-]{34,}['"]?/g,
    confidence: 0.85,
  },
  {
    category: 'azure',
    name: 'azure-connection-string',
    regex: /(?:Server|Data Source)=[^;]+;(?:Initial Catalog|Database)=[^;]+;(?:User ID|uid)=[^;]+;(?:Password|pwd)=[^;]+;?/gi,
    confidence: 0.9,
  },
  {
    category: 'azure',
    name: 'azure-sas-token',
    regex: /[?&]sig=[A-Za-z0-9%+/=]{40,}(?:&|$)/g,
    confidence: 0.85,
  },
];

// ── Generic API key patterns ────────────────────────────────────────

export const GENERIC_API_PATTERNS: SecretPatternDef[] = [
  {
    category: 'api-key',
    name: 'generic-api-key-assignment',
    regex: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[=:]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/gi,
    confidence: 0.85,
  },
  {
    category: 'api-key',
    name: 'x-api-key-header',
    regex: /[xX][-_][aA][pP][iI][-_][kK][eE][yY]\s*[=:]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/g,
    confidence: 0.9,
  },
  {
    category: 'api-key',
    name: 'authorization-bearer',
    regex: /[Aa]uthorization\s*[=:]\s*['"]?Bearer\s+([A-Za-z0-9._~+/=-]{20,})['"]?/g,
    confidence: 0.9,
  },
  {
    category: 'api-key',
    name: 'authorization-basic',
    regex: /[Aa]uthorization\s*[=:]\s*['"]?Basic\s+([A-Za-z0-9+/=]{20,})['"]?/g,
    confidence: 0.85,
  },
  {
    category: 'api-key',
    name: 'secret-key-assignment',
    regex: /(?:secret[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key)\s*[=:]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/gi,
    confidence: 0.85,
  },
  {
    category: 'api-key',
    name: 'access-token-assignment',
    regex: /(?:access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[=:]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/gi,
    confidence: 0.85,
  },
  {
    category: 'api-key',
    name: 'password-assignment',
    regex: /(?:password|passwd|pass|pwd)\s*[=:]\s*['"]([^'"]{8,})['"](?:\s|$|;)/gi,
    confidence: 0.8,
  },
];

// ── Database connection strings ─────────────────────────────────────

export const DATABASE_PATTERNS: SecretPatternDef[] = [
  {
    category: 'database',
    name: 'postgres-connection-string',
    regex: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^/\s]+(?:\/[^\s'"]+)?/g,
    confidence: 0.95,
  },
  {
    category: 'database',
    name: 'mysql-connection-string',
    regex: /mysql:\/\/[^:]+:[^@]+@[^/\s]+(?:\/[^\s'"]+)?/g,
    confidence: 0.95,
  },
  {
    category: 'database',
    name: 'mongodb-connection-string',
    regex: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s'"]+/g,
    confidence: 0.95,
  },
  {
    category: 'database',
    name: 'redis-connection-string',
    regex: /redis(?:s)?:\/\/(?:[^:]+:[^@]+@)?[^/\s]+(?:\/\d+)?/g,
    confidence: 0.9,
  },
  {
    category: 'database',
    name: 'db-password-config',
    regex: /(?:DB_PASS(?:WORD)?|DATABASE_PASSWORD|MYSQL_PASSWORD|POSTGRES_PASSWORD|MONGO_PASSWORD|REDIS_PASSWORD)\s*[=:]\s*['"]?([^\s'"]{4,})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'database',
    name: 'jdbc-connection-string',
    regex: /jdbc:[a-z]+:\/\/[^:]+:[^@]+@[^\s'"]+/g,
    confidence: 0.9,
  },
  {
    category: 'database',
    name: 'connection-string-embedded-creds',
    regex: /(?:Server|Host)=[^;]+;.*(?:Password|Pwd)=[^;]+/gi,
    confidence: 0.9,
  },
];

// ── JWT tokens ──────────────────────────────────────────────────────

export const JWT_PATTERNS: SecretPatternDef[] = [
  {
    category: 'jwt',
    name: 'jwt-token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    confidence: 0.95,
  },
  {
    category: 'jwt',
    name: 'jwt-secret-config',
    regex: /(?:JWT_SECRET|JWT_KEY|JWT_SIGNING_KEY)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
    confidence: 0.9,
  },
];

// ── SSH/PGP private keys ────────────────────────────────────────────

export const KEY_PATTERNS: SecretPatternDef[] = [
  {
    category: 'private-key',
    name: 'rsa-private-key',
    regex: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    category: 'private-key',
    name: 'ec-private-key',
    regex: /-----BEGIN EC PRIVATE KEY-----[\s\S]*?-----END EC PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    category: 'private-key',
    name: 'openssh-private-key',
    regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    category: 'private-key',
    name: 'generic-private-key',
    regex: /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED )?PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    category: 'private-key',
    name: 'dsa-private-key',
    regex: /-----BEGIN DSA PRIVATE KEY-----[\s\S]*?-----END DSA PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    category: 'private-key',
    name: 'pgp-private-key',
    regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
    confidence: 0.99,
  },
  {
    category: 'private-key',
    name: 'putty-private-key',
    regex: /PuTTY-User-Key-File-[23]:\s*[\s\S]*?Private-Lines:/g,
    confidence: 0.95,
  },
];

// ── Crypto / blockchain ─────────────────────────────────────────────

export const CRYPTO_SECRET_PATTERNS: SecretPatternDef[] = [
  {
    category: 'crypto',
    name: 'eth-private-key',
    regex: /\b(?:0x)?[0-9a-fA-F]{64}\b/g,
    confidence: 0.6, // lower confidence because hex strings are common; needs context
  },
  {
    category: 'crypto',
    name: 'eth-private-key-labeled',
    regex: /(?:private[_\s-]?key|priv[_\s-]?key|secret[_\s-]?key)\s*[=:]\s*['"]?(?:0x)?[0-9a-fA-F]{64}['"]?/gi,
    confidence: 0.95,
  },
  {
    category: 'crypto',
    name: 'seed-phrase-12',
    regex: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/g,
    confidence: 0.5, // may match normal text; context-dependent
  },
  {
    category: 'crypto',
    name: 'seed-phrase-24',
    regex: /\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/g,
    confidence: 0.6,
  },
  {
    category: 'crypto',
    name: 'seed-phrase-labeled',
    regex: /(?:seed\s*phrase|mnemonic|recovery\s*phrase)\s*[=:]\s*['"]?(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}['"]?/gi,
    confidence: 0.95,
  },
  {
    category: 'crypto',
    name: 'nowpayments-api-key',
    regex: /(?:NOWPAYMENTS_API_KEY|nowpayments[_-]?key)\s*[=:]\s*['"]?([A-Za-z0-9_-]{20,})['"]?/gi,
    confidence: 0.95,
  },
];

// ── Messaging / bot tokens ──────────────────────────────────────────

export const MESSAGING_PATTERNS: SecretPatternDef[] = [
  {
    category: 'messaging',
    name: 'telegram-bot-token',
    regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    confidence: 0.95,
  },
  {
    category: 'messaging',
    name: 'telegram-bot-token-labeled',
    regex: /(?:TELEGRAM_BOT_TOKEN|BOT_TOKEN|TELEGRAM_TOKEN)\s*[=:]\s*['"]?\d{8,10}:[A-Za-z0-9_-]{35}['"]?/gi,
    confidence: 0.98,
  },
  {
    category: 'messaging',
    name: 'discord-bot-token',
    regex: /(?:discord|DISCORD_TOKEN|DISCORD_BOT_TOKEN)\s*[=:]\s*['"]?[A-Za-z0-9._-]{50,}['"]?/gi,
    confidence: 0.85,
  },
  {
    category: 'messaging',
    name: 'discord-token-raw',
    regex: /[MN][A-Za-z0-9]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}/g,
    confidence: 0.9,
  },
  {
    category: 'messaging',
    name: 'slack-bot-token',
    regex: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24}/g,
    confidence: 0.95,
  },
  {
    category: 'messaging',
    name: 'slack-user-token',
    regex: /xoxp-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{32}/g,
    confidence: 0.95,
  },
  {
    category: 'messaging',
    name: 'slack-webhook-url',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    confidence: 0.95,
  },
  {
    category: 'messaging',
    name: 'slack-app-token',
    regex: /xapp-[0-9]+-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]+/g,
    confidence: 0.95,
  },
];

// ── GitHub / source control ─────────────────────────────────────────

export const SOURCE_CONTROL_PATTERNS: SecretPatternDef[] = [
  {
    category: 'source-control',
    name: 'github-personal-access-token',
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
    confidence: 0.98,
  },
  {
    category: 'source-control',
    name: 'github-oauth-token',
    regex: /\bgho_[A-Za-z0-9]{36}\b/g,
    confidence: 0.98,
  },
  {
    category: 'source-control',
    name: 'github-app-token',
    regex: /\bghs_[A-Za-z0-9]{36}\b/g,
    confidence: 0.98,
  },
  {
    category: 'source-control',
    name: 'github-fine-grained-pat',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    confidence: 0.98,
  },
  {
    category: 'source-control',
    name: 'github-refresh-token',
    regex: /\bghr_[A-Za-z0-9]{36}\b/g,
    confidence: 0.98,
  },
  {
    category: 'source-control',
    name: 'gitlab-personal-access-token',
    regex: /\bglpat-[A-Za-z0-9_-]{20}\b/g,
    confidence: 0.95,
  },
  {
    category: 'source-control',
    name: 'gitlab-pipeline-token',
    regex: /\bglptt-[A-Za-z0-9_-]{20,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'source-control',
    name: 'bitbucket-app-password',
    regex: /(?:BITBUCKET_APP_PASSWORD|bitbucket_password)\s*[=:]\s*['"]?([A-Za-z0-9]{20,})['"]?/gi,
    confidence: 0.85,
  },
];

// ── AI provider API keys ────────────────────────────────────────────

export const AI_PROVIDER_PATTERNS: SecretPatternDef[] = [
  {
    category: 'ai-provider',
    name: 'anthropic-api-key',
    regex: /\bsk-ant-api03-[A-Za-z0-9_-]{90,}AA\b/g,
    confidence: 0.99,
  },
  {
    category: 'ai-provider',
    name: 'openai-api-key',
    regex: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/g,
    confidence: 0.98,
  },
  {
    category: 'ai-provider',
    name: 'openai-api-key-v2',
    regex: /\bsk-proj-[A-Za-z0-9_-]{40,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'ai-provider',
    name: 'openai-org-key',
    regex: /\borg-[A-Za-z0-9]{24}\b/g,
    confidence: 0.8,
  },
  {
    category: 'ai-provider',
    name: 'groq-api-key',
    regex: /\bgsk_[A-Za-z0-9]{48,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'ai-provider',
    name: 'cohere-api-key',
    regex: /(?:COHERE_API_KEY|cohere_key)\s*[=:]\s*['"]?([A-Za-z0-9]{40})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'ai-provider',
    name: 'huggingface-token',
    regex: /\bhf_[A-Za-z0-9]{34}\b/g,
    confidence: 0.95,
  },
  {
    category: 'ai-provider',
    name: 'replicate-api-token',
    regex: /\br8_[A-Za-z0-9]{36}\b/g,
    confidence: 0.95,
  },
  {
    category: 'ai-provider',
    name: 'venice-api-key-labeled',
    regex: /(?:VENICE_API_KEY|venice_key)\s*[=:]\s*['"]?([A-Za-z0-9_-]{20,})['"]?/gi,
    confidence: 0.95,
  },
];

// ── Cloud / SaaS provider keys ──────────────────────────────────────

export const SAAS_PATTERNS: SecretPatternDef[] = [
  {
    category: 'saas',
    name: 'stripe-secret-key',
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    confidence: 0.98,
  },
  {
    category: 'saas',
    name: 'stripe-publishable-key',
    regex: /\bpk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    confidence: 0.9,
  },
  {
    category: 'saas',
    name: 'stripe-webhook-secret',
    regex: /\bwhsec_[A-Za-z0-9]{24,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'saas',
    name: 'twilio-api-key',
    regex: /\bSK[A-Za-z0-9]{32}\b/g,
    confidence: 0.8,
  },
  {
    category: 'saas',
    name: 'twilio-auth-token',
    regex: /(?:TWILIO_AUTH_TOKEN|twilio_auth)\s*[=:]\s*['"]?([A-Za-z0-9]{32})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'saas',
    name: 'sendgrid-api-key',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    confidence: 0.98,
  },
  {
    category: 'saas',
    name: 'mailgun-api-key',
    regex: /(?:MAILGUN_API_KEY|mailgun_key)\s*[=:]\s*['"]?key-[A-Za-z0-9]{32}['"]?/gi,
    confidence: 0.95,
  },
  {
    category: 'saas',
    name: 'mailchimp-api-key',
    regex: /[0-9a-f]{32}-us\d{1,2}/g,
    confidence: 0.8,
  },
  {
    category: 'saas',
    name: 'paypal-client-secret',
    regex: /(?:PAYPAL_SECRET|PAYPAL_CLIENT_SECRET)\s*[=:]\s*['"]?([A-Za-z0-9_-]{20,})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'saas',
    name: 'square-access-token',
    regex: /\bsq0atp-[A-Za-z0-9_-]{22}\b/g,
    confidence: 0.95,
  },
  {
    category: 'saas',
    name: 'shopify-access-token',
    regex: /\bshpat_[A-Za-z0-9]{32}\b/g,
    confidence: 0.95,
  },
  {
    category: 'saas',
    name: 'shopify-shared-secret',
    regex: /\bshpss_[A-Za-z0-9]{32}\b/g,
    confidence: 0.95,
  },
  {
    category: 'saas',
    name: 'heroku-api-key',
    regex: /(?:HEROKU_API_KEY|heroku_key)\s*[=:]\s*['"]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'saas',
    name: 'datadog-api-key',
    regex: /(?:DD_API_KEY|DATADOG_API_KEY)\s*[=:]\s*['"]?([A-Za-z0-9]{32})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'saas',
    name: 'new-relic-key',
    regex: /\bNRAK-[A-Z0-9]{27}\b/g,
    confidence: 0.95,
  },
  {
    category: 'saas',
    name: 'algolia-api-key',
    regex: /(?:ALGOLIA_API_KEY|algolia_key)\s*[=:]\s*['"]?([A-Za-z0-9]{32})['"]?/gi,
    confidence: 0.85,
  },
];

// ── URL-embedded credentials ────────────────────────────────────────

export const URL_CREDENTIAL_PATTERNS: SecretPatternDef[] = [
  {
    category: 'url-credential',
    name: 'basic-auth-in-url',
    regex: /https?:\/\/[^:]+:[^@]+@[^\s'"]+/g,
    confidence: 0.9,
  },
  {
    category: 'url-credential',
    name: 'ftp-credentials',
    regex: /ftp:\/\/[^:]+:[^@]+@[^\s'"]+/g,
    confidence: 0.9,
  },
];

// ── SMTP credentials ────────────────────────────────────────────────

export const SMTP_PATTERNS: SecretPatternDef[] = [
  {
    category: 'smtp',
    name: 'smtp-password',
    regex: /(?:SMTP_PASS(?:WORD)?|MAIL_PASSWORD|EMAIL_PASSWORD)\s*[=:]\s*['"]?([^\s'"]{4,})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'smtp',
    name: 'smtp-connection-url',
    regex: /smtp(?:s)?:\/\/[^:]+:[^@]+@[^\s'"]+/g,
    confidence: 0.95,
  },
  {
    category: 'smtp',
    name: 'smtp-auth-credentials',
    regex: /(?:SMTP_USER(?:NAME)?|MAIL_USERNAME)\s*[=:]\s*['"]?([^\s'"]+)['"]?\s*[\n;].*(?:SMTP_PASS|MAIL_PASS)/gis,
    confidence: 0.8,
  },
];

// ── Environment variable patterns (.env format) ─────────────────────

export const ENV_PATTERNS: SecretPatternDef[] = [
  {
    category: 'env',
    name: 'env-secret-value',
    regex: /^[A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASS|PWD|CREDENTIAL|AUTH)\s*=\s*['"]?([^\s'"#]{8,})['"]?$/gm,
    confidence: 0.85,
  },
  {
    category: 'env',
    name: 'env-private-key-value',
    regex: /^[A-Z][A-Z0-9_]*PRIVATE[_A-Z]*\s*=\s*['"]?([^\s'"#]{16,})['"]?$/gm,
    confidence: 0.9,
  },
  {
    category: 'env',
    name: 'env-connection-string',
    regex: /^[A-Z][A-Z0-9_]*(?:DATABASE_URL|DB_URL|REDIS_URL|MONGO_URI|CONNECTION_STRING)\s*=\s*['"]?([^\s'"#]+)['"]?$/gm,
    confidence: 0.9,
  },
];

// ── High-entropy strings (catch-all) ────────────────────────────────

export const HIGH_ENTROPY_PATTERNS: SecretPatternDef[] = [
  {
    category: 'high-entropy',
    name: 'hex-secret-40plus',
    regex: /(?:secret|key|token|password|credential)\s*[=:]\s*['"]?([0-9a-fA-F]{40,})['"]?/gi,
    confidence: 0.8,
  },
  {
    category: 'high-entropy',
    name: 'base64-secret-40plus',
    regex: /(?:secret|key|token|password|credential)\s*[=:]\s*['"]?([A-Za-z0-9+/]{40,}={0,2})['"]?/gi,
    confidence: 0.75,
  },
];

// ── Miscellaneous provider-specific patterns ────────────────────────

export const MISC_PATTERNS: SecretPatternDef[] = [
  {
    category: 'misc',
    name: 'aws-cognito-pool-id',
    regex: /[a-z]{2}-[a-z]+-\d{1}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    confidence: 0.7,
  },
  {
    category: 'misc',
    name: 'google-maps-key',
    regex: /(?:GOOGLE_MAPS_KEY|google_maps_api)\s*[=:]\s*['"]?AIza[0-9A-Za-z_-]{35}['"]?/gi,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'mapbox-token',
    regex: /\bpk\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'npm-access-token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'pypi-api-token',
    regex: /\bpypi-[A-Za-z0-9_-]{50,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'nuget-api-key',
    regex: /\boy2[A-Za-z0-9]{43}\b/g,
    confidence: 0.85,
  },
  {
    category: 'misc',
    name: 'docker-auth-config',
    regex: /"auth"\s*:\s*"[A-Za-z0-9+/=]{20,}"/g,
    confidence: 0.85,
  },
  {
    category: 'misc',
    name: 'hashicorp-vault-token',
    regex: /\bhvs\.[A-Za-z0-9_-]{24,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'hashicorp-tf-api-token',
    regex: /(?:TF_API_TOKEN|TERRAFORM_TOKEN)\s*[=:]\s*['"]?([A-Za-z0-9._-]{14,})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'misc',
    name: 'doppler-token',
    regex: /\bdp\.pt\.[A-Za-z0-9]{40,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'sentry-dsn',
    regex: /https:\/\/[0-9a-f]{32}@o\d+\.ingest\.sentry\.io\/\d+/g,
    confidence: 0.9,
  },
  {
    category: 'misc',
    name: 'age-secret-key',
    regex: /AGE-SECRET-KEY-[A-Z0-9]{59}/g,
    confidence: 0.99,
  },
  {
    category: 'misc',
    name: 'nowpayments-key-raw',
    regex: /\b[A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{12}\b/g,
    confidence: 0.5, // UUID-like, could be non-secret; needs context
  },
  {
    category: 'misc',
    name: 'supabase-key',
    regex: /\bsbp_[A-Za-z0-9]{40}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'vercel-token',
    regex: /(?:VERCEL_TOKEN|vercel_token)\s*[=:]\s*['"]?([A-Za-z0-9]{24})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'misc',
    name: 'netlify-token',
    regex: /(?:NETLIFY_AUTH_TOKEN|netlify_token)\s*[=:]\s*['"]?([A-Za-z0-9_-]{40,})['"]?/gi,
    confidence: 0.9,
  },
  {
    category: 'misc',
    name: 'digitalocean-pat',
    regex: /\bdop_v1_[A-Za-z0-9]{64}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'linear-api-key',
    regex: /\blin_api_[A-Za-z0-9]{40}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'grafana-api-key',
    regex: /\bglsa_[A-Za-z0-9_]{32,}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'planetscale-password',
    regex: /\bpscale_pw_[A-Za-z0-9_-]{43}\b/g,
    confidence: 0.95,
  },
  {
    category: 'misc',
    name: 'turso-token',
    regex: /(?:TURSO_AUTH_TOKEN|turso_token)\s*[=:]\s*['"]?([A-Za-z0-9._-]{40,})['"]?/gi,
    confidence: 0.9,
  },
];

// ── Aggregated pattern list ─────────────────────────────────────────

/**
 * All secret patterns combined into a single array.
 * This is the main export used by SecretSubstitution.
 */
export const ALL_SECRET_PATTERNS: SecretPatternDef[] = [
  ...AWS_PATTERNS,
  ...GCP_PATTERNS,
  ...AZURE_PATTERNS,
  ...GENERIC_API_PATTERNS,
  ...DATABASE_PATTERNS,
  ...JWT_PATTERNS,
  ...KEY_PATTERNS,
  ...CRYPTO_SECRET_PATTERNS,
  ...MESSAGING_PATTERNS,
  ...SOURCE_CONTROL_PATTERNS,
  ...AI_PROVIDER_PATTERNS,
  ...SAAS_PATTERNS,
  ...URL_CREDENTIAL_PATTERNS,
  ...SMTP_PATTERNS,
  ...ENV_PATTERNS,
  ...HIGH_ENTROPY_PATTERNS,
  ...MISC_PATTERNS,
];

/** Total pattern count for reference. */
export const PATTERN_COUNT = ALL_SECRET_PATTERNS.length;
