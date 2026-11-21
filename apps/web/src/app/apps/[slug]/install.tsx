"use client";
import { useState } from "react";
import { ActionButton } from "@/components/client";

export function InstallPanel(props: { slug: string; signedIn: boolean; me: any; permissionLines: string[]; orgs: { id: string; name: string }[]; price?: string }) {
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState("");
  if (!props.signedIn) return <a className="btn-primary w-full rounded-full py-2.5 text-base" href={`/login?redirectTo=/apps/${props.slug}`}>Get</a>;
  if (props.me?.installed)
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-[light-dark(#fff,#16161b)] p-4">
        <p className="text-sm font-medium text-good">✓ Installed{props.me.installedOrgId ? " (paid by your organization)" : ""}</p>
        <ActionButton path={`/store/apps/${props.slug}/install`} method="DELETE" confirm="Uninstall this app?">Uninstall</ActionButton>
      </div>
    );
  if (!props.me?.allowed) return <div className="rounded-2xl border border-line p-4 text-sm text-bad">🔒 {props.me?.blockedReason}</div>;
  return (
    <div className={open ? "flex flex-col gap-3 rounded-2xl border border-line bg-[light-dark(#fff,#16161b)] p-4 shadow-sm" : "flex flex-col gap-1.5"}>
      {!open ? (
        <>
          <button className="btn-primary w-full rounded-full py-2.5 text-base" onClick={() => setOpen(true)} data-testid="install">Get</button>
          <p className="text-center text-xs text-muted">{props.price ?? "Free"}</p>
        </>
      ) : (
        <>
          <h3 className="font-semibold">This app will be able to:</h3>
          <ul className="list-disc pl-5 text-sm" data-testid="permissions">{props.permissionLines.map((l) => <li key={l}>{l}</li>)}</ul>
          {props.orgs.length > 0 && (
            <label><span className="label">Pay with</span>
              <select className="input" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                <option value="">My wallet</option>
                {props.orgs.map((o) => <option key={o.id} value={o.id}>{o.name} wallet</option>)}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            <ActionButton className="btn-primary" path={`/store/apps/${props.slug}/install`} body={{ acceptPermissions: true, ...(orgId ? { orgId } : {}) }}>Allow & install</ActionButton>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

export function SubscribeButton(props: { slug: string; priceId: string; label: string }) {
  return <ActionButton className="btn-primary" path={`/store/apps/${props.slug}/subscribe`} body={{ priceId: props.priceId }} redirectField="checkoutUrl">Subscribe — {props.label}</ActionButton>;
}
