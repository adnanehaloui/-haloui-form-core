"use client";
import { useState } from "react";
import { ApiForm } from "@/components/client";

export function NewKey() {
  const [secret, setSecret] = useState<string | null>(null);
  return secret ? (
    <div className="rounded-lg border border-accent p-3 text-sm"><p className="mb-1 font-medium">Copy it now — it won't be shown again:</p><code className="break-all" data-testid="secret">{secret}</code></div>
  ) : (
    <ApiForm path="/developer/keys" submit="Create secret key" fields={[{ name: "name", label: "Key name", defaultValue: "server" }]} onDone={(r) => setSecret(r.secret)} />
  );
}
