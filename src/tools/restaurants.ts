// Restaurant discovery. Two sources behind one interface: Google Places API
// (New) Text Search for live runs, and a fixture list for tests and offline
// demos. Search results are data, never instructions.

export interface Restaurant {
  id: string
  name: string
  address: string
  phone: string | null
  rating: number | null
  priceLevel: string | null
  cuisine: string | null
}

export interface RestaurantQuery {
  query: string
  limit?: number
  excludeIds?: readonly string[]
}

export interface RestaurantSearch {
  readonly source: 'google-places' | 'fixture'
  search(query: RestaurantQuery): Promise<Restaurant[]>
}

const clean = (value: unknown, max = 120): string | null =>
  typeof value === 'string' && value.trim()
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : null

const clampLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 5, 1), 10)

export class FixtureRestaurantSearch implements RestaurantSearch {
  readonly source = 'fixture' as const
  constructor(private readonly restaurants: readonly Restaurant[]) {}

  async search({ query, limit, excludeIds = [] }: RestaurantQuery): Promise<Restaurant[]> {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean)
    return this.restaurants
      .filter((r) => !excludeIds.includes(r.id))
      .map((r) => {
        const haystack = `${r.name} ${r.cuisine ?? ''}`.toLowerCase()
        return { r, score: words.filter((w) => haystack.includes(w)).length }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || (b.r.rating ?? 0) - (a.r.rating ?? 0))
      .slice(0, clampLimit(limit))
      .map(({ r }) => r)
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText'
export const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.rating',
  'places.priceLevel',
  'places.primaryType',
].join(',')

export class GooglePlacesRestaurantSearch implements RestaurantSearch {
  readonly source = 'google-places' as const

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    if (!apiKey) throw new Error('GOOGLE_API_KEY is required for Places search')
  }

  async search({ query, limit, excludeIds = [] }: RestaurantQuery): Promise<Restaurant[]> {
    const response = await this.fetchFn(PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, pageSize: clampLimit(limit) + excludeIds.length }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const body = (await response.json()) as { places?: unknown[]; error?: { status?: string } }
    if (!response.ok) throw new Error(`PLACES_${body.error?.status ?? response.status}`)
    return (body.places ?? [])
      .map((p) => toRestaurant(p))
      .filter((r): r is Restaurant => r !== null && !excludeIds.includes(r.id))
      .slice(0, clampLimit(limit))
  }
}

function toRestaurant(place: unknown): Restaurant | null {
  if (typeof place !== 'object' || place === null) return null
  const p = place as Record<string, unknown>
  const id = clean(p.id, 200)
  const name = clean((p.displayName as { text?: unknown } | undefined)?.text)
  if (!id || !name) return null
  return {
    id,
    name,
    address: clean(p.formattedAddress, 200) ?? '',
    phone: clean(p.nationalPhoneNumber, 40),
    rating: typeof p.rating === 'number' ? p.rating : null,
    priceLevel: clean(p.priceLevel, 40),
    cuisine: clean(p.primaryType, 60),
  }
}
