import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/components/require-auth";
import { PageSummary } from "@/components/page-summary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getStats } from "@/lib/ledger/actions";
import { inr, inrAxis } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const Route = createFileRoute("/books/")({ component: Home });

const MONTHS = [
  { n: 1, label: "Jan" },
  { n: 2, label: "Feb" },
  { n: 3, label: "Mar" },
  { n: 4, label: "Apr" },
  { n: 5, label: "May" },
  { n: 6, label: "Jun" },
  { n: 7, label: "Jul" },
  { n: 8, label: "Aug" },
  { n: 9, label: "Sep" },
  { n: 10, label: "Oct" },
  { n: 11, label: "Nov" },
  { n: 12, label: "Dec" },
] as const;

function currentPeriod() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function Home() {
  return (
    <RequireAuth>
      <AppShell>
        <Dashboard />
      </AppShell>
    </RequireAuth>
  );
}

function Dashboard() {
  const initial = currentPeriod();
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState<number | null>(initial.month);

  const stats = useQuery({
    queryKey: ["stats", year, month],
    queryFn: () => getStats({ data: { year, month } }),
  });
  const data = stats.data;
  const years = data?.availableYears?.length ? data.availableYears : [year];
  const yearly = month == null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.2em] text-muted-foreground uppercase">
            {yearly ? "Yearly overview" : "Monthly overview"}
          </p>
          <h1 className="font-display mt-1 text-3xl tracking-tight md:text-4xl">
            {yearly ? String(year) : format(new Date(year, month - 1, 1), "MMMM yyyy")}
          </h1>
          {data && (
            <PageSummary
              items={[
                { label: "Spent", value: inr(data.purchaseTotal) },
                { label: "Billed", value: inr(data.revenue) },
                { label: "Profit", value: inr(data.profit) },
                { label: "Sales", value: String(data.saleCount) },
                { label: "Purchases", value: String(data.purchaseCount) },
              ]}
            />
          )}
        </div>
        <div className="w-32">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger aria-label="Year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={yearly ? "default" : "outline"}
          className="min-h-11"
          onClick={() => setMonth(null)}
        >
          Full year
        </Button>
        {MONTHS.map((m) => (
          <Button
            key={m.n}
            type="button"
            size="sm"
            variant={!yearly && month === m.n ? "default" : "outline"}
            className="min-h-11 min-w-11 px-3"
            onClick={() => setMonth(m.n)}
          >
            {m.label}
          </Button>
        ))}
      </div>

      {stats.isError && (
        <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {stats.error.message}
        </p>
      )}

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sales" value={data ? inr(data.revenue) : "—"} />
        <Stat label="Purchase value" value={data ? inr(data.purchaseTotal) : "—"} />
        <Stat
          label="Profit on sales"
          value={data ? inr(data.profit) : "—"}
          good={(data?.profit ?? 0) >= 0}
        />
        <Stat
          label="Sales minus purchases"
          value={data ? inr(data.revenue - data.purchaseTotal) : "—"}
          good={data ? data.revenue - data.purchaseTotal >= 0 : undefined}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>{yearly ? "Month by month" : "Day by day"}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {yearly ? "Tap a month to drill in" : "Purchases versus sales"}
            </p>
          </CardHeader>
          <CardContent className="h-72">
            {data && data.points.some((p) => p.purchases || p.sales) ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.points}>
                  <CartesianGrid stroke="var(--color-border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    interval={yearly ? 0 : 2}
                  />
                  <YAxis
                    tickFormatter={(v) => inrAxis(Number(v))}
                    tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={72}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--color-muted)" }}
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 12,
                    }}
                    formatter={(v) => inr(Number(v))}
                  />
                  <Bar
                    dataKey="purchases"
                    name="Purchases"
                    fill="var(--color-chart-2)"
                    radius={[6, 6, 0, 0]}
                    cursor={yearly ? "pointer" : undefined}
                    onClick={(d) => {
                      if (!yearly) return;
                      const key = (d as { key?: string }).key;
                      if (key) setMonth(Number(key.slice(5, 7)));
                    }}
                  />
                  <Bar
                    dataKey="sales"
                    name="Sales"
                    fill="var(--color-chart-1)"
                    radius={[6, 6, 0, 0]}
                    cursor={yearly ? "pointer" : undefined}
                    onClick={(d) => {
                      if (!yearly) return;
                      const key = (d as { key?: string }).key;
                      if (key) setMonth(Number(key.slice(5, 7)));
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No monthly-book lines in this period.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Mix</CardTitle>
            <p className="text-sm text-muted-foreground">{yearly ? "This year" : "This month"}</p>
          </CardHeader>
          <CardContent className="h-72">
            {data && data.revenue > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={[
                    { name: "Fish", value: data.fishRevenue, fill: "var(--color-chart-1)" },
                    { name: "Supplies", value: data.suppliesRevenue, fill: "var(--color-chart-3)" },
                    { name: "Profit", value: data.profit, fill: "var(--color-chart-4)" },
                  ]}
                  margin={{ left: 16, right: 8 }}
                >
                  <CartesianGrid stroke="var(--color-border)" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => inrAxis(Number(v))}
                    tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    width={72}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--color-muted)" }}
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 12,
                    }}
                    formatter={(v) => inr(Number(v))}
                  />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                    <Cell fill="var(--color-chart-1)" />
                    <Cell fill="var(--color-chart-3)" />
                    <Cell fill="var(--color-chart-4)" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No sales in this period.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top customers</CardTitle>
          </CardHeader>
          <CardContent>
            {(data?.topCustomers ?? []).map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between border-b border-border py-2 last:border-0"
              >
                <p className="text-sm">{c.name}</p>
                <div className="text-right">
                  <p className="text-sm tabular-nums">{inr(c.revenue)}</p>
                  <p className="text-xs text-muted-foreground">profit {inr(c.profit)}</p>
                </div>
              </div>
            ))}
            {(!data || data.topCustomers.length === 0) && (
              <p className="text-sm text-muted-foreground">No sales in this period.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
          </CardHeader>
          <CardContent>
            {(data?.topProducts ?? []).map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0"
              >
                <p className="text-sm">{p.name}</p>
                <div className="text-right">
                  <p className="text-sm tabular-nums">{inr(p.revenue)}</p>
                  <Badge tone="ok">+{inr(p.profit)}</Badge>
                </div>
              </div>
            ))}
            {(!data || data.topProducts.length === 0) && (
              <p className="text-sm text-muted-foreground">No sales in this period.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-[11px] tracking-widest text-muted-foreground uppercase">{label}</p>
        <p
          className={cn(
            "font-display mt-2 text-2xl tracking-tight",
            good === false && "text-destructive",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
