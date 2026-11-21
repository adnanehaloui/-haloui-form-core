import { LoginForm } from "./form";

export default async function Login({ searchParams }: { searchParams: Promise<{ redirectTo?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-5 py-10">
      <h1 className="h1">Sign in to AIX</h1>
      {sp.error === "link_expired" && <p className="text-sm text-bad">That link expired or was already used. Request a new one.</p>}
      <LoginForm redirectTo={sp.redirectTo ?? "/wallet"} />
      <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>
      <a className="btn" href={`/api/auth/google/start?redirectTo=${encodeURIComponent(sp.redirectTo ?? "/wallet")}`}>Continue with Google</a>
      <p className="muted">New here? Signing in creates your account and an empty wallet.</p>
    </div>
  );
}
