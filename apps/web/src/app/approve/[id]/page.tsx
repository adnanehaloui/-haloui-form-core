import { redirect } from "next/navigation";
import { apiOrNull, getMe } from "@/lib/api";
import { ActionButton } from "@/components/client";

export default async function Approve({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getMe())) redirect(`/login?redirectTo=/approve/${id}`);
  const a = await apiOrNull<any>(`/approvals/${id}`);
  if (!a) return <p className="muted">Approval not found.</p>;
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-10 text-center">
      <p className="label">{a.app.name}</p>
      <p className="text-sm">This costs</p>
      <p className="text-5xl font-semibold tabular-nums">{a.display}</p>
      <p className="muted">{a.quantity} × {a.unit} — approve?</p>
      {a.status === "pending" ? (
        <div className="flex justify-center gap-2">
          <ActionButton className="btn-primary" path={`/approvals/${id}/decision`} body={{ decision: "approve" }}>Approve</ActionButton>
          <ActionButton path={`/approvals/${id}/decision`} body={{ decision: "deny" }}>Deny</ActionButton>
        </div>
      ) : (
        <p className={a.status === "approved" ? "text-good" : "muted"}>{a.status === "approved" ? "Approved — go back to your AI tool and run it again." : `This request is ${a.status}.`}</p>
      )}
    </div>
  );
}
