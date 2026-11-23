"""Von Payments Checkout — Flask sample app."""

import os
import uuid
from typing import Any, Dict

from flask import Flask, Response, redirect, request, jsonify
from flask.typing import ResponseReturnValue
from markupsafe import escape
from vonpay.checkout import VonPayCheckout, VonPayError

app = Flask(__name__)
# A real webhook delivery is a few kilobytes. Flask refuses a larger body (413)
# before reading it, so an unsigned request cannot make this app buffer more.
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024

API_KEY = os.environ["VON_PAY_SECRET_KEY"]
# Per-endpoint webhook signing secret (whsec_…), shown once when you create the
# webhook endpoint. This is NOT your API key.
#
# Refuse to start when it is missing or still the .env.example placeholder:
# verifying against an empty or published value would accept a forged delivery.
WEBHOOK_SECRET = os.environ.get("VON_PAY_WEBHOOK_SECRET", "").strip()
if not WEBHOOK_SECRET or WEBHOOK_SECRET == "whsec_your_endpoint_signing_secret":
    raise SystemExit(
        "VON_PAY_WEBHOOK_SECRET is required (whsec_...). Copy .env.example to .env "
        "and set it to your endpoint's signing secret."
    )
BASE_URL = os.environ["BASE_URL"].rstrip("/")

# The SDK targets production by default; a ``vp_sk_test_*`` key runs in sandbox
# mode there (no separate host). Override VON_PAY_BASE_URL only if support
# directs you elsewhere. (BASE_URL above is THIS app's own address.)
VON_PAY_BASE_URL = (
    os.environ.get("VON_PAY_BASE_URL", "").rstrip("/") or "https://checkout.vonpay.com"
)

checkout = VonPayCheckout(API_KEY, base_url=VON_PAY_BASE_URL)


@app.get("/")
def index():
    return """
    <h1>Von Payments Checkout — Flask</h1>
    <form method="POST" action="/checkout">
        <button type="submit">Pay $14.99</button>
    </form>
    """


# The order each checkout session was created for, keyed by session id. In
# memory for the sample; a real app keeps this in its database (and the webhook
# handler marks the same row paid).
ORDERS_BY_SESSION: Dict[str, Dict[str, Any]] = {}

# The cookie that ties a return to the browser that started the checkout. It
# holds a random reference that only this server maps to the session, not the
# session id itself: the session id is in the return URL for anyone to read.
CHECKOUT_COOKIE = "vonpay_checkout_ref"
SESSION_BY_CHECKOUT_REF: Dict[str, str] = {}

# ⚠ In memory, so a flood of POST /checkout grows these maps without limit. At
# the cap this app refuses new checkouts (503) rather than forget an order
# someone may be paying. A real app keeps orders in its database.
MAX_OPEN_CHECKOUTS = 10_000

# Webhook event ids (``vp_evt_*``) processed to completion. Recorded only AFTER
# the handler succeeded, so a failed attempt is retried, not dropped. A real
# app keeps these in a table with a UNIQUE event id. A dict keeps insertion
# order, so it keeps the newest HANDLED_EVENT_CAP ids: a flood of signed
# deliveries cannot grow it without limit.
HANDLED_EVENT_IDS: Dict[str, None] = {}
HANDLED_EVENT_CAP = 10_000


def _mark_event_handled(event_id: str) -> None:
    if event_id in HANDLED_EVENT_IDS:
        return
    if len(HANDLED_EVENT_IDS) >= HANDLED_EVENT_CAP:
        # Forget the oldest id. A forgotten id reads as new again if it is ever
        # redelivered: one more reason to keep these in a database table.
        del HANDLED_EVENT_IDS[next(iter(HANDLED_EVENT_IDS))]
    HANDLED_EVENT_IDS[event_id] = None


