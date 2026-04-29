import { VonPayCheckout } from "@vonpay/checkout-node";

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  const sessionSecret = process.env.VON_PAY_SESSION_SECRET!;
  const apiKey = process.env.VON_PAY_SECRET_KEY ?? "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  // v2 signatures require expectedSuccessUrl + expectedKeyMode; v1 ignores these options.
  // SDK auto-detects the format from params.sig prefix.
  const valid = VonPayCheckout.verifyReturnSignature(params, sessionSecret, {
    expectedSuccessUrl: `${baseUrl}/confirm`,
    expectedKeyMode: apiKey.includes("_test_") ? "test" : "live",
    maxAgeSeconds: 600,
  });

  if (!valid) {
    return (
      <main>
        <h1>Invalid return signature</h1>
        <p>The payment confirmation could not be verified.</p>
      </main>
    );
  }

  const minorAmount = Number.parseInt(params.amount ?? "", 10);
  const displayAmount = Number.isFinite(minorAmount) ? (minorAmount / 100).toFixed(2) : params.amount;

  return (
    <main>
      <h1>Payment successful</h1>
      <p>Session: {params.session}</p>
      <p>Status: {params.status}</p>
      <p>Amount: {displayAmount} {params.currency}</p>
      <p>Transaction: {params.transaction_id ?? "N/A"}</p>
    </main>
  );
}
