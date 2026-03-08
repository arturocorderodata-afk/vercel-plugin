---
name: geist
description: Expert guidance for Geist — Vercel's font family for Next.js applications. Use when configuring Geist Sans or Geist Mono fonts via next/font, customizing typography, or setting up the Geist design system typeface.
metadata:
  priority: 4
  pathPatterns: []
  importPatterns:
    - 'geist'
    - 'geist/font'
    - 'geist/font/*'
  bashPatterns:
    - '\bnpm\s+(install|i|add)\s+[^\n]*\bgeist\b'
    - '\bpnpm\s+(install|i|add)\s+[^\n]*\bgeist\b'
    - '\bbun\s+(install|i|add)\s+[^\n]*\bgeist\b'
    - '\byarn\s+add\s+[^\n]*\bgeist\b'
---

# Geist — Vercel's Font Family

You are an expert in Geist (v1.7.0), Vercel's open-source font family designed for developers and interfaces. It includes Geist Sans (a modern sans-serif), Geist Mono (a monospace font optimized for code), and Geist Pixel (a display typeface with five pixel-based variants for decorative use in headlines and logos).

## Installation

```bash
npm install geist
```

## Usage with Next.js (next/font)

### App Router

```tsx
// app/layout.tsx
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className={GeistSans.className}>
        {children}
      </body>
    </html>
  )
}
```

### With Tailwind CSS

```tsx
// app/layout.tsx
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
```

```ts
// tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-geist-sans)'],
        mono: ['var(--font-geist-mono)'],
      },
    },
  },
}
export default config
```

Then use in components:

```tsx
<p className="font-sans">Geist Sans text</p>
<code className="font-mono">Geist Mono code</code>
```

### CSS Variables

Geist fonts expose CSS custom properties:

| Variable | Font |
|---|---|
| `--font-geist-sans` | Geist Sans |
| `--font-geist-mono` | Geist Mono |

Use them in CSS:

```css
body {
  font-family: var(--font-geist-sans);
}

code, pre {
  font-family: var(--font-geist-mono);
}
```

## Font Weights

Both Geist Sans and Geist Mono support these weights:

| Weight | Value |
|---|---|
| Thin | 100 |
| Extra Light | 200 |
| Light | 300 |
| Regular | 400 |
| Medium | 500 |
| Semi Bold | 600 |
| Bold | 700 |
| Extra Bold | 800 |
| Black | 900 |

## Subset Configuration

Optimize font loading by specifying subsets:

```tsx
import { GeistSans } from 'geist/font/sans'

// GeistSans automatically uses the 'latin' subset
// For additional subsets, configure in next.config.js
```

## Geist Pixel (Feb 6, 2026)

Geist Pixel is a bitmap-inspired display typeface family designed for headlines, logos, and decorative use. It ships five variants, each built on a different geometric primitive:

| Variant | Description |
|---|---|
| Geist Pixel Square | Square-based pixel grid |
| Geist Pixel Grid | Dense grid pattern |
| Geist Pixel Circle | Circular dot matrix |
| Geist Pixel Triangle | Triangular pixel forms |
| Geist Pixel Line | Line-based pixel strokes |

Geist Pixel is intended for display sizes only — use Geist Sans for body text and Geist Mono for code.

## Coding Ligatures (v1.7.0)

Coding ligatures are **no longer enabled by default**. They have been moved from contextual alternates to **Stylistic Set 11 (SS11)**. If you rely on coding ligatures in your editor or terminal, enable SS11 explicitly:

- **VS Code**: `"editor.fontLigatures": "'ss11'"`
- **CSS**: `font-feature-settings: 'ss11' 1;`

## Cyrillic Support (v1.7.0)

Geist 1.7.0 includes a redesigned Cyrillic script for all Geist Sans and Geist Mono styles.

## Key Points

1. **Optimized for Next.js** — works seamlessly with `next/font` for zero-layout-shift font loading
2. **Three families** — Geist Sans for UI text, Geist Mono for code, Geist Pixel for decorative display
3. **CSS variables** — `--font-geist-sans` and `--font-geist-mono` for flexible styling
4. **Variable font** — single file supports all weights (100–900)
5. **Self-hosted** — fonts are bundled with your app, no external requests
6. **Import paths** — use `geist/font/sans` and `geist/font/mono` (not `geist/font`)
7. **Coding ligatures** — opt-in via Stylistic Set 11 (no longer default)

## Official Resources

- [Geist Font GitHub](https://github.com/vercel/geist-font)
- [Geist Design System](https://vercel.com/geist)