# ⚠ Before deploying, rate-limit /checkout (per IP and per buyer) and put bot
# protection in front of it. Every call creates a checkout session on your key,
# and an open route like this is what card testers look for. This sample has
# neither.
@app.post("/checkout")
def create_checkout():
    if len(ORDERS_BY_SESSION) >= MAX_OPEN_CHECKOUTS:
        return jsonify({"error": "Too many open checkouts. Please try again later."}), 503
    # Stand-in for YOUR order id — in a real app, create the order first and use its id.
    order_id = f"order_{uuid.uuid4()}"
    amount = 1499
    currency = "USD"
    session = checkout.sessions.create(
        amount=amount, currency=currency, country="US",
        success_url=f"{BASE_URL}/success",
        metadata={"order_id": order_id},
        # Key on YOUR order id. Here orderId is made per request, so this only dedupes the SDK's own retry of this call; to dedupe a double-click or refresh, create the order first and reuse its id.
        idempotency_key=f"session:{order_id}",
    )
    # Remember which order this session pays for, on YOUR server. The return
    # page looks the order up from this record, never from the URL.
    ORDERS_BY_SESSION[session.id] = {
        "order_id": order_id,
        "amount": amount,  # minor units, exactly as sent above
        "currency": currency,
        "status": "pending",
    }
    response = redirect(session.checkout_url)
    # And tie the return to this browser, by a random reference mapped to the
    # session on this server. HttpOnly: page scripts cannot read it.
    # SameSite=Lax: it still comes back on the redirect from checkout.
    checkout_ref = str(uuid.uuid4())
    SESSION_BY_CHECKOUT_REF[checkout_ref] = session.id
    response.set_cookie(
        CHECKOUT_COOKIE,
        checkout_ref,
        httponly=True,
        samesite="Lax",
        path="/",
        secure=BASE_URL.startswith("https://"),
    )
    return response


@app.post("/webhooks")
def webhooks() -> ResponseReturnValue:
    # Annotated so a type checker reads this body: an unannotated function is
    # skipped by default, and this is the handler where a typo costs money.
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

    # A "Send test event" delivery is signed and can carry a real order's ids: acknowledge it and do nothing else.
    if event.test_event:
        return jsonify({"received": True})

    # Dedupe on ``event.id`` (``vp_evt_*``), unique per outbound event. A
    # redelivery (after a timeout or a 5xx, or a manual resend) carries the same
    # id: acknowledge it with 200 and do nothing else.
    if event.id in HANDLED_EVENT_IDS:
        return jsonify({"received": True, "deduped": True})

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
    try:
        data = event.data or {}
        session_id = data.get("session_id")
        order = ORDERS_BY_SESSION.get(session_id) if session_id else None
        if event.type == "charge.succeeded":
            if order is None:
                # Not a checkout this app started (or it restarted and forgot).
                # Acknowledge: a retry cannot make the order appear.
                app.logger.warning("Webhook %s: no order for this session; nothing fulfilled.", event.type)
            elif data.get("late_payment_auto_refunded") is True:
                # ⛔ A LATE payment that Von Payments already refunded in full:
                # it arrived after this checkout was closed as not paid, and the
                # buyer got the money back. Never fulfil on it, and leave the
                # order as it is: a payment the buyer made another way is a
                # different event.
                app.logger.warning(
                    "Order %s: a late payment was refunded automatically. Not fulfilled; order unchanged.",
                    order["order_id"],
                )
            elif not _paid_as_priced(order, data.get("amount"), data.get("currency")):
                # ⛔ A payment for another amount or currency is not this order
                # as priced: hold it for a person. A field the event leaves out
                # is not a mismatch.
                order["status"] = "needs_review"
                app.logger.error(
                    "Order %s: paid %s %s, expected %s %s. Not fulfilled.",
                    order["order_id"], data.get("amount"), data.get("currency"),
                    order["amount"], order["currency"],
                )
            elif order["status"] != "paid":
                order["status"] = "paid"
                # Replace this with your order-fulfillment logic (mark the order
                # row paid, ship, send the receipt). Pass
                # ``data["transaction_id"]`` to your fulfillment system but
                # avoid logging it verbatim.
                app.logger.info("Order %s paid.", order["order_id"])
        elif event.type == "charge.failed":
            # Payment did not complete — do not fulfill. ⛔ A failure never
            # undoes a payment: events arrive out of order, and a declined first
            # attempt can land after the payment that went through.
            if order is not None and order["status"] == "pending":
                order["status"] = "failed"
        # Unknown event types — accept the webhook (ack 200) but take no action.
    except Exception as e:  # noqa: BLE001 — any handler failure must be retried
        # OUR handler failed (a database write, say). 500 so the sender retries;
        # the event is not recorded, so the retry runs the handler again.
        app.logger.error("Webhook handler failed: %s", type(e).__name__)
        return jsonify({"error": "handler_failed"}), 500

    # Record the event only now, after it was processed without throwing.
    _mark_event_handled(event.id)
    return jsonify({"received": True})


