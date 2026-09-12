export interface Transaction {
  id: string
  description: string
  amountCents: number
  postedAt: string
  status: 'pending' | 'posted' | 'void'
}
export type Cadence = 'weekly' | 'monthly' | 'yearly'
export interface RecurringCharge {
  merchant: string
  amountCents: number
  cadence: Cadence
  lastChargedAt: string
  count: number
}

const DAY = 86_400_000
const CADENCES: { name: Cadence; min: number; max: number }[] = [
  { name: 'weekly', min: 5, max: 9 },
  { name: 'monthly', min: 26, max: 33 },
  { name: 'yearly', min: 363, max: 367 },
]

export function normalizeMerchant(description: unknown): string {
  const cleaned = String(description ?? '')
    .toUpperCase()
    .replace(/\b\d[\d\- ()]{6,}\d\b/g, ' ')
    .replace(/\.COM\b|\*|#|\d+/g, ' ')
    .replace(/\bSQ\b|\bTST\b|\bPP\b|\bUSA\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
    .split(' ')
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ')
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

function cadenceOf(dates: number[]): Cadence | null {
  const gaps = dates.slice(1).map((d, i) => (d - dates[i]!) / DAY)
  for (const c of CADENCES) if (gaps.every((g) => g >= c.min && g <= c.max)) return c.name
  return null
}

export function findRecurring(transactions: readonly Transaction[], now: Date): RecurringCharge[] {
  const groups = new Map<string, Transaction[]>()
  for (const t of transactions) {
    if (t.status !== 'posted' || t.amountCents <= 0 || Date.parse(t.postedAt) > now.getTime())
      continue
    const key = normalizeMerchant(t.description)
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const out: RecurringCharge[] = []
  for (const [merchant, rows] of groups) {
    if (rows.length < 2) continue
    rows.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt))
    const amounts = rows.map((r) => r.amountCents)
    const mid = median(amounts)
    if (!amounts.every((a) => Math.abs(a - mid) <= mid * 0.1)) continue
    const cadence = cadenceOf(rows.map((r) => Date.parse(r.postedAt)))
    if (!cadence) continue
    out.push({
      merchant,
      amountCents: mid,
      cadence,
      lastChargedAt: rows[rows.length - 1]!.postedAt,
      count: rows.length,
    })
  }
  return out.sort((a, b) => b.amountCents - a.amountCents)
}
