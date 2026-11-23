import Link from "next/link";

const STATUS_DOT = {
  live: "bg-live shadow-[0_0_0_4px_#7fc48a22]",
  burned: "bg-ember shadow-[0_0_0_4px_#e0715c22]",
  empty: "bg-dim",
} as const;

export function BrandHeader({
  status,
  tone = "live",
}: {
  status: string;
  tone?: keyof typeof STATUS_DOT;
}) {
  return (
    <header className="mb-8 flex sm:mb-10 items-baseline justify-between">
      <Link href="/" className="font-mono text-[13px] font-medium tracking-wide text-ink">
        share<span className="text-amber">/</span>secret
      </Link>
      <span className="flex items-center gap-2 font-mono text-xs text-dim">
        <i className={`inline-block h-[7px] w-[7px] rounded-full ${STATUS_DOT[tone]}`} />
        {status}
      </span>
    </header>
  );
}
