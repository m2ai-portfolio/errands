import { describe, expect, it } from 'vitest'
import {
  FixtureRestaurantSearch,
  GooglePlacesRestaurantSearch,
  PLACES_FIELD_MASK,
  PLACES_URL,
  type Restaurant,
} from '../src/tools/restaurants.js'

const fixtures: Restaurant[] = [
  {
    id: 'bella',
    name: 'Bella Cucina',
    address: '1 Main St, Nashville, TN',
    phone: '(615) 555-0101',
    rating: 4.7,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    cuisine: 'italian_restaurant',
  },
  {
    id: 'roma',
    name: 'Trattoria Roma',
    address: '9 Oak Ave, Nashville, TN',
    phone: '(615) 555-0102',
    rating: 4.5,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    cuisine: 'italian_restaurant',
  },
  {
    id: 'taco',
    name: 'Taco Town',
    address: '5 Elm St, Nashville, TN',
    phone: null,
    rating: 4.9,
    priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
    cuisine: 'mexican_restaurant',
  },
]

describe('FixtureRestaurantSearch', () => {
  it('matches on name or cuisine and ranks by relevance then rating', async () => {
    const found = await new FixtureRestaurantSearch(fixtures).search({ query: 'italian nashville' })
    expect(found.map((r) => r.id)).toEqual(['bella', 'roma'])
  })

  it('excludes restaurants already tried, which is how the fallback finds a new one', async () => {
    const found = await new FixtureRestaurantSearch(fixtures).search({
      query: 'italian',
      excludeIds: ['bella'],
    })
    expect(found.map((r) => r.id)).toEqual(['roma'])
  })
})

describe('GooglePlacesRestaurantSearch', () => {
  it('sends a Text Search request with the API key and field mask', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const search = new GooglePlacesRestaurantSearch('test-key', async (url, init) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({
          places: [
            {
              id: 'p1',
              displayName: { text: 'Bella\u0007Cucina' },
              formattedAddress: '1 Main St',
              nationalPhoneNumber: '(615) 555-0101',
              rating: 4.7,
              priceLevel: 'PRICE_LEVEL_MODERATE',
              primaryType: 'italian_restaurant',
            },
            { id: 'p2' },
          ],
        }),
        { status: 200 },
      )
    })
    const found = await search.search({ query: 'italian in Nashville', limit: 3 })
    expect(calls[0]?.url).toBe(PLACES_URL)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['X-Goog-Api-Key']).toBe('test-key')
    expect(headers['X-Goog-FieldMask']).toBe(PLACES_FIELD_MASK)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      textQuery: 'italian in Nashville',
      pageSize: 3,
    })
    expect(found).toEqual([
      {
        id: 'p1',
        name: 'Bella Cucina',
        address: '1 Main St',
        phone: '(615) 555-0101',
        rating: 4.7,
        priceLevel: 'PRICE_LEVEL_MODERATE',
        cuisine: 'italian_restaurant',
      },
    ])
  })

  it('surfaces the API error status instead of returning an empty list', async () => {
    const search = new GooglePlacesRestaurantSearch(
      'k',
      async () =>
        new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 }),
    )
    await expect(search.search({ query: 'x' })).rejects.toThrow('PLACES_PERMISSION_DENIED')
  })
})
