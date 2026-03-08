---
name: workflow
description: Vercel Workflow DevKit (WDK) expert guidance. Use when building durable workflows, long-running tasks, AI agents that must survive crashes, or any async process that needs pause/resume, retries, and observability.
metadata:
  priority: 6
  pathPatterns:
    - 'lib/workflow/**'
    - 'src/lib/workflow/**'
    - 'workflows/**'
    - 'lib/workflow.*'
    - 'workflow.*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*@vercel/workflow\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@vercel/workflow\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*@vercel/workflow\b'
    - '\byarn\s+add\s+[^\n]*@vercel/workflow\b'
---

# Vercel Workflow DevKit (WDK)

You are an expert in the Vercel Workflow DevKit. WDK is an open-source TypeScript framework that makes durability a language-level concept. Functions can pause for minutes or months, survive deployments and crashes, and resume exactly where they stopped.

## Status

WDK is in **public beta** (since October 2025) and open source. GA is anticipated but not yet announced. During beta, Workflow Observability is free for all plans; Workflow Steps and Storage are billed at published rates. Server-side performance is now 2x faster (54% median improvement — median API response time reduced from 37ms to 17ms).

**Security**: Upgrade to `workflow@>=4.2.0-beta.64` — versions ≤4.1.0-beta.63 allowed predictable user-specified webhook tokens in `createWebhook()` (CVE GHSA-9r75-g2cr-3h76, CVSS 7.5). The fix removes the `token` option so tokens are always randomly generated. Run `npx workflow@latest` to update (current: 4.2.0-beta.67).

## Framework Support

WDK works with **8 frameworks** and more are in development:

| Framework | Status |
|-----------|--------|
| Next.js | Supported |
| Nitro | Supported |
| SvelteKit | Supported |
| Astro | Supported |
| Express | Supported |
| Hono | Supported |
| TanStack Start | In development |
| React Router | In development |

## Installation

```bash
# Main package (includes core runtime)
npm install workflow@latest
# For AI agent durability:
npm install @workflow/ai@latest
# For self-hosted Postgres worlds:
npm install @workflow/world-postgres
```

> **Tip**: Run `npx workflow@latest` to scaffold or update your project. All packages are currently in beta.

## Core Concepts

### Directives

WDK introduces two directives that turn ordinary async functions into durable workflows:

```ts
'use workflow'  // Marks a function as a durable workflow
'use step'      // Marks a block as an individually retryable, observable step
```

### How It Works

1. Each `'use step'` block compiles into an isolated API Route
2. Inputs and outputs are recorded for deterministic replay
3. If a deploy or crash occurs, the system replays execution from the last completed step
4. While a step executes, the workflow is suspended (zero resource consumption)
5. When the step completes, the workflow resumes automatically

### Basic Workflow

```ts
'use workflow'

export async function processOrder(orderId: string) {
  'use step'
  const order = await db.getOrder(orderId)

  'use step'
  const payment = await processPayment(order)

  'use step'
  await sendConfirmation(order, payment)

  'use step'
  await updateInventory(order)

  return { success: true, orderId }
}
```

Each step is:
- **Retryable**: Automatically retried on transient failures
- **Observable**: Step-level visibility at `https://vercel.com/{team}/{project}/logs` → filter by workflow function
- **Durable**: State persisted between steps
- **Isolated**: Runs as its own API route

## Worlds (Execution Environments)

A "World" is where workflow state gets stored. WDK is portable across environments:

### Local World (Development)
```ts
// State stored as JSON files on disk
// Automatic in local development
```

### Vercel World (Production)
```ts
// Fully managed: scalable storage, distributed queuing
// Zero configuration when deployed to Vercel
// Automatic authentication
```

### Self-Hosted
```ts
// Use Postgres, Redis, or build your own World
// Full control over state storage
import { createPostgresWorld } from '@workflow/world-postgres'

const world = createPostgresWorld({
  connectionString: process.env.DATABASE_URL,
})
```

## DurableAgent (AI SDK Integration)

The killer feature: wrap AI SDK agents with durability.

