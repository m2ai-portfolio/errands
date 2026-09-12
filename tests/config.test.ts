import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const dir = mkdtempSync(join(tmpdir(), 'errands-config-'))
const policyPath = join(dir, 'policy.json')
const demoPath = join(dir, 'demo.json')
writeFileSync(
  policyPath,
  JSON.stringify({
    enabled: true,
    perTransactionCapCents: 2000,
    dailyCapCents: 2500,
    weeklyCapCents: 4000,
    approvalTtlMinutes: 30,
    categories: { call: 'allow', restaurant_deposit: 'confirm' },
  }),
)
writeFileSync(
  demoPath,
  JSON.stringify({
    outboundPhoneNumberId: 'pn-out',
    lines: [
      { role: 'open', phoneNumberId: 'pn-open', number: '+15025550101' },
      { role: 'full', phoneNumberId: 'pn-full', number: '+15025550100' },
    ],
  }),
)
const paths = { policy: policyPath, demo: demoPath }

describe('loadConfig', () => {
  it('defaults to demo mode and orders demo lines full first, then open', () => {
    const config = loadConfig({ VAPI_API_KEY: 'k' }, paths)
    expect(config.mode).toBe('demo')
    expect(config.demoLines).toEqual(['+15025550100', '+15025550101'])
    expect(config.outboundPhoneNumberId).toBe('pn-out')
  })

  it('falls back to fixture search without a Google key', () => {
    expect(loadConfig({ VAPI_API_KEY: 'k' }, paths).searchSource).toBe('fixture')
    expect(loadConfig({ VAPI_API_KEY: 'k', GOOGLE_API_KEY: 'g' }, paths).searchSource).toBe(
      'google-places',
    )
    expect(
      loadConfig({ VAPI_API_KEY: 'k', GOOGLE_API_KEY: 'g', ERRANDS_SEARCH: 'fixture' }, paths)
        .searchSource,
    ).toBe('fixture')
  })

  it('reads the Bedrock region and model from the environment', () => {
    const config = loadConfig(
      { VAPI_API_KEY: 'k', AWS_REGION: 'us-west-2', BEDROCK_MODEL_ID: 'm' },
      paths,
    )
    expect(config.bedrock).toEqual({ region: 'us-west-2', modelId: 'm' })
  })

  it('parses the live allowlist', () => {
    const config = loadConfig(
      { VAPI_API_KEY: 'k', ERRANDS_MODE: 'live', ERRANDS_LIVE_ALLOWLIST: '+16155550100, +1615' },
      paths,
    )
    expect(config.mode).toBe('live')
    expect(config.liveAllowlist).toEqual(['+16155550100', '+1615'])
  })

  it('refuses to start without a Vapi key or with an invalid policy', () => {
    expect(() => loadConfig({}, paths)).toThrow('CONFIG_MISSING_VAPI_API_KEY')
    const bad = join(dir, 'bad-policy.json')
    writeFileSync(bad, JSON.stringify({ enabled: 'yes' }))
    expect(() => loadConfig({ VAPI_API_KEY: 'k' }, { ...paths, policy: bad })).toThrow()
  })
})
