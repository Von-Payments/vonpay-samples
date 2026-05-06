"""
Server-side payment intent flow — auth -> capture -> partial refund -> idempotency replay.

Demonstrates the manual-capture lifecycle for the Vonpay Checkout API:
  1. Create a manual-capture intent (authorizes funds, does not settle).
  2. Capture the full authorized amount.
  3. Issue a partial refund.
  4. Replay step 1 with the same Idempotency-Key — server returns the
     original intent, not a duplicate.

SDK 0.5.0 exposes ``payment_intents.create`` and ``capabilities.get`` only.
Capture and refund are called through raw HTTP here (httpx, the SDK's own
transport, so we don't pull a second dependency); switch to
``payment_intents.capture`` and ``refunds.create`` once 0.6.x ships.
"""

from __future__ import annotations

import os
import secrets
import sys
import time
from typing import Any, TypedDict
from urllib.parse import quote

import httpx
from dotenv import load_dotenv
from vonpay.checkout import PaymentIntent, VonPayCheckout, VonPayError

load_dotenv()

SECRET_KEY = os.environ.get("VON_PAY_SECRET_KEY")
if not SECRET_KEY:
    print(
        "VON_PAY_SECRET_KEY is required. Copy .env.example to .env and paste your sandbox key.",
        file=sys.stderr,
    )
    sys.exit(2)

BASE_URL = (
    os.environ.get("VON_PAY_BASE_URL", "").rstrip("/")
    or "https://checkout-staging.vonpay.com"
)

vonpay = VonPayCheckout(SECRET_KEY, base_url=BASE_URL)


class RefundWire(TypedDict):
    """Wire shape (snake_case) of the Refund returned by /v1/refunds."""

    id: str
    payment_intent: str
    amount: int
    currency: str
    status: str  # "pending" | "succeeded" | "failed"
    reason: str | None


class PaymentIntentWire(TypedDict, total=False):
    """Wire shape (snake_case) of the PaymentIntent returned by capture."""

    id: str
    status: str
    amount: int
    currency: str
    capture_method: str
    next_action: str | None
    decline_code: str | None
    created_at: str
    metadata: dict[str, str]


