/** Exact rupees. Paise shown when present. Never compact, never drop paise. */
export function inr(value: number, _compact = false) {
  const n = Number.isFinite(value) ? value : 0;
  const hasPaise = Math.abs(n % 1) > 1e-9;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(n);
}

export function inrAxis(value: number) {
  const n = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(n);
}

export function pct(part: number, whole: number) {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(2)}%`;
}

export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function qty(value: number) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 3,
    minimumFractionDigits: 0,
  }).format(value);
}
