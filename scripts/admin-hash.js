#!/usr/bin/env node
// Generate an ADMIN_PASSWORD_HASH for the admin console.
// Usage:  npm run admin:hash -- 'your-strong-password'
//    or:  echo -n 'your-strong-password' | npm run admin:hash
// Prints ONLY the hash to stdout. Never logs the password anywhere.
import { hashPassword } from '../src/security/security.js';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

const argPw = process.argv.slice(2).join(' ');
const pw = argPw || (await readStdin());
const clean = pw.replace(/\r?\n$/, '');
if (!clean) {
  process.stderr.write("Provide a password: npm run admin:hash -- 'your-password'\n");
  process.exit(1);
}
process.stdout.write(hashPassword(clean) + '\n');
