"""Von Payments Checkout — Flask sample app."""

import os

from flask import Flask, redirect, request, jsonify
from markupsafe import escape
from vonpay.checkout import VonPayCheckout, VonPayError

app = Flask(__name__)

API_KEY = os.environ["VON_PAY_SECRET_KEY"]
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
        # 400, not 401: the request is malformed or unverifiable, not an auth
        # challenge — there is no credential the caller could supply to retry
        # successfully. Every other sample returns 400 here, and the delivery
        # engine treats 4xx as a non-retryable bad request either way.
        return jsonify({"error": "invalid_signature"}), 400

    # Branch on event type. `charge.succeeded` is the event that means the buyer
    # actually paid; do NOT fulfill orders on `charge.failed`. Session IDs
    # are deep-link tokens — keep them out of general application logs and only
    # surface in systems with the same trust boundary as the API key itself.
    #
    # ⚠️ Do NOT subscribe to `session.succeeded`. The server emits it internally,
    # but it is absent from the merchant subscription catalog — which accepts an
    # unknown event key, stores nothing and returns success. An endpoint
    # subscribed to it receives nothing, forever, and no error is raised at any
    # layer. `charge.*` is the subscribable family.
    if event.type == "charge.succeeded":
        # Replace this with your order-fulfillment logic. `event.data.session_id`
        # and `event.data.transaction_id` are available here; pass them to your
        # fulfillment system but avoid logging them verbatim.
        pass
    elif event.type == "charge.failed":
        # Payment did not complete — do not fulfill.
        pass
    # Unknown event types — accept the webhook (ack 200) but take no action.

    return jsonify({"received": True})


@app.get("/success")
def success():
    params = dict(request.args)
    expected_mode = "test" if "_test_" in API_KEY else "live"

    # `confirm_return` verifies the signature AND confirms server-side that the
    # payment actually succeeded.
    #
    # ⚠️ Do NOT use `verify_return_signature` here and treat its True as proof
    # of payment. It proves the message is AUTHENTIC — a DECLINED payment is
    # signed just as authentically as an approved one. This page used to render
    # "Payment <status>" straight from the URL without gating on it, so
    # deliberately paying with a card you knew would decline still produced a
    # signature-valid page.
    #
    # The webhook handler above already had this guard; this one did not. Note
    # that it is the WEBHOOK that should trigger fulfilment — buyers close
    # laptops and never load this page.
    try:
        # ⚠️ NO secret argument, DELIBERATELY. Returns are signed with a
        # PLATFORM-WIDE secret that no merchant holds — holding it would let any
        # merchant forge any other merchant's confirmations. Passing a
        # per-merchant ``ss_*`` here buys a check that can only ever FAIL, and
        # gating the page on that failure renders "invalid signature" to a buyer
        # who just paid. ``signature_valid`` is ``None`` here (not checked); the
        # authenticated session read is what answers "did this buyer pay".
        outcome = checkout.sessions.confirm_return(
            params,
            expected_success_url=f"{BASE_URL}/success",
            expected_key_mode=expected_mode,
            max_age_seconds=600,
        )
    except VonPayError as e:
        # The lookup failed — we could not check. That is NOT "they did not
        # pay", so do not tell the buyer their payment failed.
        #
        # Log it. A revoked key or a rate-limit block would otherwise show every
        # buyer "please refresh in a moment" forever with nothing in your logs —
        # a permanent failure wearing the costume of a temporary one.
        app.logger.error("Return confirmation failed: %s", e.code)
        return (
            "<h1>We could not confirm your payment just now</h1>"
            "<p>No action needed — if you were charged, your order is safe. "
            "Please refresh in a moment.</p>",
            503,
        )

    # ⚠️ IN FLIGHT is not DECLINED. On the 3-D Secure path the buyer is returned
    # here BEFORE the charge settles, so this is the ordinary case there — not
    # an edge case. Telling this buyer their payment failed is how they end up
    # paying twice. Never a 402, never a retry affordance; the webhook settles it.
    if outcome.reason == "still_pending":
        return (
            "<h1>Confirming your payment…</h1>"
            "<p>Your bank is still finishing this off. You do not need to pay "
            "again — we'll email you as soon as it completes.</p>",
            200,
        )

    if not outcome.paid:
        status = escape(outcome.status or "unknown")
        return f"<h1>Payment not completed</h1><p>Status: {status}</p>", 402

    # ⚠️ Displaying a confirmation is safe to repeat. FULFILLING is not — this
    # URL can be replayed, and the status keeps reading "succeeded" every time.
    # Before shipping goods, record which session IDs you have already fulfilled
    # and refuse to fulfil one twice. Fulfil from the webhook, not from here.
    session = escape(outcome.session_id or "")
    status = escape(outcome.status or "")
    return f"<h1>Payment {status}</h1><p>Session: {session}</p>"


@app.get("/health")
def health():
    result = checkout.health()
    return jsonify({"status": result.status, "latency_ms": result.latency_ms})


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG", "false").lower() == "true")
