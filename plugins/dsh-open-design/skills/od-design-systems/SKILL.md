---
name: od-design-systems
description: |
  Bundled catalog of 152 brand-grade design systems (Apple, Stripe, Vercel,
  Nike, Notion, Linear, Spotify, shadcn, Xiahongshu, WeChat, and 142 more),
  each shipping DESIGN.md design prose, USAGE.md guidance, compiled tokens
  (tokens.css / design-tokens.json / tailwind-v4.css), a live components.html
  gallery, and preview pages. Use whenever a brief mentions a brand, a visual
  style family, or asks to apply / extract / match a design system.
whenToUse: |
  The user names a brand or style ("像 Stripe 那样", "Apple-style", "brutalist",
  "use shadcn"), asks to pick a visual direction, or wants brand-spec
  extraction. Also use at the start of any prototype / deck / page task to
  check whether a bundled system already covers the target look.
---

# Design Systems catalog

152 brand-grade design systems are bundled in `design-systems/` inside this
skill's own directory. Start from `design-systems/README.md` for the catalog
conventions (manifest.json discovery, DESIGN.md as canonical agent prose,
tokens.css as compiled semantic tokens).

## How to use one

1. Pick the system matching the brief's brand or style family from the list
   below (or from `manifest.json` `category` fields when browsing).
2. Read `<slug>/DESIGN.md` **fully and once** — it is required context, not
   something to skim. Read `<slug>/USAGE.md` next; it carries usage guidance
   and known pitfalls. For Chinese briefs, `<slug>/DESIGN-zh.md` is the
   localized variant where present.
3. Compose against the tokens: copy `<slug>/tokens.css` custom properties into
   the artifact's `:root`, or align utility classes with
   `<slug>/tailwind-v4.css`. `design-tokens.json` is the machine-readable
   source of the same values.
4. For component look-and-feel, consult `<slug>/components.html` (a live
   gallery of rendered components in the system's style) and
   `<slug>/preview/` (colors / typography / spacing pages).

## Working rules

- The design system is the visual contract: match its palette, typography,
  spacing, radius, shadow, and component styling instead of inventing values.
- When the user gives a brand with no bundled entry, use the closest bundled
  system as a starting point and say so, or run brand extraction on their
  references.
- Do not modify files under `design-systems/`; copy token values into the
  artifact instead of linking to the catalog.

## Catalog

agentic airbnb airtable ant apple application arc artistic atelier-zero
bento binance bmw bmw-m bold brutalism bugatti cafe cal canva cisco claude
clay claymorphism clean clickhouse cloudflare-kumo cohere coinbase colorful
composio contemporary corporate cosmic creative cursor dashboard default
discord dithered doodle dramatic duolingo editorial elegant elevenlabs
energetic enterprise expo expressive fantasy ferrari figma flat framer
friendly futuristic github glassmorphism gradient hashicorp hud huggingface
ibm intercom kami kraken lamborghini levels linear-app lingo loom lovable
luxury mastercard material meta minimal minimax mintlify miro
mission-control mistral-ai modern mongodb mono neobrutalism neon
neumorphism nike notion nvidia ollama openai opencode-ai pacman paper
perplexity perspective pinterest playstation posthog premium professional
publication raycast refined renault replicate resend retro revolut runwayml
sentry shadcn shopify simple skeuomorphism slack sleek spacex spacious
spotify starbucks storytelling stripe supabase superhuman tesla tetris
theverge together-ai tom-modern totality-festival trading-terminal uber
urdu vercel vibrant vintage vodafone voltagent warm-editorial warp webex
webflow wechat wired wise x-ai xiaohongshu zapier
