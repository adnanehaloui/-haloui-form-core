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
        <header className="sticky top-0 z-20 border-b border-line bg-[light-dark(rgba(255,255,255,.82),rgba(17,17,20,.82))] backdrop-blur">
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-sm">
            <Link href="/" className="flex items-center gap-2 text-base font-bold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-xs text-white">A</span>AIX
            </Link>
            <form action="/search" className="order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-sm">
              <input name="q" placeholder="Search apps" aria-label="Search apps" className="w-full rounded-full border border-line bg-card px-4 py-1.5 text-sm outline-none focus:border-accent" />
            </form>
            <Link href="/" className="text-muted hover:text-ink">Discover</Link>
            <Link href="/search" className="text-muted hover:text-ink">Apps</Link>
            <Link href="/connect" className="text-muted hover:text-ink">Connect your AI</Link>
            {me && <Link href="/wallet" className="text-muted hover:text-ink">Wallet</Link>}
            {me && <Link href="/workflows" className="text-muted hover:text-ink">Workflows</Link>}
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
