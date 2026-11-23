import type { Metadata } from "next";
import { RevealGate } from "./reveal-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEALED_TITLE = "A sealed message is waiting";
const SEALED_DESCRIPTION = "Someone shared something with you. It can be opened once, then it is burned.";

export const metadata: Metadata = {
  title: SEALED_TITLE,
  description: SEALED_DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    title: SEALED_TITLE,
    description: SEALED_DESCRIPTION,
    images: ["/opengraph-image"],
  },
  twitter: {
    card: "summary_large_image",
    title: SEALED_TITLE,
    description: SEALED_DESCRIPTION,
    images: ["/opengraph-image"],
  },
};

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-[560px] px-5 py-16">{children}</main>;
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
