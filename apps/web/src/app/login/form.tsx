"use client";
import { useState } from "react";
import { call } from "@/components/client";

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (sent) return <div className="card text-sm" data-testid="magic-sent">Check <b>{sent}</b> for your sign-in link.</div>;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const email = String(new FormData(e.currentTarget).get("email"));
        try {
          await call("/auth/magic-link", "POST", { email, redirectTo });
          setSent(email);
        } catch (e: any) {
          setErr(e.message);
        }
      }}
    >
      <label><span className="label">Email</span><input name="email" type="email" required className="input" placeholder="you@company.com" /></label>
      <button className="btn-primary">Email me a sign-in link</button>
      {err && <p className="text-sm text-bad">{err}</p>}
    </form>
  );
}
