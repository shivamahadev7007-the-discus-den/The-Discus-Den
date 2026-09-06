import { BrandWordmark } from "@/components/den-mark";
import { Lead } from "@/components/lead";
import { PublicShell } from "@/components/public-shell";
import { Button } from "@/components/ui/button";
import { site } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <PublicShell>
      <section className="relative overflow-x-clip overflow-y-visible">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 md:grid-cols-[1.1fr_0.9fr] md:items-start md:px-8 md:py-12">
          <div>
            <Lead
              className="text-[clamp(1.75rem,8vw,4.5rem)] md:text-6xl lg:text-7xl"
              kicker={`${site.city} · Exclusive discus`}
              title={
                <h1>
                  <BrandWordmark />
                </h1>
              }
            />
            <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">
              {site.tagline} Not a pet shop. A small Chennai Den where discus are
              raised, held, and sent only when they are ready.
            </p>
            <div className="mt-8">
              <Button
                asChild
                className="border-0 bg-foreground text-background hover:bg-[#fff6e8] hover:opacity-100"
              >
                <Link to="/available">See what’s in the Den</Link>
              </Button>
            </div>
          </div>
          <div className="rounded-3xl border border-border bg-card/60 p-8 md:p-10">
            <p className="text-[11px] tracking-[0.18em] text-primary uppercase">
              How it works
            </p>
            <ol className="mt-6 grid gap-5 text-sm">
              <Step n="01" title="Tell us the strain">
                WhatsApp the fish you like. One number. That’s the whole front desk.
              </Step>
              <Step n="02" title="We hold and raise">
                First-timers can leave fish in the Den until they settle. We don’t
                rush a box.
              </Step>
              <Step n="03" title="Store, pick-up, or ship">
                Direct store shopping and pick-up in Chennai, or packed for the five
                southern states.
              </Step>
            </ol>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: string;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-4">
      <span className="font-mono text-xs text-primary">{n}</span>
      <span>
        <span className="block font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}
