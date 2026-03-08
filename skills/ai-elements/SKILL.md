---
name: ai-elements
description: AI Elements component library guidance — pre-built React components for AI interfaces built on shadcn/ui. Use when building chat UIs, message displays, tool call rendering, streaming responses, reasoning panels, or any AI-native interface with the AI SDK.
metadata:
  priority: 5
  pathPatterns:
    - 'components/ai-elements/**'
    - 'src/components/ai-elements/**'
  bashPatterns:
    - '\bnpx\s+ai-elements\b'
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bai-elements\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bai-elements\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bai-elements\b'
    - '\byarn\s+add\s+[^\n]*\bai-elements\b'
    - '\bnpx\s+shadcn@latest\s+add\s+[^\n]*elements\.ai-sdk\.dev\b'
  promptSignals:
    phrases:
      - "ai elements"
      - "ai components"
      - "chat components"
      - "voice elements"
      - "code elements"
      - "voice agent"
      - "speech input"
      - "transcription component"
      - "code editor component"
    allOf:
      - [message, component]
      - [conversation, component]
    anyOf:
      - "message component"
      - "conversation component"
      - "tool call display"
      - "reasoning display"
      - "voice conversation"
      - "speech to text"
      - "text to speech"
      - "mic selector"
      - "voice selector"
      - "ai code editor"
      - "file tree component"
      - "terminal component"
      - "stack trace component"
      - "test results component"
    noneOf:
      - "vue"
      - "svelte"
    minScore: 6
---

# AI Elements

You are an expert in AI Elements — a component library and custom shadcn/ui registry built on top of shadcn/ui to help you build AI-native applications faster. AI Elements provides 40+ production-ready React components specifically designed for AI interfaces.

## Overview

Unlike regular UI libraries, AI Elements understands AI-specific patterns — message parts, streaming states, tool calls, reasoning displays, and markdown rendering. Components are tightly integrated with AI SDK hooks like `useChat` and handle the unique challenges of streaming AI responses.

The CLI adds components directly to your codebase with full source code access — no hidden dependencies, fully customizable.

## Design Direction for AI Interfaces

AI Elements solves message rendering, not the whole product aesthetic. Surround it with shadcn + Geist discipline. Use Conversation/Message for the stream area, compose the rest with shadcn primitives. Use Geist Sans for conversational UI, Geist Mono for tool args/JSON/code/timestamps. Default to dark mode for AI products. Avoid generic AI styling: purple gradients, glassmorphism everywhere, over-animated status indicators.

## Installation

```bash
# Install all components at once (current: ai-elements@^1.8.0)
npx ai-elements@latest

# Install specific components
npx ai-elements@latest add message
npx ai-elements@latest add conversation
npx ai-elements@latest add code-block

# Or use shadcn CLI directly with the registry URL
npx shadcn@latest add https://elements.ai-sdk.dev/api/registry/all.json
```

Components are installed into `src/components/ai-elements/` by default.

## Key Components

### Conversation + Message (Core)

The most commonly used components for building chat interfaces:

```tsx
'use client'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Conversation } from '@/components/ai-elements/conversation'
import { Message } from '@/components/ai-elements/message'

export function Chat() {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  })

  return (
    <Conversation>
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </Conversation>
  )
}
```

The `Conversation` component wraps messages with auto-scrolling and a scroll-to-bottom button.

The `Message` component renders message parts automatically — text, tool calls, reasoning, images — without manual part-type checking.

### Message Markdown

The `MessageMarkdown` sub-component is optimized for streaming — it efficiently handles incremental markdown updates without re-parsing the entire content on each stream chunk:

```tsx
import { MessageMarkdown } from '@/components/ai-elements/message'

// Inside a custom message renderer
<MessageMarkdown content={part.text} />
```

### Tool Call Display

Renders tool invocations with inputs, outputs, and status indicators:

```tsx
import { Tool } from '@/components/ai-elements/tool'

// Renders tool name, input parameters, output, and loading state
<Tool toolInvocation={toolPart} />
```

### Reasoning / Chain of Thought

Collapsible reasoning display for models that expose thinking:

```tsx
import { Reasoning } from '@/components/ai-elements/reasoning'

<Reasoning content={reasoningText} />
```

