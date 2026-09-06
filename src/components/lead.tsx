import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Kicker + display title + optional byline on one left edge.
 * Negative pull is relative to the display size set via className.
 */
export function Lead({
  kicker,
  title,
  byline,
  className,
}: {
  kicker: ReactNode;
  title: ReactNode;
  byline?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-fit flex-col items-start", className)}>
      <div className="-ml-2">
        <p className="text-[11px] tracking-[0.14em] text-primary uppercase">{kicker}</p>
      </div>
      <div className="font-display mt-2 leading-none tracking-tight">{title}</div>
      {byline ? (
        <div className="-ml-2 mt-[0.38em]">
          <p className="font-display text-[length:max(0.72rem,0.38em)] leading-none tracking-tight">
            {byline}
          </p>
        </div>
      ) : null}
    </div>
  );
}
