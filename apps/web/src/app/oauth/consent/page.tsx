import { redirect } from "next/navigation";
import { api, ApiError, getMe } from "@/lib/api";
import { ActionButton } from "@/components/client";

export default async function Consent({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams(sp).toString();
  const me = await getMe();
  if (!me) redirect(`/login?redirectTo=${encodeURIComponent(`/oauth/consent?${qs}`)}`);
  let info: any;
  try {
    info = await api(`/oauth/authorize/info?${qs}`);
  } catch (e) {
    return <p className="text-bad">{e instanceof ApiError ? e.message : "Invalid request"}</p>;
  }
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 py-10">
      <h1 className="h1">Connect {info.client.name} to AIX?</h1>
      <p className="muted">Signed in as {me!.user.email}. {info.client.name} will be redirected to {info.redirectHost}.</p>
      <ul className="card flex list-disc flex-col gap-1 pl-8 text-sm">{info.scopes.map((s: any) => <li key={s.scope}>{s.description}</li>)}</ul>
      <p className="text-xs text-muted">AIX never sees your Claude/ChatGPT login. You can disconnect any time from your wallet page.</p>
      <div className="flex gap-2">
        <ActionButton className="btn-primary" path="/oauth/authorize/decision" body={{ ...sp, decision: "allow" }} redirectField="redirectTo">Allow</ActionButton>
        <ActionButton path="/oauth/authorize/decision" body={{ ...sp, decision: "deny" }} redirectField="redirectTo">Cancel</ActionButton>
      </div>
    </div>
  );
}