def _paid_as_priced(order: Dict[str, Any], amount: Any, currency: Any) -> bool:
    """True when the reported payment matches the order's own amount and currency."""
    if isinstance(amount, int) and amount != order["amount"]:
        return False
    if isinstance(currency, str) and currency.upper() != order["currency"]:
        return False
    return True


# Shown when a return cannot be matched to an order this server created for
# this browser. Neutral on purpose: it is NOT "payment failed" (the buyer may
# well have paid; the webhook settles that) and it offers no "pay again".
NOT_MATCHED_PAGE = (
    "<h1>We couldn't match this payment to an order started in this browser</h1>"
    "<p>If you paid, your order is safe and you will get a confirmation. "
    "You do not need to pay again.</p>"
)


@app.get("/success")
def success():
    params = dict(request.args)
    expected_mode = "test" if "_test_" in API_KEY else "live"

    # ⚠️ Match the return to an order YOUR server created, before anything
    # else. `confirm_return` answers "did this session succeed?" for ANY
    # session on your account. Without this check, a success URL copied from
    # another paid order of your shop (a cheap one, say) would show a success
    # page for this one. So start from the session this browser started (the
    # cookie set at /checkout) and its order record here, and hand both to
    # `confirm_return` below: `expected_session_id` refuses a return that names
    # any other session, and `expected_amount` + `expected_currency` refuse a
    # session paid for a different figure.
    checkout_ref = request.cookies.get(CHECKOUT_COOKIE, "")
    started_session_id = SESSION_BY_CHECKOUT_REF.get(checkout_ref, "") if checkout_ref else ""
    order = ORDERS_BY_SESSION.get(started_session_id) if started_session_id else None
    if order is None:
        return NOT_MATCHED_PAGE, 400

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
            expected_session_id=started_session_id,
            expected_amount=order["amount"],
            expected_currency=order["currency"],
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

    # Not this order's payment: the return names another session (or none), or
    # the session was for a different amount or currency. Checked before the
    # status, so a paid session for another figure never reads as paid here.
    if outcome.reason in ("missing_session", "session_mismatch", "amount_mismatch"):
        if outcome.reason == "amount_mismatch":
            app.logger.error(
                "Return for order %s: the session's amount does not match the "
                "order; not shown as paid.",
                order["order_id"],
            )
        return NOT_MATCHED_PAGE, 400

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

    # ⚠️ RETURNED is not DECLINED. The buyer paid and the money went back, so this
    # is neither a failure nor a reason to offer "pay again". Do not fulfil.
    if outcome.reason == "refunded":
        return (
            "<h1>This payment was returned</h1>"
            "<p>The payment for this order went back to the buyer. There is nothing "
            "to pay. Contact us if this looks wrong.</p>",
            200,
        )

    if not outcome.paid:
        status = escape(outcome.status or "unknown")
        return f"<h1>Payment not completed</h1><p>Status: {status}</p>", 402

    # ⚠️ Displaying a confirmation is safe to repeat. FULFILLING is not — this
    # URL can be replayed, and the status keeps reading "succeeded" every time.
    # Before shipping goods, record which session IDs you have already fulfilled
    # and refuse to fulfil one twice. Fulfil from the webhook, not from here.
    order_id = escape(order["order_id"])
    session = escape(outcome.session_id or "")
    status = escape(outcome.status or "")

    # ⚠️ ``needs_review`` is still a payment, but hold the fulfilment and look
    # first. ``second_payment``: two payments on this session, so check both before
    # you ship or refund. ``refund_state_unknown``: the refund totals were not sent,
    # which is normal for a few moments after a payment and while a hold is open.
    if outcome.needs_review:
        app.logger.warning(
            "Return for order %s needs review: %s", order["order_id"], outcome.review_reason
        )
        return (
            "<h1>Payment received</h1>"
            "<p>We are checking this order and will email you. "
            "You do not need to pay again.</p>"
            f"<p>Order: {order_id}</p><p>Session: {session}</p>"
        )

    return (
        f"<h1>Payment {status}</h1>"
        f"<p>Order: {order_id}</p><p>Session: {session}</p>"
    )


@app.after_request
def no_referrer_on_return(response: Response) -> Response:
    # The return URL carries the session id and the signed return query. Send
    # no Referer from that page, so a link or an asset on it cannot pass them on.
    if request.path == "/success":
        response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/health")
def health():
    result = checkout.health()
    return jsonify({"status": result.status, "latency_ms": result.latency_ms})


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG", "false").lower() == "true")
