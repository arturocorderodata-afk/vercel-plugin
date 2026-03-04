---
name: vercel-queues
description: Vercel Queues guidance — durable event streaming with topics, consumer groups, retries, and delayed delivery. Powers Workflow DevKit. Use when building async processing, fan-out patterns, or event-driven architectures.
---

# Vercel Queues

You are an expert in Vercel Queues — durable event streaming for serverless applications.

## What It Is

Queues is a **durable, append-only event streaming system**. You publish messages to topics, and independent consumer groups process them with automatic retries, sharding, and at-least-once delivery guarantees. It is the lower-level primitive that **powers Vercel Workflow**.

- Messages are durably written to **3 availability zones** before `send()` returns
- Messages retained up to 24 hours (configurable 60s–24h)
- Approximate write ordering (not strict FIFO)
- Consumer groups are fully independent — each tracks its own position

## Key APIs

Package: `@vercel/queue` (Node.js 22+)

### Publishing Messages

```ts
import { send } from '@vercel/queue';

const { messageId } = await send('order-events', {
  orderId: '123',
  action: 'created',
}, {
  delaySeconds: 30,              // delay before visible
  idempotencyKey: 'order-123',   // deduplication (full retention window)
  retentionSeconds: 3600,        // message TTL (default: 86400 = 24h)
  headers: { 'x-trace-id': 'abc' },
});
```

### Push-Mode Consumer (Next.js App Router)

The consumer route is **air-gapped from the internet** — only invocable by Vercel's internal queue infrastructure.

```ts
// app/api/queues/fulfill-order/route.ts
import { handleCallback } from '@vercel/queue';

export const POST = handleCallback(
  async (message, metadata) => {
    // metadata: { messageId, deliveryCount, createdAt, expiresAt, topicName, consumerGroup, region }
    await processOrder(message);
    // Return normally = acknowledge
    // Throw = retry with backoff
  },
  {
    visibilityTimeoutSeconds: 600, // lease duration (default 300s, auto-extended by SDK)
    retry: (error, metadata) => {
      if (metadata.deliveryCount > 5) return { acknowledge: true }; // give up
      const delay = Math.min(300, 2 ** metadata.deliveryCount * 5);
      return { afterSeconds: delay };
    },
  },
);
```

### Consumer Configuration (vercel.json)

```json
{
  "functions": {
    "app/api/queues/fulfill-order/route.ts": {
      "experimentalTriggers": [{
        "type": "queue/v2beta",
        "topic": "order-events",
        "retryAfterSeconds": 60,
        "initialDelaySeconds": 0
      }]
    }
  }
}
```

Multiple route files with the same topic create **separate consumer groups** (independent processing).

### Poll-Mode Consumer

```ts
import { PollingQueueClient } from '@vercel/queue';

const { receive } = new PollingQueueClient({ region: 'iad1' });

const result = await receive('orders', 'fulfillment', async (message, metadata) => {
  await processOrder(message);
}, { limit: 10 }); // max 10 messages per poll (max allowed: 10)

if (!result.ok && result.reason === 'empty') {
  // No messages available
}
```

### Custom Region Client

```ts
import { QueueClient } from '@vercel/queue';

const queue = new QueueClient({ region: 'sfo1' });
export const { send, handleCallback } = queue;
```

## Transports

```ts
import { QueueClient, BufferTransport, StreamTransport } from '@vercel/queue';
```

| Transport | Description |
|-----------|-------------|
| `JsonTransport` | Default; JSON serialization |
| `BufferTransport` | Raw binary data |
| `StreamTransport` | `ReadableStream` for large payloads |

## Queues vs Workflow vs Cron

| Need | Use | Why |
|------|-----|-----|
| Event delivery, fan-out, routing control | **Queues** | Topics, consumer groups, message-level retries |
| Stateful multi-step business logic | **Workflow** | Deterministic replay, pause/resume (built **on top of** Queues) |
| Recurring scheduled tasks | **Cron Jobs** | Simple, no message passing |
| Delayed single execution with deduplication | **Queues** (`delaySeconds` + `idempotencyKey`) | Precise delay with guaranteed delivery |
| Async processing from external systems | **Queues** (poll mode) | Consume from any infrastructure, not just Vercel |

## Key Limits

| Resource | Default / Max |
|----------|---------------|
| Message retention | 60s – 24h (default 24h) |
| Max message size | 100 MB |
| Messages per receive | 1–10 (default 1) |
| Visibility timeout | 0s – 60 min (default 5 min SDK / 60s API) |
| Topics per project | Unlimited |
| Consumer groups per topic | Unlimited |

## Deployment Behavior

Topics are **partitioned by deployment ID** by default in push mode. Messages are delivered back to the same deployment that published them — natural schema versioning with no cross-version compatibility concerns.

## When to Use

- Defer expensive work (emails, PDFs, external API calls)
- Absorb traffic spikes with controlled processing rate
- Guarantee delivery even if function crashes
- Fan-out same events to multiple independent pipelines
- Deduplicate messages via idempotency keys

## When NOT to Use

- Multi-step orchestration with state → use Workflow
- Recurring schedules → use Cron Jobs
- Synchronous request/response → use Functions directly
- Cross-region messaging → messages sent to one region cannot be consumed from another

## References

- 📖 docs: https://vercel.com/docs/queues
- 📖 quickstart: https://vercel.com/docs/queues/quickstart
- 📖 API reference: https://vercel.com/docs/queues/api-reference
