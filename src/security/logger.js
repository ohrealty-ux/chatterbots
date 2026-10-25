// Structured logger with redaction. Secret-bearing keys are never written; long strings are
// capped. Used for all server-side logging so tokens/passwords/keys can't leak into logs.
import crypto from 'node:crypto';

const REDACT_KEYS = new Set([
  'authorization', 'token', 'pw', 'password', 'key', 'webhook_key', 'webhookkey',
  'cookie', 'set-cookie', 'face', 'secret', 'editkey', 'edit_key', 'csrf', 'token_hash',
  'webhook_url', 'webhook_url_enc', 'webhook_key_enc', 'wake_enc_key', 'token_pepper',
]);
const MAX_STR = 300;

function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STR ? value.slice(0, MAX_STR) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEYS.has(k.toLowerCase())) { out[k] = '[redacted]'; continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STR);
}

// Strip token/pw/authorization substrings from a free-form log line.
function scrubLine(s) {
  return String(s)
    .replace(/eldr_[A-Za-z0-9_-]+/g, 'eldr_[redacted]')
    .replace(/xai-[A-Za-z0-9_-]+/g, 'xai-[redacted]')
    .replace(/(authorization|bearer|token|pw|password|webhook_key|cookie)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

function emit(level, args) {
  const parts = args.map(a => (typeof a === 'object' && a !== null) ? JSON.stringify(redact(a)) : scrubLine(a));
  // eslint-disable-next-line no-console
  console.log(new Date().toISOString(), `[${level}]`, ...parts);
}

export const logger = {
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  // REDACTED message helper for uncaught exceptions — logs the message, not the full stack.
  redactedError: (prefix, err) => emit('error', [prefix, scrubLine(err && err.message ? err.message : String(err))]),
};

// Hash an email for audit detail (so raw PII isn't stored in the audit log).
export function hashEmail(email) {
  return 'sha256:' + crypto.createHash('sha256').update(String(email || '').toLowerCase().trim()).digest('hex').slice(0, 16);
}

// Make the plain console-style logger used across the codebase, but redacting.
export function makeLog() { return (...a) => emit('info', a); }