### Code Block

Syntax-highlighted code with copy button:

```tsx
import { CodeBlock } from '@/components/ai-elements/code-block'

<CodeBlock language="typescript" code={codeString} />
```

### Prompt Input

Rich input with attachment support, submit button, and keyboard shortcuts:

```tsx
import { PromptInput } from '@/components/ai-elements/prompt-input'

<PromptInput
  onSubmit={(text) => sendMessage({ text })}
  isLoading={status === 'streaming'}
  placeholder="Ask anything..."
/>
```

## Full Component List

| Component | Purpose |
|-----------|---------|
| `conversation` | Message container with auto-scroll |
| `message` | Renders all message part types |
| `code-block` | Syntax-highlighted code with copy |
| `reasoning` | Collapsible thinking/reasoning display |
| `tool` | Tool call display with status |
| `actions` | Response action buttons (copy, regenerate) |
| `agent` | Agent status and step display |
| `artifact` | Rendered artifact preview |
| `attachments` | File attachment display |
| `audio-player` | Audio playback controls |
| `branch` | Message branching UI |
| `canvas` | Drawing/annotation canvas |
| `chain-of-thought` | Step-by-step reasoning |
| `checkpoint` | Workflow checkpoint display |
| `confirmation` | Tool execution approval UI |
| `file-tree` | File structure display |
| `image` | AI-generated image display |
| `inline-citation` | Source citation links |
| `loader` | Streaming/loading indicators |
| `model-selector` | Model picker dropdown |
| `prompt-input` | Rich text input |
| `sandbox` | Code sandbox preview |
| `schema-display` | JSON schema visualization |
| `shimmer` | Loading placeholder animation |
| `sources` | Source/reference list |
| `suggestion` | Suggested follow-up prompts |
| `terminal` | Terminal output display |
| `web-preview` | Web page preview iframe |
| `persona` | Animated AI visual (Rive WebGL2) — idle, listening, thinking, speaking, asleep states |
| `speech-input` | Voice input capture via Web Speech API (Chrome/Edge) with MediaRecorder fallback |
| `transcription` | Audio transcript display with playback sync, segment highlighting, click-to-seek |
| `mic-selector` | Microphone device picker with auto-detection and permission handling |
| `voice-selector` | AI voice picker with searchable list, metadata (gender, accent, age), context provider |
| `agent` | AI SDK ToolLoopAgent config display — model, instructions, tools, schema |
| `commit` | Git commit metadata display — hash, message, author, timestamp, files |
| `environment-variables` | Env var display with masking, visibility toggle, copy |
| `package-info` | Package dependency display with version changes and badges |
| `snippet` | Lightweight terminal command / code snippet with copy |
| `stack-trace` | JS/Node.js error formatting with clickable paths, collapsible frames |
| `test-results` | Test suite results with statistics and error details |

## AI Voice Elements (January 2026)

Six components for building voice agents, transcription apps, and speech-powered interfaces. Integrates with AI SDK's Transcription and Speech functions.

```bash
# Install all voice components
npx ai-elements@latest add persona speech-input transcription audio-player mic-selector voice-selector
```

### Persona — Animated AI Visual

Rive WebGL2 animation that responds to conversation states (idle, listening, thinking, speaking, asleep). Multiple visual variants available.

```tsx
import { Persona } from '@/components/ai-elements/persona'

<Persona state="listening" variant="orb" />
```

### SpeechInput — Voice Capture

Uses Web Speech API on Chrome/Edge, falls back to MediaRecorder on Firefox/Safari.

```tsx
import { SpeechInput } from '@/components/ai-elements/speech-input'

<SpeechInput onTranscript={(text) => sendMessage({ text })} />
```

### Transcription — Synchronized Transcript Display

Highlights the current segment based on playback time with click-to-seek navigation.

```tsx
import { Transcription } from '@/components/ai-elements/transcription'

<Transcription segments={segments} currentTime={playbackTime} onSeek={setTime} />
```

### AudioPlayer, MicSelector, VoiceSelector

```tsx
import { AudioPlayer } from '@/components/ai-elements/audio-player'   // media-chrome based, composable controls
import { MicSelector } from '@/components/ai-elements/mic-selector'     // device picker with auto-detection
import { VoiceSelector } from '@/components/ai-elements/voice-selector' // searchable voice list with metadata
```

