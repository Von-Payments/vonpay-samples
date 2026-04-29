"use client";

export default function Home() {
  async function handleCheckout() {
    const res = await fetch("/api/checkout", { method: "POST" });
    const { checkoutUrl } = await res.json();
    window.location.href = checkoutUrl;
  }

  return (
    <main>
      <h1>VonPay Checkout - Next.js Sample</h1>
      <button onClick={handleCheckout}>Pay $25.00</button>
    </main>
  );
}
