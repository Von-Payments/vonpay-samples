import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Acme CRM — platform integrator sample",
  description: "Von Payments platform-integrator sample (multi-tenant)",
};

const layoutCss = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f7f7f8; color: #0a0a0a; }
  .platform-shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
  .platform-header { background: #0a0a0a; color: #fff; padding: 0 1.5rem; height: 56px; display: flex; align-items: center; gap: 1.5rem; }
  .platform-header .brand { font-weight: 700; letter-spacing: -0.01em; }
  .platform-header .nav { display: flex; gap: 1.5rem; font-size: 14px; opacity: 0.8; }
  .platform-header .nav a { color: #fff; text-decoration: none; }
  .platform-main { padding: 2.5rem 2rem; max-width: 980px; margin: 0 auto; width: 100%; }
  .card { background: #fff; border: 1px solid #e8e8ec; border-radius: 12px; padding: 1.25rem 1.5rem; }
  .btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid #d4d4d8; background: #fff; color: #0a0a0a; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; }
  .btn-primary { background: #0a0a0a; color: #fff; border-color: #0a0a0a; }
  .btn-primary:hover { opacity: 0.9; }
  .muted { color: #6b6b70; font-size: 13px; }
  .badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 11px; font-weight: 600; background: #f0f0f3; color: #4a4a4f; }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: layoutCss }} />
      </head>
      <body>
        <div className="platform-shell">
          <header className="platform-header">
            <Link href="/" className="brand">Acme CRM</Link>
            <nav className="nav">
              <Link href="/">Tenants</Link>
              <span style={{ opacity: 0.5 }}>· Reporting</span>
              <span style={{ opacity: 0.5 }}>· Settings</span>
            </nav>
            <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.6 }}>
              Powered by <strong>Von Payments</strong>
            </span>
          </header>
          <main className="platform-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
