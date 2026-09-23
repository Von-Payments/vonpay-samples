# Von Payments Checkout - Flask sample

Minimal end-to-end reference integration on Flask 3: create a session, redirect the buyer to `checkout.vonpay.com`, confirm the outcome server-side on `/success`, and verify HMAC webhooks on `/webhooks`. Python equivalent of the Express and Next.js samples.

- **Stack:** Flask 3+, Python 3.9+
- **Von Payments SDK:** [`vonpay-checkout`](https://pypi.org/project/vonpay-checkout/) 2.x - 2.7 or later (`>=2.7,<3`)
- **What it demonstrates:** session creation with an idempotency key, server-side return confirmation, HMAC webhook verification with raw-body parsing

## 5-minute setup

### 1. Get test keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Create sandbox**. Copy the values from the banner (only shown once):

- `vp_sk_test_...` - secret API key
- `whsec_...` - per-endpoint webhook signing secret (shown when you register a webhook endpoint)

You do not need a session signing secret (`ss_...`) for this sample. The return redirect is signed with a platform-wide secret no merchant holds, so the sample confirms the payment with your API key instead (see below).

### 2. Install and run

```bash
python -m venv .venv && source .venv/bin/activate    # or .venv\Scripts\activate on Windows
pip install -r requirements.txt

cp .env.example .env
# edit .env - paste in vp_sk_test_... and whsec_...

export VON_PAY_SECRET_KEY=vp_sk_test_...
export VON_PAY_WEBHOOK_SECRET=whsec_...
export BASE_URL=http://localhost:5000

flask --app app run
```

Open [http://localhost:5000](http://localhost:5000), click **Pay**, complete checkout at `checkout.vonpay.com`, watch `/success` confirm the payment with an authenticated session read.

### 3. Watch the webhook

Webhooks arrive at `POST /webhooks`. For local dev, tunnel your port and point the webhook URL at the tunnel:

```bash
# In another terminal
ngrok http 5000
# Register https://<id>.ngrok.io/webhooks in /dashboard/developers/webhooks
```

## How it works

```
app.py           - Flask app: /, /checkout, /webhooks, /success, /health
requirements.txt - flask + vonpay-checkout
```

The `sessions.create()` call sends an idempotency key derived from the order id (a retry that reuses the same order id returns the same session. This sample creates its order id per request, so in your code create the order first and reuse its id - otherwise a double-click or refresh still makes a second session) and returns a `CheckoutSession` dataclass with `id`, `checkout_url`, `expires_at`. The server redirects the buyer to `checkout_url`. After payment, the buyer is redirected back to `/success` with a signed query string. ⚠️ This sample does **not** verify that signature, deliberately: returns are signed with a platform-wide secret no merchant holds, so a per-merchant `ss_*` can only ever fail the check. ``sessions.confirm_return()`` instead re-reads the session from the API using your own secret key - an authenticated answer to “did this buyer pay”, which the signature never was.

Webhooks carry an `x-vonpay-signature` header of the form `t=<unix-seconds>,v1=<hex>` (the timestamp is inside the header - there is no separate timestamp header). `checkout.webhooks.construct_event(raw_body, signature_header, webhook_secret)` verifies the HMAC, checks the timestamp is within the freshness window (≤5 min old, ≤30 sec future), and returns a parsed `WebhookEvent`. The secret is your **per-endpoint signing secret** (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) - not your API key.

**Check `event.test_event` first.** A delivery from **Send test event** is signed like a real one and can carry a real session's ids, so when it is `True` the handler returns 2xx and does nothing else (the field exists from SDK 2.7, hence `>=2.7,<3`).

The webhook handler branches on `event.type`. `charge.succeeded` means the buyer actually paid - do **not** fulfill on `charge.failed`. Unknown event types are acked (200) with no action. ⚠️ Do **not** subscribe to `session.succeeded`: the server emits it internally but it is not in the merchant subscription catalog, which silently drops unknown keys and returns success - an endpoint subscribed to it receives nothing, forever.

## Security notes

- **Always use raw body for webhook verification.** This sample uses `request.get_data(as_text=True)` to grab the unparsed body before signature verification.
- **Two different secrets.** The webhook signing secret (`whsec_…`, set as `VON_PAY_WEBHOOK_SECRET`) signs webhooks. The API key (`vp_sk_*`) authenticates API calls and is what confirms a return. A per-merchant session signing secret (`ss_*`) is not used: it cannot verify the return redirect.
- **Session IDs are deep-link tokens.** Keep `event.session_id` / `event.transaction_id` out of general application logs.

## Going to production

- Move `VON_PAY_SECRET_KEY` and `VON_PAY_WEBHOOK_SECRET` into your secret manager. Never commit `.env`.
- Switch from `vp_sk_test_*` to `vp_sk_live_*` after KYC + contract review - see [Going Live](https://docs.vonpay.com/guides/going-live).
- Run behind a real WSGI server (gunicorn, uWSGI) - not Flask's dev server.

## Related

- [Quickstart](https://docs.vonpay.com/quickstart)
- [Python SDK reference](https://docs.vonpay.com/sdks/python-sdk)
- [Webhook verification guide](https://docs.vonpay.com/integration/webhook-verification)
- `checkout-express` - Node equivalent
- `checkout-nextjs` - Next.js App Router (cart → redirect)
