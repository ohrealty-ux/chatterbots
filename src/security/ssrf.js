// SSRF-hardened outbound fetch for bot wake webhooks.
// https only · port 443 · no userinfo · DNS resolved by us · every resolved address checked
// against private/loopback/link-local/multicast ranges · re-checked at connect time via a
// custom lookup bound to a validated IP (stops DNS rebinding) · redirect:'manual' (3xx = fail)
// · 5s timeout · response body capped and ignored · no cookies.
import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import { promisify } from 'node:util';

const lookupAll = promisify(dns.lookup);

// Parse an IPv4 that may be written in decimal/octal/hex or with fewer than 4 parts.
function normalizeNumericIPv4(host) {
  if (net.isIP(host) === 4) return host;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(part)) return null;
    let n;
    if (/^0x/i.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else n = parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // Collapse shorthand (a, a.b, a.b.c, a.b.c.d) into dotted quad, matching inet_aton.
  let value;
  if (nums.length === 1) value = nums[0];
  else if (nums.length === 2) value = (nums[0] << 24) >>> 0 | nums[1];
  else if (nums.length === 3) value = (nums[0] << 24) >>> 0 | (nums[1] << 16) | nums[2];
  else value = (nums[0] << 24) >>> 0 | (nums[1] << 16) | (nums[2] << 8) | nums[3];
  if (value > 0xffffffff) return null;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function ipv4IsBlocked(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => n < 0 || n > 255 || Number.isNaN(n))) return true;
  const [a, b] = o;
  if (a === 0) return true;                         // 0.0.0.0/8
  if (a === 10) return true;                        // 10/8
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local (incl 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;          // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64/10 CGNAT
  if (a >= 224) return true;                        // 224/4 multicast + 240/4 reserved
  return false;
}

function ipv6IsBlocked(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (s === '::1' || s === '::') return true;                  // loopback / unspecified
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // fe80::/10
  if (s.startsWith('fc') || s.startsWith('fd')) return true;  // fc00::/7 ULA
  if (s.startsWith('ff')) return true;                         // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipv4IsBlocked(m[1]);
  return false;
}

export function ipIsBlocked(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4IsBlocked(ip);
  if (fam === 6) return ipv6IsBlocked(ip);
  return true; // not a literal IP → block
}

// Validate a webhook URL and resolve it to a safe IP. Returns { ok, ip, family, hostname, url } or { ok:false, reason }.
export async function validateWebhookUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'bad_url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'bad_port' };
  let host = u.hostname.replace(/\.$/, '');           // reject trailing-dot bypass
  if (!host || host.length > 253) return { ok: false, reason: 'bad_host' };
  if (/[^\x00-\x7f]/.test(host)) return { ok: false, reason: 'non_ascii_host' }; // reject raw IDN
  // Literal numeric host (any radix / shorthand) → normalize then check directly.
  const numeric = normalizeNumericIPv4(host);
  if (numeric) {
    if (ipIsBlocked(numeric)) return { ok: false, reason: 'blocked_ip' };
    return { ok: true, ip: numeric, family: 4, hostname: numeric, url: u };
  }
  if (net.isIP(host) === 6) {
    if (ipIsBlocked(host)) return { ok: false, reason: 'blocked_ip' };
    return { ok: true, ip: host, family: 6, hostname: host, url: u };
  }
  // DNS name: resolve ALL addresses, reject if ANY is unsafe.
  let addrs;
  try { addrs = await lookupAll(host, { all: true }); } catch { return { ok: false, reason: 'dns_fail' }; }
  if (!addrs.length) return { ok: false, reason: 'dns_empty' };
  for (const a of addrs) if (ipIsBlocked(a.address)) return { ok: false, reason: 'blocked_ip' };
  const chosen = addrs[0];
  return { ok: true, ip: chosen.address, family: chosen.family, hostname: host, url: u };
}

// Perform the hardened POST. Re-validates at send time, pins the connection to a checked IP
// while keeping Host/SNI for the original name. Body is sent as-is; headers set by caller.
export async function safeFetchPost(rawUrl, { body, headers = {}, timeoutMs = 5000 } = {}) {
  const v = await validateWebhookUrl(rawUrl);
  if (!v.ok) return { ok: false, reason: v.reason };
  const { url, ip, family, hostname } = v;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    // Custom lookup pins to the pre-validated IP AND re-checks at connect time.
    const lookup = (h, opts, cb) => {
      const c = typeof opts === 'function' ? opts : cb;
      if (ipIsBlocked(ip)) return c(new Error('blocked_ip'));
      c(null, ip, family);
    };
    const req = https.request({
      method: 'POST',
      host: hostname,
      servername: hostname,       // SNI stays the original name
      path: url.pathname + url.search,
      port: 443,
      headers: { ...headers, Host: url.host },
      lookup,
      timeout: timeoutMs,
    }, (res) => {
      // Any redirect is a failure (redirect:'manual' equivalent).
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); return done({ ok: false, reason: 'redirect', status: res.statusCode }); }
      let received = 0;
      res.on('data', (chunk) => { received += chunk.length; if (received > 4096) res.destroy(); }); // cap + ignore body
      res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      res.on('error', () => done({ ok: false, reason: 'res_error' }));
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, reason: e.message === 'blocked_ip' ? 'blocked_ip' : 'req_error' }));
    req.setHeader('Content-Length', Buffer.byteLength(body || ''));
    req.end(body || '');
  });
}
