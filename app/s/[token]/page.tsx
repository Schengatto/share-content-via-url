import { RevealGate } from "./reveal-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </main>
  );
}

/**
 * The GET render is side-effect free: it only shows the reveal gate. The share
 * is consumed by an explicit user action (Server Action) inside RevealGate, so
 * prefetchers and link-preview bots can never burn a single-use link.
 */
export default async function AccessPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <Shell>
      <RevealGate token={token} />
    </Shell>
  );
}
