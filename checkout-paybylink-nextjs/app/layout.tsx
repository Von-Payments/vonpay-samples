export const metadata = {
  title: "VonPay Pay-by-Link — Next.js Sample",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem", maxWidth: 960 }}>
        {children}
      </body>
    </html>
  );
}
