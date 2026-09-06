import { cn } from "@/lib/utils";

export function DenMark({
  className,
  bare = false,
}: {
  className?: string;
  bare?: boolean;
}) {
  return (
    <svg
      viewBox={bare ? "1 8.5 30 17.5" : "0 0 32 32"}
      className={cn("block", className)}
      aria-hidden
    >
      {!bare && <rect width="32" height="32" rx="8" className="fill-sidebar" />}
      <g transform="scale(-1,1) translate(-32,0)">
        <ellipse
          cx="16"
          cy="17"
          rx="10"
          ry="8"
          fill="none"
          className="stroke-primary"
          strokeWidth="1.6"
        />
        <path
          d="M10 13.5 C12 11.5 20 11.5 22 13.5"
          fill="none"
          className="stroke-primary"
          strokeWidth="1"
          opacity="0.55"
        />
        <path
          d="M9.5 17 C13 15.2 19 15.2 22.5 17"
          fill="none"
          className="stroke-accent"
          strokeWidth="0.9"
          opacity="0.7"
        />
        <circle cx="21" cy="16" r="1.35" className="fill-primary" />
        <path d="M5.5 17 L2.5 13.5 L3.6 17 L2.5 20.5 Z" className="fill-primary" />
      </g>
    </svg>
  );
}

export function FleurMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 28" className={cn("block", className)} aria-hidden>
      <path
        className="fill-primary"
        d="M12 1.2c1.15 5.1 2.45 8.6 0 12.6C9.55 9.8 10.85 6.3 12 1.2z
           M13 9.4c3.7-2.7 9.3-1.4 8.1 4.1-1.9-1.1-4.6-.6-7 1.8.8-2.2.5-4.1-1.1-5.9z
           M11 9.4C7.3 6.7 1.7 8 2.9 13.5c1.9-1.1 4.6-.6 7 1.8-.8-2.2-.5-4.1 1.1-5.9z
           M5.6 15.2h12.8v1.7H5.6z
           M12 16.9c1.15 2 1.5 3.9 0 6.1-1.5-2.2-1.15-4.1 0-6.1z
           M12 21.2c-3.4-1.5-6.4 1-4.2 3.4 1.3-1.3 2.7-2.2 4.2-3.4z
           M12 21.2c3.4-1.5 6.4 1 4.2 3.4-1.3-1.3-2.7-2.2-4.2-3.4z
           M11.15 24.6h1.7V27H11.15z"
      />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display inline-flex max-w-full flex-wrap items-center tracking-tight",
        className,
      )}
    >
      <span className="whitespace-nowrap">The Discus Den</span>
      <FleurMark className="ml-[0.14em] h-[0.82em] w-auto shrink-0" />
      <DenMark bare className="ml-[0.14em] h-[0.95em] w-auto shrink-0" />
    </span>
  );
}
