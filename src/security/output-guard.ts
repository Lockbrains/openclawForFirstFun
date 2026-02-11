/**
 * FirstClaw Output Guard
 *
 * Program-level defense mechanism that scans outbound text for sensitive
 * patterns (API keys, tokens, secrets) and redacts them before delivery
 * to any chat channel.
 *
 * This runs as the last filter before text leaves the system, ensuring
 * that even if the LLM is tricked into outputting secrets, they never
 * reach the end user.
 */

export type RedactedMatch = {
  pattern: string;
  original: string;
  replacement: string;
};

export type OutputGuardResult = {
  text: string;
  redacted: boolean;
  matches: RedactedMatch[];
};

// Each rule: [human-readable label, regex pattern]
const SENSITIVE_PATTERNS: Array<[string, RegExp]> = [
  // OpenAI
  ["OpenAI API Key", /sk-[A-Za-z0-9_-]{20,}/g],
  ["OpenAI Project Key", /sk-proj-[A-Za-z0-9_-]{20,}/g],

  // Anthropic
  ["Anthropic API Key", /sk-ant-[A-Za-z0-9_-]{20,}/g],

  // Google AI / GCP
  ["Google API Key", /AIza[A-Za-z0-9_-]{35}/g],

  // GitHub
  ["GitHub Token (classic)", /ghp_[A-Za-z0-9]{36,}/g],
  ["GitHub Token (fine-grained)", /github_pat_[A-Za-z0-9_]{22,}/g],
  ["GitHub OAuth Token", /gho_[A-Za-z0-9]{36,}/g],
  ["GitHub App Token", /ghu_[A-Za-z0-9]{36,}/g],
  ["GitHub Server Token", /ghs_[A-Za-z0-9]{36,}/g],
  ["GitHub Refresh Token", /ghr_[A-Za-z0-9]{36,}/g],

  // AWS
  ["AWS Access Key", /AKIA[A-Z0-9]{16}/g],
  [
    "AWS Secret Key",
    /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/g,
  ],

  // Slack
  ["Slack Bot Token", /xoxb-[A-Za-z0-9-]{24,}/g],
  ["Slack User Token", /xoxp-[A-Za-z0-9-]{24,}/g],
  ["Slack App Token", /xapp-[A-Za-z0-9-]{24,}/g],

  // Discord
  ["Discord Bot Token", /[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g],

  // Stripe
  ["Stripe Secret Key", /sk_live_[A-Za-z0-9]{24,}/g],
  ["Stripe Restricted Key", /rk_live_[A-Za-z0-9]{24,}/g],

  // Twilio
  ["Twilio Auth Token", /SK[a-f0-9]{32}/g],

  // Lark / Feishu (our primary channel - extra important)
  ["Lark App Secret", /(?:app_secret|APP_SECRET)\s*[=:]\s*[A-Za-z0-9]{20,}/g],

  // Generic patterns
  ["Bearer Token", /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g],
  [
    "Generic Secret Assignment",
    /(?:secret|password|token|api_key|apikey|access_key|private_key)\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/gi,
  ],

  // SSH private keys
  ["SSH Private Key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],

  // JWT tokens (3 base64 segments separated by dots)
  ["JWT Token", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+/=]{10,}/g],
];

const REDACT_PLACEHOLDER = "[REDACTED]";

/**
 * Scan text for sensitive patterns and redact them.
 * Returns the sanitized text and metadata about what was redacted.
 */
export function guardOutput(text: string): OutputGuardResult {
  if (!text || text.trim().length === 0) {
    return { text, redacted: false, matches: [] };
  }

  const matches: RedactedMatch[] = [];
  let sanitized = text;

  for (const [label, pattern] of SENSITIVE_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sanitized)) !== null) {
      const original = match[0];
      // Keep a small prefix for context (e.g., "sk-...") but redact the rest
      const prefix = original.slice(0, Math.min(6, Math.floor(original.length / 4)));
      const replacement = `${prefix}...${REDACT_PLACEHOLDER}`;
      matches.push({ pattern: label, original, replacement });
    }
  }

  // Apply redactions (longest matches first to avoid partial replacements)
  const sortedMatches = matches.toSorted((a, b) => b.original.length - a.original.length);
  for (const m of sortedMatches) {
    sanitized = sanitized.replaceAll(m.original, m.replacement);
  }

  return {
    text: sanitized,
    redacted: matches.length > 0,
    matches,
  };
}

/**
 * Quick boolean check - does the text contain any sensitive patterns?
 */
export function containsSensitiveContent(text: string): boolean {
  if (!text) {
    return false;
  }
  for (const [, pattern] of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
