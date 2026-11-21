"use client";
export function LogoutButton() {
  return (
    <button className="text-muted hover:text-ink" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/"; }}>
      Sign out
    </button>
  );
}
