# Truv VOIE POS Prototype

A working prototype of a custom **point-of-sale loan application** with **Truv VOIE (Verification of Income & Employment)** embedded at the verification step, using Truv's **Embedded Orders** flow — mimicking the Truv // nCino integration.

## What it demonstrates

1. **Borrower-facing step** — a 3-step loan application; at step 2 the Truv Bridge widget launches in order mode (`isOrder: true`) with a `bridge_token` created server-side.
2. **Sandbox verification** — complete the flow with Truv sandbox credentials (`goodlogin` / `goodpassword`).
3. **Results retrieval** — after the Bridge fires `COMPLETED` (source `order`), the backend calls `GET /v1/orders/{id}/` and the UI displays employer, job title, income, pay frequency, paystub/W-2 counts, and the PDF report link. A "Behind the scenes" panel logs every API call, Bridge event, and webhook in real time.

## Architecture

```
Browser (public/index.html)                 Backend (server.js, Express)            Truv
────────────────────────────                ─────────────────────────────           ────
Step 2 "Verify with Truv"  ──────────────►  POST /api/orders  ────────────────────► POST /v1/orders/
                           ◄──────────────  { order_id, bridge_token }  ◄────────── { id, user_id, bridge_token }
TruvBridge.init({ isOrder: true,
  bridgeToken }) → borrower connects payroll ─────────────────────────────────────► (Bridge ↔ my.truv.com)
onEvent COMPLETED (source "order")
                                            POST /webhooks/truv  ◄───────────────── task-status-updated /
                                            (verifies X-WEBHOOK-SIGN HMAC)          order-status-updated
Step 3 results  ──────────────────────────► GET /api/orders/:id ─────────────────► GET /v1/orders/{id}/
```

API credentials never reach the browser — the front end only ever sees the single-use `bridge_token`.

## Run it

Requires Node 18+ (`node -v` to check — the server uses the built-in `fetch`).

```bash
# 1. Copy .env.example to .env and fill in your sandbox credentials:
cp .env.example .env
#    TRUV_CLIENT_ID=...
#    TRUV_SANDBOX_KEY=sandbox-...

# 2. Smoke-test credentials (zero dependencies — Node 18+ is all you need)
npm run verify        # creates a sandbox order, prints order_id/bridge_token

# 3. Start
npm start             # http://localhost:3000
```

In the Bridge widget, search any employer and log in with **`goodlogin` / `goodpassword`** (other scenarios: `hourly.part-time`, `multiple.employments`, `goodlogin`/`mfa` for an MFA flow — all with password `goodpassword` unless noted).

## Webhooks (optional but recommended for the demo)

The results screen works by polling, so webhooks aren't required to run the demo. To show real-time webhooks in the side panel:

```bash
ngrok http 3000   # note the https URL

curl -X POST https://prod.truv.com/v1/webhooks/ \
  -H "X-Access-Client-Id: $TRUV_CLIENT_ID" \
  -H "X-Access-Secret: $TRUV_SANDBOX_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "POS prototype",
    "webhook_url": "https://YOUR-NGROK-SUBDOMAIN.ngrok.io/webhooks/truv",
    "events": ["order-created", "task-status-updated", "order-status-updated"],
    "env_type": "sandbox",
    "enabled": true
  }'
```

The server verifies each delivery's `X-WEBHOOK-SIGN` header (HMAC-SHA256 of the **raw** body with the Access Secret, `v1=` prefix) before trusting it.

## Deploying (for a hosted link)

Any Node host works — Render, Railway, Fly.io. Set env vars `TRUV_CLIENT_ID`, `TRUV_SANDBOX_KEY`, and register the deployed `/webhooks/truv` URL as a sandbox webhook. Start command: `node server.js`.
