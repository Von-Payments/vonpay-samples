import { connection } from "next/server";

export const metadata = {
  title: "VonPay Checkout - Next.js Sample",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render every page per request, so Next.js can put this request's
  // Content-Security-Policy nonce on its scripts (see lib/csp.ts).
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
