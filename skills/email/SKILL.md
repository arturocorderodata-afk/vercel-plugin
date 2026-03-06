---
name: email
description: Email sending integration guidance — Resend (native Vercel Marketplace) with React Email templates. Covers API setup, transactional emails, domain verification, and template patterns. Use when sending emails from a Vercel-deployed application.
metadata:
  priority: 4
  pathPatterns:
    - 'emails/**'
    - 'src/emails/**'
    - 'components/emails/**'
    - 'src/components/emails/**'
    - 'app/api/send/**'
    - 'src/app/api/send/**'
    - 'app/api/email/**'
    - 'src/app/api/email/**'
    - 'app/api/emails/**'
    - 'src/app/api/emails/**'
    - 'lib/resend.*'
    - 'src/lib/resend.*'
    - 'lib/email.*'
    - 'src/lib/email.*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bresend\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bresend\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bresend\b'
    - '\byarn\s+add\s+[^\n]*\bresend\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*@react-email/'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*@react-email/'
    - '\bbun\s+(install|i|add)\s+[^\n]*@react-email/'
    - '\byarn\s+add\s+[^\n]*@react-email/'
    - '\bnpm\s+(install|i|add)\s+[^\n]*react-email\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*react-email\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*react-email\b'
    - '\byarn\s+add\s+[^\n]*react-email\b'
---

# Email Integration (Resend + React Email)

You are an expert in sending emails from Vercel-deployed applications — covering Resend (native Vercel Marketplace integration), React Email templates, domain verification, and transactional email patterns.

## Vercel Marketplace Setup (Recommended)

Resend is a native Vercel Marketplace integration with auto-provisioned API keys and unified billing.

### Install via Marketplace

```bash
# Install Resend from Vercel Marketplace (auto-provisions env vars)
vercel integration add resend
```

Auto-provisioned environment variables:
- `RESEND_API_KEY` — server-side API key for sending emails

### SDK Setup

```bash
# Install the Resend SDK
npm install resend

# Install React Email for building templates
npm install react-email @react-email/components
```

### Initialize the Client

```ts
// lib/resend.ts
import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY);
```

## Sending Emails

### Basic API Route

```ts
// app/api/send/route.ts
import { NextResponse } from "next/server";
import { resend } from "@/lib/resend";

export async function POST(req: Request) {
  const { to, subject, html } = await req.json();

  const { data, error } = await resend.emails.send({
    from: "Your App <hello@yourdomain.com>",
    to,
    subject,
    html,
  });

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  return NextResponse.json({ id: data?.id });
}
```

### Send with React Email Template

```ts
// app/api/send/route.ts
import { NextResponse } from "next/server";
import { resend } from "@/lib/resend";
import WelcomeEmail from "@/emails/welcome";

export async function POST(req: Request) {
  const { name, email } = await req.json();

  const { data, error } = await resend.emails.send({
    from: "Your App <hello@yourdomain.com>",
    to: email,
    subject: "Welcome!",
    react: WelcomeEmail({ name }),
  });

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  return NextResponse.json({ id: data?.id });
}
```

## React Email Templates

### Template Structure

Organize templates in an `emails/` directory at the project root:

```
emails/
  welcome.tsx
  invoice.tsx
  reset-password.tsx
```

### Example Template

```tsx
// emails/welcome.tsx
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";

interface WelcomeEmailProps {
  name: string;
}

export default function WelcomeEmail({ name }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to our platform</Preview>
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f6f9fc" }}>
        <Container style={{ padding: "40px 20px", maxWidth: "560px" }}>
          <Heading>Welcome, {name}!</Heading>
          <Text>
            Thanks for signing up. Get started by visiting your{" "}
            <Link href="https://yourdomain.com/dashboard">dashboard</Link>.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
```

### Preview Templates Locally

```bash
# Start the React Email dev server to preview templates
npx react-email dev
```

This opens a browser preview at `http://localhost:3000` where you can view and iterate on email templates with hot reload.

## Domain Verification

To send from a custom domain (not `onboarding@resend.dev`), verify your domain in Resend:

1. Go to [Resend Domains](https://resend.com/domains)
2. Add your domain
3. Add the DNS records (MX, SPF, DKIM) to your domain provider
4. Wait for verification (usually under 5 minutes)

Until your domain is verified, use `onboarding@resend.dev` as the `from` address for testing.

## Common Patterns

### Batch Sending

```ts
const { data, error } = await resend.batch.send([
  {
    from: "hello@yourdomain.com",
    to: "user1@example.com",
    subject: "Update",
    html: "<p>Content for user 1</p>",
  },
  {
    from: "hello@yourdomain.com",
    to: "user2@example.com",
    subject: "Update",
    html: "<p>Content for user 2</p>",
  },
]);
```

### Server Action

```ts
"use server";
import { resend } from "@/lib/resend";
import WelcomeEmail from "@/emails/welcome";

export async function sendWelcomeEmail(name: string, email: string) {
  const { error } = await resend.emails.send({
    from: "Your App <hello@yourdomain.com>",
    to: email,
    subject: "Welcome!",
    react: WelcomeEmail({ name }),
  });

  if (error) throw new Error("Failed to send email");
}
```

### Webhook for Delivery Events

```ts
// app/api/webhook/resend/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const event = await req.json();

  switch (event.type) {
    case "email.delivered":
      // Track successful delivery
      break;
    case "email.bounced":
      // Handle bounce — remove from mailing list
      break;
    case "email.complained":
      // Handle spam complaint — unsubscribe user
      break;
  }

  return NextResponse.json({ received: true });
}
```

## Environment Variables

| Variable | Scope | Description |
|----------|-------|-------------|
| `RESEND_API_KEY` | Server | Resend API key (starts with `re_`) |

## Cross-References

- **Marketplace install and env var provisioning** → `⤳ skill: marketplace`
- **API route patterns** → `⤳ skill: routing-middleware`
- **Environment variable management** → `⤳ skill: env-vars`
- **Serverless function config** → `⤳ skill: vercel-functions`

## Official Documentation

- [Resend + Vercel Marketplace](https://vercel.com/marketplace/resend)
- [Resend Documentation](https://resend.com/docs)
- [Resend Next.js Quickstart](https://resend.com/docs/send-with-nextjs)
- [React Email Documentation](https://react.email/docs/introduction)
- [React Email Components](https://react.email/docs/components/html)
