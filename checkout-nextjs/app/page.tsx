"use client";

import { useState } from "react";

export default function Home() {
  // One press, one checkout: the button stays off while a checkout is starting
  // and while the browser is leaving for the payment page.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { checkoutUrl } = await res.json();
      window.location.href = checkoutUrl;
    } catch {
      setError("The checkout could not start. Nothing was charged. Please try again later.");
      setPending(false);
    }
  }

  return (
    <main>
      <h1>VonPay Checkout - Next.js Sample</h1>
      <button onClick={handleCheckout} disabled={pending}>
        {pending ? "Starting…" : "Pay $25.00"}
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