class _RawHttpError(Exception):
    """Error raised by ``vonpay_post`` on a non-2xx response.

    Carries the same fields as ``VonPayError`` (status, code, request_id,
    current_status, reject_reason) so ``log_error`` treats both paths the
    same. When SDK 0.6.x lands, raw HTTP calls collapse into SDK calls and
    this class disappears.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        request_id: str | None = None,
        current_status: str | None = None,
        reject_reason: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.current_status = current_status
        self.reject_reason = reject_reason


def vonpay_post(
    path: str,
    body: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    """Raw HTTP call against Vonpay endpoints not yet wrapped by SDK 0.5.0.

    Matches the SDK's auth + idempotency + Von-Pay-Version conventions so a
    future migration to ``payment_intents.capture`` / ``refunds.create`` is a
    one-liner.
    """
    headers = {
        "Authorization": f"Bearer {SECRET_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Idempotency-Key": idempotency_key,
    }
    response = httpx.post(f"{BASE_URL}{path}", headers=headers, json=body, timeout=30.0)
    request_id = response.headers.get("X-Request-Id", "")

    if response.is_success:
        return response.json()  # type: ignore[no-any-return]

    payload: dict[str, Any] = {}
    try:
        payload = response.json()
    except (ValueError, httpx.DecodingError):
        # Body wasn't JSON — fall through with empty payload.
        pass

    raise _RawHttpError(
        f"{path} failed: {response.status_code} {payload.get('code', 'unknown')} — "
        f"{payload.get('error', response.reason_phrase)}",
        status=response.status_code,
        code=payload.get("code"),
        request_id=request_id,
        current_status=payload.get("current_status"),
        reject_reason=payload.get("reject_reason"),
    )


def log_error(label: str, err: BaseException) -> None:
    """Print a structured one-liner for either SDK or raw-HTTP errors.

    ``VonPayError`` from the SDK exposes ``code`` / ``status`` / ``request_id``
    directly, plus optional ``current_status`` / ``reject_reason`` on 422
    invalid_transition responses from lifecycle endpoints. The raw-HTTP path
    raises ``_RawHttpError`` with the same shape.
    """
    if isinstance(err, VonPayError):
        # current_status / reject_reason are only attributes on SDK >= 0.6.x;
        # 0.5.0 may not have them. getattr with default keeps this sample
        # forward-compatible without breaking on the published 0.5.0.
        print(
            f"[{label}] VonPayError",
            {
                "code": err.code,
                "status": err.status,
                "request_id": err.request_id,
                "current_status": getattr(err, "current_status", None),
                "reject_reason": getattr(err, "reject_reason", None),
                "message": str(err),
            },
            file=sys.stderr,
        )
        return
    if isinstance(err, _RawHttpError):
        print(
            f"[{label}] HTTPError",
            {
                "message": str(err),
                "status": err.status,
                "code": err.code,
                "request_id": err.request_id,
                "current_status": err.current_status,
                "reject_reason": err.reject_reason,
            },
            file=sys.stderr,
        )
        return
    print(
        f"[{label}] {type(err).__name__}",
        {"message": str(err)},
        file=sys.stderr,
    )


def main() -> None:
    # Mirror Node's runId derivation — base36 timestamp + 6 random chars —
    # so two simultaneous runs against the same merchant don't collide on the
    # idempotency keys.
    run_id = f"{int(time.time() * 1000):x}-{secrets.token_hex(3)}"
    create_key = f"pi-create-{run_id}"
    capture_key = f"pi-capture-{run_id}"
    refund_key = f"pi-refund-{run_id}"

    print("payment-intents-python sample", {"base_url": BASE_URL, "run_id": run_id})

    # 1. Create the manual-capture intent.
    intent: PaymentIntent
    try:
        intent = vonpay.payment_intents.create(
            amount=2500,
            currency="USD",
            capture_method="manual",
            metadata={"sample": "payment-intents-python", "run_id": run_id},
            idempotency_key=create_key,
        )
        print(
            "created",
            {
                "id": intent.id,
                "status": intent.status,
                "capture_method": intent.capture_method,
                "amount": intent.amount,
                "currency": intent.currency,
            },
        )
    except VonPayError as err:
        log_error("create", err)
        sys.exit(1)

    # The capture endpoint requires `authorized`. If the sandbox returned
    # anything else (decline, processor quirk), bail cleanly so the operator
    # can inspect rather than chasing a 422.
    if intent.status != "authorized":
        print(
            "create did not return authorized — aborting before capture",
            {
                "id": intent.id,
                "status": intent.status,
                "decline_code": intent.decline_code,
            },
            file=sys.stderr,
        )
        sys.exit(1)

    # 2. Capture the full authorized amount via raw HTTP (SDK 0.6.x).
    captured: PaymentIntentWire
    try:
        captured = vonpay_post(  # type: ignore[assignment]
            f"/v1/payment_intents/{quote(intent.id, safe='')}/capture",
            {},
            capture_key,
        )
        print(
            "captured",
            {
                "id": captured["id"],
                "status": captured["status"],
                "amount": captured["amount"],
            },
        )
    except _RawHttpError as err:
        log_error("capture", err)
        sys.exit(1)

    # 3. Partial refund via raw HTTP (SDK 0.6.x).
    refund: RefundWire
    try:
        refund = vonpay_post(  # type: ignore[assignment]
            "/v1/refunds",
            {
                "payment_intent": intent.id,
                "amount": 500,
                "reason": "customer_requested",
            },
            refund_key,
        )
        print(
            "refunded",
            {
                "id": refund["id"],
                "payment_intent": refund["payment_intent"],
                "amount": refund["amount"],
                "status": refund["status"],
            },
        )
    except _RawHttpError as err:
        log_error("refund", err)
        sys.exit(1)

    # 4. Replay create with the same Idempotency-Key. Server should return
    # the original intent verbatim — same id, no second authorization.
    try:
        replay = vonpay.payment_intents.create(
            amount=2500,
            currency="USD",
            capture_method="manual",
            metadata={"sample": "payment-intents-python", "run_id": run_id},
            idempotency_key=create_key,
        )
    except VonPayError as err:
        log_error("idempotency-replay", err)
        sys.exit(1)

    replay_matched = replay.id == intent.id
    print(
        "idempotency-replay",
        {
            "replayed_id": replay.id,
            "original_id": intent.id,
            "matched": replay_matched,
        },
    )
    if not replay_matched:
        print(
            "idempotency replay did not return the original intent — investigate",
            file=sys.stderr,
        )
        sys.exit(1)

    print("done")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 — top-level safety net
        log_error("main", err)
        sys.exit(1)
