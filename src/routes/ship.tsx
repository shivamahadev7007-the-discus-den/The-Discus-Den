import { Lead } from "@/components/lead";
import { PublicShell } from "@/components/public-shell";
import { site } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/ship")({ component: Page });

function Page() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8 md:py-20">
        <Lead
          className="text-4xl md:text-5xl"
          kicker="South India"
          title={<h1>Shipping Info</h1>}
        />
        <p className="mt-4 text-muted-foreground">
          The Discus Den ships only within the five southern states. Direct store
          shopping and pick-up in Chennai, same WhatsApp number.
        </p>
        <ul className="mt-8 grid gap-2 sm:grid-cols-2">
          {site.shipStates.map((s) => (
            <li
              key={s}
              className="rounded-xl border border-border bg-card px-4 py-3 text-sm"
            >
              {s}
            </li>
          ))}
        </ul>
        <p className="mt-8 text-sm text-muted-foreground">
          Anywhere else - message first. We would rather say no than send a tired
          fish.
        </p>
      </div>
    </PublicShell>
  );
}