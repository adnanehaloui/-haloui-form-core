import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getMe, money } from "@/lib/api";
import { LogoutButton } from "@/components/logout";

export const metadata: Metadata = { title: "AIX — AI app store", description: "One account, one wallet for AI apps." };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe().catch(() => null);
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-line">
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
            <Link href="/" className="text-base font-bold tracking-tight">AIX</Link>
            <Link href="/" className="text-muted hover:text-ink">Store</Link>
            {me && <Link href="/wallet" className="text-muted hover:text-ink">Wallet</Link>}
            {me && <Link href="/developer" className="text-muted hover:text-ink">Developers</Link>}
            {me && <Link href="/orgs" className="text-muted hover:text-ink">Organizations</Link>}
            {me?.isAdmin && <Link href="/admin" className="text-muted hover:text-ink">Admin</Link>}
            <span className="ml-auto flex items-center gap-3">
              {me ? (
                <>
                  <Link href="/wallet" className="pill" data-testid="nav-balance">{money(me.wallet.availableCents)}</Link>
                  <span className="hidden text-muted sm:inline">{me.user.email}</span>
                  <LogoutButton />
                </>
              ) : (
                <Link href="/login" className="btn-primary">Sign in</Link>
              )}
            </span>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
