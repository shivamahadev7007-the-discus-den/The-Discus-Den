import { DenMark } from "@/components/den-mark";
import { Button } from "@/components/ui/button";
import type { Strain } from "@/lib/catalog";
import { waEnquire } from "@/lib/site";
import { cn } from "@/lib/utils";

const TONE: Record<Strain["tone"], string> = {
  platinum: "from-secondary",
  tiger: "from-muted",
  rose: "from-secondary",
  gold: "from-muted",
  blue: "from-sidebar",
  wild: "from-secondary",
};

export function StrainCard({ strain }: { strain: Strain }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div
        className={cn(
          "relative aspect-[4/3] overflow-hidden bg-linear-to-b to-card",
          TONE[strain.tone],
        )}
      >
        {strain.photo ? (
          <img
            src={strain.photo}
            alt={strain.name}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center">
            <DenMark className="size-16 opacity-80" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card/90 to-transparent" />
        <p className="absolute bottom-3 left-4 z-10 text-[11px] tracking-[0.16em] text-primary uppercase">
          {strain.size}
        </p>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h3 className="font-display text-xl tracking-tight">{strain.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{strain.line}</p>
        </div>
        <Button asChild variant="outline" className="mt-auto w-full">
          <a href={waEnquire(strain.name)} target="_blank" rel="noreferrer">
            Enquire on WhatsApp
          </a>
        </Button>
      </div>
    </article>
  );
}