```ts
import { DurableAgent } from '@workflow/ai/agent'
import { openai } from '@ai-sdk/openai'

const agent = new DurableAgent({
  model: openai('gpt-5.4'),
  tools: {
    searchWeb: { /* ... */ },
    writeFile: { /* ... */ },
    sendEmail: { /* ... */ },
  },
  system: 'You are a research assistant.',
})

// Every LLM call and tool execution becomes a retryable step
'use workflow'
export async function researchTask(topic: string) {
  const result = await agent.generateText({
    prompt: `Research ${topic} and write a comprehensive report.`,
  })
  return result.text
}
```

With `DurableAgent`:
- Every LLM call is a step (retried on failure)
- Every tool execution is a step (individually observable)
- The entire agent loop survives crashes and deployments
- Results are aggregated within the workflow context
- Streaming works out of the box

## Patterns

### Long-Running Workflow with Pauses

```ts
'use workflow'

export async function onboardUser(userId: string) {
  'use step'
  await sendWelcomeEmail(userId)

  'use step'
  // Wait for user to verify email (could be hours/days)
  await waitForEvent(`email-verified:${userId}`)

  'use step'
  await setupDefaultWorkspace(userId)

  'use step'
  await sendOnboardingGuide(userId)
}
```

### Workflow with Error Handling

```ts
'use workflow'

export async function processRefund(orderId: string) {
  'use step'
  const order = await getOrder(orderId)

  'use step'
  try {
    await issueRefund(order)
  } catch (error) {
    // Step will be retried automatically on transient errors
    // For permanent failures, the error is recorded
    throw error
  }

  'use step'
  await notifyCustomer(order, 'refund_processed')
}
```

### Fan-Out / Parallel Steps

```ts
'use workflow'

export async function processImages(imageIds: string[]) {
  'use step'
  const images = await getImages(imageIds)

  // Process in parallel — each is its own step
  const results = await Promise.all(
    images.map(async (img) => {
      'use step'
      return await resizeImage(img)
    })
  )

  'use step'
  await saveResults(results)
}
```

## Integration with Next.js

Workflows are exposed as API routes in Next.js:

```ts
// app/api/workflows/process-order/route.ts
import { processOrder } from '@/workflows/process-order'

export async function POST(req: Request) {
  const { orderId } = await req.json()
  const result = await processOrder(orderId)
  return Response.json(result)
}
```

## Key Properties

- **Open source**: No vendor lock-in
- **TypeScript-native**: async/await, no YAML or state machines
- **Observable**: Step-level visibility, timing, inputs/outputs
- **Retryable**: Automatic retry with configurable backoff
- **Portable**: Local, Vercel, or self-hosted
- **AI-first**: DurableAgent wraps AI SDK seamlessly

## When to Use WDK vs. Regular Functions

| Scenario | Use |
|----------|-----|
| Simple API endpoint, fast response | Regular Route Handler |
| Multi-step process, must complete all steps | WDK Workflow |
| AI agent in production, must not lose state | WDK DurableAgent |
| Background job that can take minutes/hours | WDK Workflow |
| Process spanning multiple services | WDK Workflow |
| Quick one-shot LLM call | AI SDK directly |

## Workflow Builder (Visual Automation)

Vercel open-sourced **Workflow Builder** — a complete visual automation platform powered by WDK. It includes a visual drag-and-drop editor, AI-powered text-to-workflow generation, execution engine, and integrations (Resend, Linear, Slack, PostgreSQL, webhooks).

Every visual workflow compiles into executable TypeScript via WDK. Deploy it to Vercel with one click (auto-provisions Neon Postgres).

- [Workflow Builder Template](https://vercel.com/templates/next.js/workflow-builder)
- [Workflow Builder Starter](https://github.com/vercel/workflow-builder-starter)
- [Blog post](https://vercel.com/blog/workflow-builder-build-your-own-workflow-automation-platform)

## Official Documentation

- [Workflow DevKit](https://vercel.com/docs/workflow)
- [Workflow DevKit Website](https://useworkflow.dev)
- [Vercel Functions](https://vercel.com/docs/functions) — Workflows compile to Vercel Functions
- [AI SDK Agents](https://ai-sdk.dev/docs/ai-sdk-core/agents) — DurableAgent wraps AI SDK Agent
- [GitHub: Workflow DevKit](https://github.com/vercel/workflow)