## AI Code Elements (January 2026)

Thirteen components for building IDEs, coding apps, and background agents. Designed for developer tooling with streaming indicators, status tracking, and syntax highlighting.

```bash
# Install code element components
npx ai-elements@latest add agent code-block commit environment-variables file-tree package-info sandbox schema-display snippet stack-trace terminal test-results attachments
```

### Key Code Components

```tsx
import { Terminal } from '@/components/ai-elements/terminal'          // ANSI color support, auto-scroll
import { FileTree } from '@/components/ai-elements/file-tree'         // expandable folder hierarchy
import { StackTrace } from '@/components/ai-elements/stack-trace'     // clickable paths, collapsible frames
import { TestResults } from '@/components/ai-elements/test-results'   // suite stats + error details
import { Sandbox } from '@/components/ai-elements/sandbox'            // code + execution output, tabbed view
import { Snippet } from '@/components/ai-elements/snippet'            // lightweight terminal commands with copy
import { Commit } from '@/components/ai-elements/commit'              // git commit metadata display
import { EnvironmentVariables } from '@/components/ai-elements/environment-variables' // masked env vars
import { PackageInfo } from '@/components/ai-elements/package-info'   // dependency versions + badges
import { SchemaDisplay } from '@/components/ai-elements/schema-display' // REST API visualization
```

## Integration with AI SDK v6

AI Elements components understand the AI SDK v6 `UIMessage` format and render `message.parts` automatically:

```tsx
// The Message component handles all part types:
// - type: "text" → renders as markdown
// - type: "tool-*" → renders tool call UI with status
// - type: "reasoning" → renders collapsible reasoning
// - type: "image" → renders image
// No manual part.type checking needed!

{messages.map((message) => (
  <Message key={message.id} message={message} />
))}
```

### Server-side Pattern

```ts
// app/api/chat/route.ts
import { streamText, convertToModelMessages, gateway } from 'ai'

export async function POST(req: Request) {
  const { messages } = await req.json()
  const modelMessages = await convertToModelMessages(messages)

  const result = streamText({
    model: gateway('anthropic/claude-sonnet-4.6'),
    messages: modelMessages,
  })

  return result.toUIMessageStreamResponse()
}
```

**Key v6 patterns:**
- Use `convertToModelMessages()` (async) to convert UI messages to model messages
- Use `toUIMessageStreamResponse()` (not `toDataStreamResponse()`) for chat UIs
- Use `DefaultChatTransport` in the client `useChat` hook

## Custom Rendering

You can customize any component after installation since you own the source code:

```tsx
// Customize the Message component for your app
import { Message as BaseMessage } from '@/components/ai-elements/message'

function CustomMessage({ message }) {
  // Add custom tool result rendering
  return (
    <BaseMessage
      message={message}
      renderTool={(toolPart) => <MyCustomToolCard tool={toolPart} />}
    />
  )
}
```

## When to Use AI Elements

| Scenario | Use AI Elements? |
|----------|-----------------|
| Building a chat interface with AI SDK | Yes — handles streaming, parts, markdown |
| Displaying tool call results | Yes — built-in tool status UI |
| Rendering AI reasoning/thinking | Yes — collapsible reasoning component |
| Simple text completion display | Optional — may be overkill |
| Non-React framework (Vue, Svelte) | No — React only (use AI SDK hooks directly) |
| Custom design system, no shadcn | Maybe — install and customize the source |

## Common Gotchas

1. **AI Elements requires shadcn/ui** — run `npx shadcn@latest init` first if not already set up
2. **Some components have peer dependencies** — the CLI installs them automatically, but check for missing UI primitives if you see import errors
3. **Components are installed as source** — you can and should customize them for your app's design
4. **Use `toUIMessageStreamResponse()`** on the server, not `toDataStreamResponse()` — AI Elements expects the UI message stream format

## Official Documentation

- [AI Elements](https://ai-sdk.dev/elements)
- [Component Reference](https://ai-sdk.dev/elements/components)
- [GitHub: AI Elements](https://github.com/vercel/ai-elements)
- [shadcn/ui Registry](https://ui.shadcn.com/docs/directory)
