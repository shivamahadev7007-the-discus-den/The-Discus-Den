import { Lead } from "@/components/lead";
import { PublicShell } from "@/components/public-shell";
import { Button } from "@/components/ui/button";
import { site, waLink } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/contact")({ component: Page });

function Page() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8 md:py-20">
        <Lead
          className="text-4xl md:text-5xl"
          kicker="One number"
          title={<h1>Contact</h1>}
        />
        <p className="mt-6 max-w-xl text-muted-foreground">
          Orders, pickup, shipping, first-timer holds - same line.
        </p>
        <div className="mt-10 grid gap-4">
          <div className="rounded-2xl border border-border bg-card p-6">
            <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
              WhatsApp
            </p>
            <p className="font-display mt-2 text-lg tracking-tight">{site.owner}</p>
            <p className="font-display mt-1 text-3xl tracking-tight">
              {site.whatsappDigits}
            </p>
            <Button asChild className="mt-5">
              <a href={waLink()} target="_blank" rel="noreferrer">
                Open chat
              </a>
            </Button>
          </div>
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
                Email
              </p>
              <a
                href={`mailto:${site.email}`}
                className="mt-2 block whitespace-nowrap text-lg tracking-tight text-foreground sm:text-xl"
              >
                {site.email}
              </a>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <a href={`mailto:${site.email}`}>Write an email</a>
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <a
              href={site.instagramUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-2xl border border-border bg-card p-6 hover:border-primary/40"
            >
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
                Instagram
              </p>
              <p className="mt-2 text-lg">@{site.instagram}</p>
            </a>
            <a
              href={site.youtubeUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-2xl border border-border bg-card p-6 hover:border-primary/40"
            >
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
                YouTube
              </p>
              <p className="mt-2 text-lg">The Discus Den</p>
            </a>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
