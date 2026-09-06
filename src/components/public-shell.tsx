import { BrandWordmark } from "@/components/den-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { site, waLink } from "@/lib/site";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState, type ReactNode } from "react";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/den", label: "About The Den" },
  { to: "/available", label: "Current Stock" },
  { to: "/ship", label: "Shipping Info" },
  { to: "/contact", label: "Contact" },
] as const;

export function PublicShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:gap-4 md:px-8">
          <Link to="/" className="flex min-w-0 flex-1 items-center overflow-visible">
            <BrandWordmark className="max-w-full text-base leading-none sm:text-lg" />
          </Link>

          <nav className="ml-auto hidden items-center gap-1 sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-10 items-center whitespace-nowrap rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  pathname === item.to && "text-primary",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <Button
            asChild
            className="hidden shrink-0 whitespace-nowrap shadow-[0_0_24px_rgba(212,176,106,0.28)] hover:shadow-[0_0_32px_rgba(212,176,106,0.42)] sm:inline-flex sm:ml-2"
          >
            <a href={waLink()} target="_blank" rel="noreferrer">
              WhatsApp the Den
            </a>
          </Button>

          <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0 sm:hidden"
                aria-label="Open menu"
              >
                <Menu className="size-5" />
              </Button>
            </DialogTrigger>
            <DialogContent
              className="fixed inset-y-0 right-0 top-0 left-auto z-50 flex h-svh max-h-svh w-[min(100%,20rem)] translate-x-0 translate-y-0 flex-col rounded-none border-y-0 border-r-0 p-0 sm:hidden"
              aria-describedby={undefined}
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3 pr-14">
                <DialogTitle className="text-base">Menu</DialogTitle>
              </div>
              <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
                {NAV.map((item) => (
                  <DialogClose asChild key={item.to}>
                    <Link
                      to={item.to}
                      className={cn(
                        "flex h-12 items-center rounded-xl px-3.5 text-base text-muted-foreground hover:bg-muted hover:text-foreground",
                        pathname === item.to && "bg-muted text-primary",
                      )}
                      onClick={() => setMenuOpen(false)}
                    >
                      {item.label}
                    </Link>
                  </DialogClose>
                ))}
              </nav>
              <div className="border-t border-border p-3">
                <Button asChild className="w-full shadow-[0_0_24px_rgba(212,176,106,0.28)]">
                  <a href={waLink()} target="_blank" rel="noreferrer">
                    WhatsApp the Den
                  </a>
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <main>{children}</main>

      <footer className="mt-8 border-t border-border/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:flex-row md:items-end md:justify-between md:px-8">
          <div>
            <p>
              <BrandWordmark className="text-2xl leading-none" />
            </p>
            <p className="font-display mt-2 text-sm leading-none tracking-tight">
              {site.owner}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">{site.city}</p>
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              Exclusive discus. Southern India shipping. Direct store shopping and
              pick-up.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <a className="text-primary hover:underline" href={waLink()}>
              WhatsApp {site.whatsappDigits}
            </a>
            <a
              className="text-muted-foreground hover:text-foreground"
              href={site.instagramUrl}
              target="_blank"
              rel="noreferrer"
            >
              Instagram @{site.instagram}
            </a>
            <a
              className="text-muted-foreground hover:text-foreground"
              href={site.youtubeUrl}
              target="_blank"
              rel="noreferrer"
            >
              YouTube
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
