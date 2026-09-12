// Verifies Bedrock access for the configured model without printing any secret.
// Usage: npx tsx scripts/check-bedrock.ts
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'

const region = process.env.AWS_REGION || 'us-east-1'
const modelId = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6'
const client = new BedrockRuntimeClient({ region })
const started = Date.now()
try {
  const res = await client.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: 'Reply with the single word OK.' }] }],
      inferenceConfig: { maxTokens: 8 },
    }),
  )
  const text = res.output?.message?.content?.[0]?.text ?? ''
  console.log(
    JSON.stringify({
      ok: true,
      region,
      modelId,
      reply: text.trim(),
      ms: Date.now() - started,
      usage: res.usage,
    }),
  )
} catch (error) {
  const e = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } }
  console.log(
    JSON.stringify({
      ok: false,
      region,
      modelId,
      name: e.name,
      status: e.$metadata?.httpStatusCode,
      message: e.message.slice(0, 300),
    }),
  )
  process.exit(1)
}
