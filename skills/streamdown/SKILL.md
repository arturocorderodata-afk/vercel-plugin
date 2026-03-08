---
name: streamdown
description: Streamdown streaming-markdown expert guidance. Use when rendering streaming Markdown from AI models, building chat UIs with real-time content, or replacing react-markdown with a streaming-aware component.
metadata:
  priority: 4
  pathPatterns:
    - 'components/**/streamdown*'
    - 'src/components/**/streamdown*'
  importPatterns:
    - 'streamdown'
    - 'streamdown/*'
    - '@streamdown/*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bstreamdown\b'
    - '\byarn\s+add\s+[^\n]*\bstreamdown\b'
  promptSignals:
    phrases:
      - "streaming markdown"
      - "streamdown"
      - "markdown formatting"
    allOf:
      - [markdown, stream]
      - [markdown, render]
    anyOf:
      - "terminal"
      - "chat ui"
      - "react-markdown"
    noneOf:
      - "readme"
      - "markdown file"
      - "changelog"
    minScore: 6
---

# Streamdown — Streaming Markdown for AI

You are an expert in Streamdown (v2), Vercel's drop-in replacement for react-markdown designed for AI streaming. Streamdown gracefully handles incomplete or unterminated Markdown in real-time, providing smooth rendering during AI model output.

## Installation

```bash
npm install streamdown@^2.1.0
```

**Tailwind v4** — add to your CSS:
```css
@source "../node_modules/streamdown/dist/*.js";
```

**Tailwind v3** — add to `content` array:
```js
content: ["./node_modules/streamdown/dist/*.js"]
```

## Core Usage

```tsx
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

function ChatMessage({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  return (
    <Streamdown isAnimating={isStreaming}>
      {content}
    </Streamdown>
  )
}
```

## Plugins

Streamdown uses a plugin architecture for extended functionality:

```tsx
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'       // Syntax highlighting (Shiki)
import { math } from '@streamdown/math'       // KaTeX equations
import { mermaid } from '@streamdown/mermaid' // Mermaid diagrams
import { cjk } from '@streamdown/cjk'         // CJK language support

<Streamdown
  plugins={{
    code: code,
    math: math,
    mermaid: mermaid,
    cjk: cjk,
  }}
>
  {markdown}
</Streamdown>
```

### Plugin packages

| Package | Version | Purpose |
|---|---|---|
| `@streamdown/code` | `^1.1.0` | Syntax highlighting via Shiki |
| `@streamdown/math` | `^1.0.2` | Math equations via KaTeX |
| `@streamdown/mermaid` | `^1.0.2` | Mermaid diagram rendering |
| `@streamdown/cjk` | `^1.0.2` | CJK language support |

### Code Plugin — `createCodePlugin`

Use `createCodePlugin` for advanced code block configuration:

```tsx
import { createCodePlugin } from '@streamdown/code'

const codePlugin = createCodePlugin({
  themes: { light: 'github-light', dark: 'github-dark' },
  inlineCode: ({ children }) => <code className="bg-muted px-1 rounded">{children}</code>,
})

<Streamdown plugins={{ code: codePlugin }}>
  {markdown}
</Streamdown>
```

- **`themes`** — light/dark Shiki theme pair
- **`startLine`** — set via code fence meta (e.g., ` ```ts startLine=10 `) for custom starting line numbers
- **`inlineCode`** — virtual component to style inline code independently from blocks

### Custom Language Renderers

Use `plugins.renderers` to provide custom components for specific code fence languages:

```tsx
<Streamdown
  plugins={{
    code: code,
    renderers: {
      mermaid: ({ children }) => <MermaidDiagram code={children} />,
      html: ({ children }) => <HtmlPreview code={children} />,
    },
  }}
>
  {markdown}
</Streamdown>
```

## Controls

Enable interactive controls for code blocks, tables, and diagrams:

```tsx
<Streamdown
  controls={{
    table: true,    // fullscreen overlay with scroll locking + Escape key
    code: true,
    mermaid: {
      download: true,
      copy: true,
      fullscreen: true,
      panZoom: true,
    },
  }}
>
  {markdown}
</Streamdown>
```

## Props Reference

| Prop | Type | Description |
|---|---|---|
| `children` | `string` | Markdown content to render |
| `isAnimating` | `boolean` | Show streaming cursor/animation |
| `plugins` | `object` | Plugin configuration |
| `controls` | `object` | Interactive controls (table fullscreen, code copy, mermaid pan/zoom) |
| `icons` | `object` | Override built-in icon components |
| `dir` | `'ltr' \| 'rtl' \| 'auto'` | Text direction — `'auto'` detects from Unicode characters |
| `translations` | `object` | Custom language strings for i18n |
| `prefix` | `string` | Namespace Tailwind v4 utility classes to avoid collisions |
| `literalTagContent` | `boolean` | Escape markdown inside custom HTML tags (treat as literal) |
| `normalizeHtmlIndentation` | `boolean` | Prevent indented HTML from being parsed as code blocks |
| `onAnimationStart` | `() => void` | Callback when streaming animation begins |
| `onAnimationEnd` | `() => void` | Callback when streaming animation completes |
| `className` | `string` | Additional CSS class |

## Integration with AI SDK v6

```tsx
'use client'
import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import 'streamdown/styles.css'

export function Chat() {
  const { messages, sendMessage, status } = useChat()

  return (
    <div>
      {messages.map((m) => {
        // Extract text from v6 UIMessage parts
        const text = m.parts
          ?.filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('') ?? ''
        return (
          <div key={m.id}>
            <strong>{m.role}:</strong>
            <Streamdown
              isAnimating={status === 'streaming' && m.id === messages[messages.length - 1]?.id}
              plugins={{ code: code }}
            >
              {text}
            </Streamdown>
          </div>
        )
      })}
    </div>
  )
}
```

## Streaming Hooks

Streamdown v2 provides hooks for detecting streaming state:

```tsx
import { useIsCodeFenceIncomplete } from 'streamdown'

// Detects in-progress fenced code blocks during streaming
const isCodeIncomplete = useIsCodeFenceIncomplete(content)
```

## Key Rules

- **Requires React 18+** and **Tailwind CSS** for styling
- **Import styles** — always import `streamdown/styles.css` for animations
- **Use `isAnimating`** to show/hide the streaming cursor indicator (built-in caret)
- **Plugins are tree-shakeable** — only import what you need
- **Security-first** — uses rehype-harden internally for safe HTML rendering
- **GFM support** — tables, task lists, strikethrough work out of the box
- **RTL support** — use `dir="auto"` for automatic direction detection
- **i18n** — pass `translations` prop for localized UI strings
- **Animation hooks** — `onAnimationStart`/`onAnimationEnd` for coordinating UI with streaming state
- **Remend** — Streamdown's incomplete-markdown recovery engine is also available as standalone `npm install remend`
