"""Von Payments Checkout — Flask sample app."""

import os

from flask import Flask, redirect, request, jsonify
from markupsafe import escape
from vonpay.checkout import VonPayCheckout, VonPayError

app = Flask(__name__)

API_KEY = os.environ["VON_PAY_SECRET_KEY"]
SESSION_SECRET = os.environ["VON_PAY_SESSION_SECRET"]
# Per-endpoint webhook signing secret (whsec_…), shown once when you create the
# webhook endpoint. This is NOT your API key.
WEBHOOK_SECRET = os.environ["VON_PAY_WEBHOOK_SECRET"]
BASE_URL = os.environ["BASE_URL"].rstrip("/")

checkout = VonPayCheckout(API_KEY)


@app.get("/")
def index():
    return """
    <h1>Von Payments Checkout — Flask</h1>
    <form method="POST" action="/checkout">
        <button type="submit">Pay $14.99</button>
    </form>
    """


@app.post("/checkout")
def create_checkout():
    session = checkout.sessions.create(
        amount=1499, currency="USD", country="US",
        success_url=f"{BASE_URL}/success",
    )
    return redirect(session.checkout_url)


@app.post("/webhooks")
def webhooks():
    body = request.get_data(as_text=True)
    # The signed timestamp lives inside the signature header (t=,v1=) — there
    # is no separate timestamp header.
    signature = request.headers.get("X-VonPay-Signature", "")

    try:
        event = checkout.webhooks.construct_event(body, signature, WEBHOOK_SECRET)
    except VonPayError as e:
        print(f"Webhook verification failed: {e.code}")
        # 400 (not 401): the request is malformed/unverifiable, not an auth
        # challenge. Every other sample returns 400 here and the delivery
        # engine treats 4xx as a non-retryable bad request.
        return jsonify({"error": "invalid_signature"}), 400

    # Branch on event type. Only `session.succeeded` means the buyer actually paid;
    # do NOT fulfill orders on `session.failed`. Session IDs
    # are deep-link tokens — keep them out of general application logs and only
    # surface in systems with the same trust boundary as the API key itself.
    if event.event == "session.succeeded":
        # Replace this with your order-fulfillment logic. `event.session_id` and
        # `event.transaction_id` are available here; pass them to your
        # fulfillment system but avoid logging them verbatim.
        pass
    elif event.event == "session.failed":
        # Payment did not complete — do not fulfill.
        pass
    # Unknown event types — accept the webhook (ack 200) but take no action.

    return jsonify({"received": True})


@app.get("/success")
def success():
    params = dict(request.args)
    # v2 signatures require expected_success_url + expected_key_mode; v1 ignores these options.
    # SDK auto-detects the format from params.sig prefix.
    expected_mode = "test" if "_test_" in API_KEY else "live"
    if VonPayCheckout.verify_return_signature(
        params,
        SESSION_SECRET,
        expected_success_url=f"{BASE_URL}/success",
        expected_key_mode=expected_mode,
        max_age_seconds=600,
    ):
        status = escape(params.get("status", "unknown"))
        session = escape(params.get("session", ""))
        return f"<h1>Payment {status}</h1><p>Session: {session}</p>"
    return "<h1>Invalid signature</h1>", 400


@app.get("/health")
def health():
    result = checkout.health()
    return jsonify({"status": result.status, "latency_ms": result.latency_ms})


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG", "false").lower() == "true")
