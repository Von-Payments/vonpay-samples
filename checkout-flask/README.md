# Von Payments Checkout — Flask sample

Server-only reference integration for the **cart → redirect** pattern using the Python SDK on Flask. A merchant server creates a session, redirects the buyer to `checkout.vonpay.com`, and verifies both the signed return redirect and the HMAC-signed webhook when the session resolves.

- **Stack:** Python 3.9+, Flask
- **SDK:** [`vonpay-checkout`](https://pypi.org/project/vonpay-checkout/)
- **Best for:** Python services, internal billing, SaaS server-side

## What it demonstrates

| Feature | Where |
|---|---|
| Session creation | `app.py` → `POST /checkout` |
| Return URL signature verification (v1 + v2 auto-detect) | `app.py` → `GET /success` |
| HMAC-SHA256 webhook signature verification | `app.py` → `POST /webhooks` |
| Health check (SDK → API connectivity) | `app.py` → `GET /health` |

## 5-minute setup

### 1. Get sandbox keys

Sign up at [app.vonpay.com](https://app.vonpay.com), complete OTP, then `/dashboard/developers` → **Activate Vora Sandbox**. You'll get:

- `vp_sk_test_...` — secret API key
- `ss_test_...` — session signing secret

### 2. Configure + run

```bash
cp .env.example .env
# edit .env — paste in vp_sk_test_... and ss_test_...

python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Load env vars then run (use python-dotenv, direnv, or your shell):
export $(grep -v '^#' .env | xargs)
python app.py
```

Open `http://localhost:3000`, click **Pay $14.99**, complete checkout with a [test card](https://docs.vonpay.com/reference/test-cards) (e.g. `4242 4242 4242 4242`), watch the success page render.

### 3. Test the webhook (optional)

Expose port 3000 via [`ngrok`](https://ngrok.com) or [`cloudflared`](https://github.com/cloudflare/cloudflared) and register the public URL as your webhook endpoint in the dashboard. Complete a checkout and watch `Webhook: session.succeeded — session sess_...` log.

## File layout

```
checkout-flask/
├── app.py             # Flask app — all routes
├── requirements.txt   # vonpay-checkout, flask
└── .env.example
```

## Key code

**Session creation** — `app.py`:

```python
session = checkout.sessions.create(
    amount=1499,
    currency="USD",
    country="US",
    success_url=f"{BASE_URL}/success",
)
return redirect(session.checkout_url)
```

**Return signature verification** — `GET /success`:

```python
expected_mode = "test" if "_test_" in API_KEY else "live"
if VonPayCheckout.verify_return_signature(
    params,
    SESSION_SECRET,
    expected_success_url=f"{BASE_URL}/success",
    expected_key_mode=expected_mode,
    max_age_seconds=600,
):
    # render success
```

The SDK auto-detects v1 vs v2 signatures from the `sig` parameter; pass v2 kwargs unconditionally — v1 ignores them. See [docs.vonpay.com/integration/handle-return](https://docs.vonpay.com/integration/handle-return).

**Webhook verification** — `POST /webhooks`:

```python
body = request.get_data(as_text=True)
event = checkout.webhooks.construct_event(
    body,
    request.headers.get("X-VonPay-Signature", ""),
    API_KEY,
    request.headers.get("X-VonPay-Timestamp", ""),
)
```

`request.get_data(as_text=True)` returns the **raw** request body — required so the HMAC matches byte-for-byte.

## Going to production

- Move `VON_PAY_SECRET_KEY` and `VON_PAY_SESSION_SECRET` into your secret manager. Never commit `.env`.
- Switch from `vp_sk_test_*` to `vp_sk_live_*` after KYC + contract review — see [Going Live](https://docs.vonpay.com/guides/going-live).
- Add idempotency to the webhook handler — `event.id` is unique per delivery; cache seen IDs (Redis recommended) to handle retries.
- Run behind a real WSGI server (gunicorn, uWSGI) — not Flask's dev server.

## Tested against

`vonpay-checkout` (latest at time of writing) · last verified 2026-04-28
