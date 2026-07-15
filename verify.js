/**
 * Credential smoke test — run `npm run verify` (or `node scripts/verify.js`).
 * Creates a minimal sandbox VOIE order and prints the IDs, proving the
 * client_id / sandbox key pair works before you demo anything.
 * Zero dependencies — Node 18+ only.
 */
const fs = require('fs');
const path = require('path');

for (const envPath of [
  path.join(__dirname, '..', '..', '.env'),
  path.join(__dirname, '..', '.env'),
]) {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const BASE = process.env.TRUV_API_BASE || 'https://prod.truv.com';

(async () => {
  const r = await fetch(`${BASE}/v1/orders/`, {
    method: 'POST',
    headers: {
      'X-Access-Client-Id': process.env.TRUV_CLIENT_ID,
      'X-Access-Secret': process.env.TRUV_SANDBOX_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      products: ['income'],
      first_name: 'Smoke',
      last_name: 'Test',
      order_number: `VERIFY-${Date.now()}`,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error(`❌ Truv returned HTTP ${r.status}:`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log('✅ Credentials work. Sandbox order created:');
  console.log(`   order_id:     ${data.id}`);
  console.log(`   user_id:      ${data.user_id}`);
  console.log(`   bridge_token: ${data.bridge_token}`);
})();
