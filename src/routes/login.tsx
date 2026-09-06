import { DenMark } from "@/components/den-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, authEnabled, GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isPending) {
    return (
      <main className="grid min-h-svh place-items-center px-4">
        <div className="w-full max-w-sm">
          <DenMark className="size-12" />
          <p className="font-display mt-4 text-3xl tracking-tight">The Discus Den</p>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to the ledger.</p>
          <div className="mt-8 h-40 animate-pulse rounded-2xl bg-muted" />
        </div>
      </main>
    );
  }
  if (user) return <Navigate to="/books" />;

  async function onEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "up") {
        const res = await authClient.signUp.email({ email, password, name: email.split("@")[0] });
        if (res.error) throw new Error(res.error.message);
      } else {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-svh place-items-center px-4">
      <div className="w-full max-w-sm">
        <DenMark className="size-12" />
        <p className="mt-4 text-[11px] tracking-[0.16em] text-primary uppercase">
          A Legacy of Elite Aquatics
        </p>
        <p className="font-display mt-1 text-3xl tracking-tight">The Discus Den</p>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to the ledger.</p>

        {authEnabled ? (
          <div className="mt-8 grid gap-2">
            {GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => signIn(p.providerId, { callbackURL: "/books" })}
              >
                Continue with {p.label}
              </Button>
            ))}
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">Sign-in is disabled.</p>
        )}

        <div className="my-6 flex items-center gap-3 text-[11px] tracking-widest text-muted-foreground uppercase">
          <span className="h-px flex-1 bg-border" />
          or email
          <span className="h-px flex-1 bg-border" />
        </div>

        <form className="grid gap-3" onSubmit={onEmail}>
          <label className="grid gap-1.5">
            <Label>Email</Label>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="grid gap-1.5">
            <Label>Password</Label>
            <Input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "up" ? "new-password" : "current-password"}
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>
            {mode === "up" ? "Create account" : "Sign in"}
          </Button>
        </form>
        <button
          type="button"
          className="mt-4 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setMode(mode === "up" ? "in" : "up")}
        >
          {mode === "up" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
      </div>
    </main>
  );
}
