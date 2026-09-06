import { BrandWordmark } from "@/components/den-mark";
import { Lead } from "@/components/lead";
import { PublicShell } from "@/components/public-shell";
import { site } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/den")({ component: Page });

function Page() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8 md:py-20">
        <Lead
          className="text-4xl md:text-5xl"
          kicker={site.city}
          title={
            <h1>
              <BrandWordmark />
            </h1>
          }
        />
        <div className="mt-4 grid gap-6 text-base leading-relaxed text-muted-foreground">
          <p>The Discus Den is a small breeding and raising room in Chennai.</p>
          <p>
            Fish are quarantined, fed, and watched here before they leave. If you
            are new to the strain, we can hold them in the Den while you set up -
            the same way we already do for first-timers.
          </p>
          <p>
            One number for WhatsApp, pickup, and shipping talk. You will not get a
            different person on a different line.
          </p>
        </div>
      </div>
    </PublicShell>
  );
}
