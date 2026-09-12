import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Policy } from './gate.js'

// All runtime configuration in one place. Secrets come from the environment;
// the spending policy is a checked-in file so anyone can read the rules the
// agent is held to; demo phone lines live outside the repo.

const PolicySchema = z.object({
  enabled: z.boolean(),
  perTransactionCapCents: z.number().int().nonnegative(),
  dailyCapCents: z.number().int().nonnegative(),
  weeklyCapCents: z.number().int().nonnegative(),
  approvalTtlMinutes: z.number().int().positive(),
  categories: z.record(z.string(), z.enum(['allow', 'confirm', 'forbid'])),
})

const DemoSchema = z.object({
  outboundPhoneNumberId: z.string().min(1),
  lines: z
    .array(
      z.object({
        role: z.enum(['full', 'open']),
        phoneNumberId: z.string().min(1),
        number: z.string().regex(/^\+[1-9]\d{7,14}$/),
      }),
    )
    .min(1),
})

export interface ErrandsConfig {
  mode: 'demo' | 'live'
  policy: Policy
  outboundPhoneNumberId: string
  demoLines: string[]
  liveAllowlist: string[]
  vapiApiKey: string
  googleApiKey: string | null
  searchSource: 'google-places' | 'fixture'
  customerName: string
  bedrock: { region: string; modelId: string }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export interface ConfigPaths {
  policy: string
  demo: string
}

export const defaultPaths = (env: NodeJS.ProcessEnv): ConfigPaths => ({
  policy: env.ERRANDS_POLICY ?? join(repoRoot, 'policy.json'),
  demo: env.ERRANDS_DEMO_CONFIG ?? join(homedir(), '.config', 'errands', 'demo.json'),
})

const readJson = (path: string, label: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`CONFIG_${label}_UNREADABLE: ${path} (${(error as Error).message})`)
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  paths: ConfigPaths = defaultPaths(env),
): ErrandsConfig {
  const mode = env.ERRANDS_MODE === 'live' ? 'live' : 'demo'
  const vapiApiKey = env.VAPI_API_KEY ?? ''
  if (!vapiApiKey) throw new Error('CONFIG_MISSING_VAPI_API_KEY')

  const policy = PolicySchema.parse(readJson(paths.policy, 'POLICY'))
  const demo = DemoSchema.parse(readJson(paths.demo, 'DEMO'))
  const order = { full: 0, open: 1 } as const
  const demoLines = [...demo.lines]
    .sort((a, b) => order[a.role] - order[b.role])
    .map((l) => l.number)

  const googleApiKey = env.GOOGLE_API_KEY || null
  const searchSource =
    env.ERRANDS_SEARCH === 'fixture' || !googleApiKey ? 'fixture' : 'google-places'

  return {
    mode,
    policy,
    outboundPhoneNumberId: demo.outboundPhoneNumberId,
    demoLines,
    liveAllowlist: (env.ERRANDS_LIVE_ALLOWLIST ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean),
    vapiApiKey,
    googleApiKey,
    searchSource,
    customerName: env.ERRANDS_CUSTOMER_NAME || 'Alex',
    bedrock: {
      region: env.AWS_REGION || 'us-east-1',
      modelId: env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
    },
  }
}
