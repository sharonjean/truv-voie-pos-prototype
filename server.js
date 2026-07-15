/**
 * Truv VOIE POS Prototype — backend (zero dependencies, Node 18+)
 *
 * Plays the role of the client's loan point-of-sale (POS) backend:
 *
 *   1. POST /api/orders       -> creates a Truv Embedded Order (server-side,
 *                                keys never reach the browser) and returns
 *                                the bridge_token to the front end
 *   2. GET  /api/orders/:id   -> retrieves the order + verification results
 *   3. POST /webhooks/truv    -> receives Truv webhooks, verifies the
 *                                X-WEBHOOK-SIGN HMAC-SHA256 signature
 *   4. GET  /api/events       -> in-memory webhook event feed for the UI
 *
 * Credentials come from ../.env or ./.env (TRUV_CLIENT_ID, TRUV_SANDBOX_KEY).
 * Run:  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- tiny .env loader (no dotenv dependency) ---------------- */
for (const envPath of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const TRUV_API_BASE = process.env.TRUV_API_BASE || 'https://prod.truv.com';
const TRUV_CLIENT_ID = process.env.TRUV_CLIENT_ID;
const TRUV_SECRET = process.env.TRUV_SANDBOX_KEY; // sandbox Access Secret

if (!TRUV_CLIENT_ID || !TRUV_SECRET) {
  console.error('Missing TRUV_CLIENT_ID / TRUV_SANDBOX_KEY. Add them to .env');
  process.exit(1);
}

const truvHeaders = {
  'X-Access-Client-Id': TRUV_CLIENT_ID,
  'X-Access-Secret': TRUV_SECRET,
  'Content-Type': 'application/json',
};

// In-memory webhook event log (a real integration would persist these).
const webhookEvents = [];

/* ---------- helpers ------------------------------------------------ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end('Not found');
  }
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (path.extname(file) === '.html') {
    // CSP for embedding Truv Bridge (see design doc §4.2):
    //   script-src https://cdn.truv.com  -> allows bridge.js to load
    //   frame-src  https://my.truv.com   -> allows the Bridge widget iframe
    // Missing these two is the most common cause of the widget failing to
    // load in embedded contexts. ('unsafe-inline' is only for this demo's
    // inline <script>/<style>; a production POS would use bundled assets.)
    headers['Content-Security-Policy'] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.truv.com",
      "frame-src https://my.truv.com",
      "connect-src 'self' https://*.truv.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
    ].join('; ');
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/**
 * Truv webhook signature check: X-WEBHOOK-SIGN = "v1=" + HMAC-SHA256(rawBody)
 * keyed with the Access Secret. MUST use the raw bytes — re-serializing the
 * parsed JSON breaks verification.
 */
function verifyTruvSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;
  const expected = 'v1=' + crypto.createHmac('sha256', TRUV_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/* ---------- route handlers ----------------------------------------- */

/** 1. Create an Embedded Order at the VOIE step */
async function createOrder(req, res) {
  let input = {};
  try { input = JSON.parse((await readBody(req)).toString() || '{}'); } catch {}
  const { first_name, last_name, email, ssn_last4, loan_number } = input;
  if (!first_name || !last_name) {
    return sendJson(res, 400, { error: 'first_name and last_name are required' });
  }

  const orderPayload = {
    products: ['income'], // "income" implicitly includes employment data
    first_name,
    last_name,
    ...(email ? { email } : {}),
    ...(ssn_last4 ? { ssn: ssn_last4 } : {}),
    external_user_id: `pos-${Date.now()}`,
    order_number: loan_number || `POS-${Date.now()}`,
    // Borrower is already inside our POS session — suppress Truv's own
    // outreach emails/SMS so the experience stays fully embedded.
    notification_settings: { suppress_user_notifications: true },
  };

  try {
    const r = await fetch(`${TRUV_API_BASE}/v1/orders/`, {
      method: 'POST',
      headers: truvHeaders,
      body: JSON.stringify(orderPayload),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Truv create-order error:', r.status, data);
      return sendJson(res, r.status, data);
    }
    console.log(`[orders] created order ${data.id} (user ${data.user_id})`);
    // Only what the browser needs — never forward API credentials.
    sendJson(res, 200, {
      order_id: data.id,
      user_id: data.user_id,
      bridge_token: data.bridge_token,
      order_number: data.order_number,
    });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: 'Failed to reach Truv API' });
  }
}

/** 2. Retrieve order + verification results */
async function getOrder(req, res, orderId) {
  try {
    const r = await fetch(`${TRUV_API_BASE}/v1/orders/${orderId}/`, { headers: truvHeaders });
    const data = await r.json();
    if (!r.ok) return sendJson(res, r.status, data);

    // Trim the order into what the POS results screen displays.
    const employers = (data.employers || []).map((e) => ({
      status: e.status,
      company_name: e.company_name,
      data_source: e.data_source,
      provider: e.provider,
      pdf_report: e.pdf_report,
      employments: (e.employments || []).map((emp) => ({
        job_title: emp.job_title,
        job_type: emp.job_type,
        start_date: emp.start_date,
        end_date: emp.end_date,
        income: emp.income,
        income_unit: emp.income_unit,
        pay_rate: emp.pay_rate,
        pay_frequency: emp.pay_frequency,
        statements_count: (emp.statements || []).length,
        w2s_count: (emp.w2s || []).length,
      })),
    }));

    sendJson(res, 200, {
      order_id: data.id,
      status: data.completed_at ? 'completed' : 'pending',
      completed_at: data.completed_at,
      voie_report_id: data.voie_report_id,
      employers,
    });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: 'Failed to reach Truv API' });
  }
}

/** 3. Webhook receiver with signature verification */
async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  const signature = req.headers['x-webhook-sign'];
  const valid = verifyTruvSignature(rawBody, signature);

  let payload = {};
  try { payload = JSON.parse(rawBody.toString() || '{}'); } catch {}

  const event = {
    received_at: new Date().toISOString(),
    signature_valid: valid,
    event_type: payload.event_type,
    status: payload.status,
    order_id: payload.order_id,
    user_id: payload.user_id,
    payload,
  };
  webhookEvents.unshift(event);
  console.log(`[webhook] ${event.event_type} status=${event.status} sig_valid=${valid}`);

  if (!valid) return sendJson(res, 401, { error: 'invalid signature' });

  // Recommended pattern: on order-status-updated -> completed, fetch the
  // order server-side (see getOrder) and move the loan file forward.
  sendJson(res, 200, { received: true });
}

/* ---------- server -------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/orders') return await createOrder(req, res);
    if (req.method === 'GET' && /^\/api\/orders\/[\w-]+$/.test(p)) return await getOrder(req, res, p.split('/').pop());
    if (req.method === 'POST' && p === '/webhooks/truv') return await handleWebhook(req, res);
    if (req.method === 'GET' && p === '/api/events') return sendJson(res, 200, webhookEvents.slice(0, 50));
    if (req.method === 'GET') return serveStatic(res, p);
    res.writeHead(405); res.end();
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'internal error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Truv VOIE POS prototype running: http://localhost:${PORT}`);
  console.log(`Truv API base: ${TRUV_API_BASE} (client ${TRUV_CLIENT_ID.slice(0, 6)}…)`);
});
