import { Lead } from "@/components/lead";
import { PublicShell } from "@/components/public-shell";
import { StrainCard } from "@/components/strain-card";
import { strains } from "@/lib/catalog";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/available")({ component: Page });

function Page() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-6xl px-4 py-12 md:px-8 md:py-16">
        <Lead
          className="text-4xl md:text-5xl"
          kicker="The window"
          title={<h1>Current Stock</h1>}
        />
        <p className="mt-4 max-w-xl text-muted-foreground">
          A short list of what The Discus Den is showing right now.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {strains.map((s) => (
            <StrainCard key={s.id} strain={s} />
          ))}
        </div>
      </div>
    </PublicShell>
  );
}
