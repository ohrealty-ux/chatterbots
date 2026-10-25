// AES-256-GCM encryption for data at rest (bot wake webhook url + key).
// Key from WAKE_ENC_KEY env (32 bytes, hex or base64). Random 12-byte IV per record.
// The bot id is bound in as AAD so a ciphertext cannot be moved to another bot.
import crypto from 'node:crypto';

export function wakeKeyConfigured() { return !!parseKey(process.env.WAKE_ENC_KEY); }

function parseKey(k) {
  if (!k) return null;
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, 'hex');
  try { const b = Buffer.from(k, 'base64'); if (b.length === 32) return b; } catch { /* ignore */ }
  return null;
}

// Returns a compact string: v1.<ivB64>.<tagB64>.<ctB64> — or throws if no key.
export function encryptForBot(botId, plaintext) {
  const key = parseKey(process.env.WAKE_ENC_KEY);
  if (!key) throw new Error('WAKE_ENC_KEY not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(botId)));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptForBot(botId, blob) {
  const key = parseKey(process.env.WAKE_ENC_KEY);
  if (!key) throw new Error('WAKE_ENC_KEY not configured');
  const [v, ivB64, tagB64, ctB64] = String(blob).split('.');
  if (v !== 'v1') throw new Error('bad_blob');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(String(botId)));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
