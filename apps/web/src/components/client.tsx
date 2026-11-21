"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

/** Browser → /api/* (proxied to the AIX API, same-origin session cookie). */
export async function call(path: string, method = "POST", body?: unknown) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? res.statusText);
  return json;
}

/** All props are serializable so server components can render it. */
export function ActionButton(props: { path: string; method?: string; body?: unknown; children: ReactNode; className?: string; confirm?: string; redirectField?: string; redirectTo?: string; onDone?: (r: any) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        className={props.className ?? "btn"}
        disabled={busy}
        onClick={async () => {
          if (props.confirm && !window.confirm(props.confirm)) return;
          setBusy(true);
          setErr(null);
          try {
            const r = await call(props.path, props.method ?? "POST", props.body);
            props.onDone?.(r);
            const to = props.redirectField ? r[props.redirectField] : props.redirectTo;
            if (to) window.location.href = to;
            else router.refresh();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : props.children}
      </button>
      {err && <span className="text-xs text-bad">{err}</span>}
    </span>
  );
}

type Option = string | { label: string; value: string };
type Field = { name: string; label: string; type?: "text" | "email" | "number" | "money" | "select" | "textarea" | "checkbox"; options?: Option[]; placeholder?: string; defaultValue?: string; optional?: boolean };

/**
 * Small generic form → JSON API call. All props are serializable (usable from server components).
 * `money` fields take euros ("0.50") and send integer cents. Empty optional fields are omitted,
 * or sent as null when listed in `nullEmpty`. Fields in `arrays` are sent as one-element arrays.
 */
export function ApiForm(props: {
  path: string;
  method?: string;
  fields: Field[];
  submit: string;
  extra?: Record<string, unknown>;
  nullEmpty?: string[];
  arrays?: string[];
  redirectField?: string;
  redirectTemplate?: string;
  showResult?: { title: string; fields: string[] };
  onDone?: (r: any) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const v: Record<string, any> = { ...(props.extra ?? {}) };
        for (const f of props.fields) {
          const raw = fd.get(f.name);
          if (f.type === "checkbox") v[f.name] = raw === "on";
          else if (raw === null || raw === "") {
            if (props.nullEmpty?.includes(f.name)) v[f.name] = null;
            else if (!f.optional) v[f.name] = "";
          } else if (f.type === "number") v[f.name] = Number(raw);
          else if (f.type === "money") {
            const m = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(String(raw));
            if (!m) return setErr(`${f.label}: enter an amount like 0.50`);
            v[f.name] = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
          } else v[f.name] = raw;
          if (props.arrays?.includes(f.name) && v[f.name] !== undefined) v[f.name] = [v[f.name]];
        }
        setBusy(true);
        setErr(null);
        try {
          const r = await call(props.path, props.method ?? "POST", v);
          const to = props.redirectField ? r[props.redirectField] : props.redirectTemplate?.replace(/\{(\w+)\}/g, (_m: string, k: string) => String(r[k]));
          if (to) return void (window.location.href = to);
          props.onDone?.(r);
          if (props.showResult) setOut(r);
          router.refresh();
        } catch (e: any) {
          setErr(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {props.fields.map((f) => (
        <label key={f.name} className={f.type === "checkbox" ? "flex items-center gap-2 text-sm" : "block"}>
          {f.type !== "checkbox" && <span className="label">{f.label}</span>}
          {f.type === "select" ? (
            <select name={f.name} defaultValue={f.defaultValue} className="input">
              {f.options!.map((o) => {
                const opt = typeof o === "string" ? { label: o || "—", value: o } : o;
                return <option key={opt.value} value={opt.value}>{opt.label}</option>;
              })}
            </select>
          ) : f.type === "textarea" ? (
            <textarea name={f.name} defaultValue={f.defaultValue} placeholder={f.placeholder} className="input min-h-20" />
          ) : f.type === "checkbox" ? (
            <>
              <input type="checkbox" name={f.name} defaultChecked={f.defaultValue === "true"} /> {f.label}
            </>
          ) : (
            <input name={f.name} type={f.type === "money" || f.type === "number" ? "text" : (f.type ?? "text")} inputMode={f.type === "money" ? "decimal" : undefined} defaultValue={f.defaultValue} placeholder={f.placeholder} required={!f.optional && !props.nullEmpty?.includes(f.name)} className="input" />
          )}
        </label>
      ))}
      <div>
        <button className="btn-primary" disabled={busy}>
          {busy ? "…" : props.submit}
        </button>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
      {out && props.showResult && (
        <div className="rounded-lg border border-accent p-3 text-sm">
          <p className="mb-1 font-medium">{props.showResult.title}</p>
          {props.showResult.fields.map((k) => <p key={k}><span className="muted">{k}:</span> <code className="break-all">{String(out[k])}</code></p>)}
        </div>
      )}
    </form>
  );
}
