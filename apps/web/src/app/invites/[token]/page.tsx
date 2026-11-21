import Link from "next/link";
import { apiOrNull, getMe } from "@/lib/api";
import { ActionButton } from "@/components/client";

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await apiOrNull<{ orgName: string; role: string; email: string }>(`/invites/${token}`);
  if (!inv) return <p className="muted">This invitation is invalid, already used or expired.</p>;
  const me = await getMe();
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 py-10 text-center">
      <p className="text-5xl">🏢</p>
      <h1 className="h1">Join {inv.orgName} on AIX</h1>
      <p className="muted">You were invited as <b>{inv.role}</b> ({inv.email}).</p>
      {!me ? (
        <Link className="btn-primary rounded-full" href={`/login?redirectTo=${encodeURIComponent(`/invites/${token}`)}`}>Sign in as {inv.email} to accept</Link>
      ) : me.user.email !== inv.email ? (
        <p className="text-sm text-bad">You're signed in as {me.user.email}. Sign out and sign in as {inv.email} to accept.</p>
      ) : (
        <ActionButton className="btn-primary rounded-full" path={`/invites/${token}/accept`} redirectTemplate="/orgs/{orgId}">Accept invitation</ActionButton>
      )}
    </div>
  );
}
