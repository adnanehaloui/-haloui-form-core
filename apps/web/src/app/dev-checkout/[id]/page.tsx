import { ActionButton } from "@/components/client";

/** Local-dev stand-in for Stripe Checkout (only when STRIPE_SECRET_KEY is empty and AIX_DEV_ENDPOINTS=1). */
export default async function DevCheckout({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-10">
      <p className="pill self-start">Fake checkout — local development</p>
      <h1 className="h1">Pay with test money</h1>
      <p className="muted">Add STRIPE_SECRET_KEY to .env to use real Stripe test-mode Checkout instead.</p>
      <ActionButton className="btn-primary" path={`/_dev/checkout/${id}/complete`} redirectTo="/wallet?topup=success">Pay</ActionButton>
    </div>
  );
}
