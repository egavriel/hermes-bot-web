# Hermes Bot Web

Fast, mobile-first web UI for your personal AI agent. Built on Cloudflare Workers + Pages with VPS-hosted Hermes backend.

**Live:** https://ai.gavrielstudio.com

## Features

- 📱 **Mobile-first** — Touch-optimized, safe-area aware, 100/100 Lighthouse
- 🤖 **Multi-bot** — 9 built-in templates (Chief of Staff, Assistant, Code Mentor, Writer, Researcher, Data Analyst, Memory Curator, Knowledge Base, Blank) + custom bots
- ⚔️ **Chief of Staff** — Orchestrator that analyzes queries, delegates to specialists, synthesizes answers
- 🧠 **Memory per-bot** — Add facts/preferences/context that get auto-injected into bot's system prompt
- 📚 **Knowledge Base per-bot** — Upload txt/md docs, RAG-style keyword retrieval on every chat
- 💬 **Streaming** — SSE + rAF batching for 60fps token rendering
- 🎤 **Voice input** — Web Speech API, auto-submit on stop
- 📎 **Image upload** — Paste, drag-drop, or file picker
- 📦 **PWA** — Install to home screen, offline shell
- 🗂️ **Multi-session** — All conversations persisted per-bot, slide-out drawer
- 🔍 **Hermes backend** — Same model, skills, memory as Hermes Desktop

## Architecture

```
Mobile browser (anywhere)
  ↓ HTTPS ~50ms from CF edge POP
CF Pages (static UI from Worker ASSETS binding)
  ↓ SSE / fetch /api/*
CF Worker (FRA POP, Smart Placement)
  ├─ Cloudflare Access (email OTP, thegavriel.co only)
  ├─ Cloudflare Access JWT validation
  ├─ /api/bots/* — CRUD user bots (KV)
  ├─ /api/bots/:id/memory — memory entries per bot
  ├─ /api/bots/:id/kb — knowledge base docs per bot
  ├─ /api/chat — Chief orchestration OR specialist forwarding
  │   ├─ Inject bot.system + memory + KB context into system prompt
  │   └─ Forward to Hermes VPS via cloudflared tunnel
  │
  └─ Hermes api_server (127.0.0.1:8642 on Hetzner VPS, Nuremberg)
       └─ MiniMax M3 + fallback chain + skills + memory
```

## Repo Structure

```
hermes-bot-web/
├── worker/
│   ├── wrangler.toml           # Worker config (KV, ASSETS, secrets)
│   ├── package.json
│   ├── src/
│   │   ├── index.ts            # Worker entry — SSE proxy, auth, KV storage
│   │   └── templates.ts        # 9 built-in bot templates
│   └── public/
│       ├── index.html          # App shell
│       ├── styles.css          # Mobile-first CSS
│       ├── app.js              # Vanilla JS chat UI (50KB)
│       ├── manifest.json       # PWA manifest
│       └── sw.js               # Service worker (offline shell)
├── README.md
└── .gitignore
```

## Local Development

### Prerequisites

- Node.js 22+
- A Cloudflare account with Workers + KV enabled
- A Hermes bot running somewhere accessible via HTTPS
- Cloudflare Access app for email OTP auth

### Setup

```bash
cd worker
npm install
```

Create `worker/.dev.vars` for local secrets:
```
CF_ACCESS_AUD=your-access-app-aud
HERMES_API_KEY=your-hermes-api-key
```

Update `worker/wrangler.toml` with your:
- `account_id`
- KV namespace ID (`CACHE` binding)
- Smart Placement: `placement = { mode = "smart" }`

```bash
npm run dev    # Local dev server
npm run deploy # Deploy to Cloudflare
```

## Bot Templates

Each template ships with:

```typescript
{
  id: string;                  // "tmpl_chief", "tmpl_code_mentor", etc.
  category: "orchestrator" | "specialist" | "memory" | "knowledge" | "blank";
  name: string;
  icon: string;
  description: string;
  longDescription: string;
  system: string;              // Default system prompt
  tools: string[];             // ["memory", "web_search", "cron", ...]
  memorySchema: string;        // What this bot remembers
  knowledgeBase?: {            // Optional seed KB
    name: string;
    documents: Array<{ title: string; content: string }>;
  };
  suggestedPrompts: string[];
}
```

### Built-in templates

1. **tmpl_chief** (⚔️) — Chief of Staff (orchestrator)
2. **tmpl_assistant** (✦) — Personal Assistant (general)
3. **tmpl_code_mentor** (⌘) — Code Mentor (with web search + files)
4. **tmpl_writer** (✎) — Writing Coach
5. **tmpl_researcher** (🔍) — Researcher (web search + citations)
6. **tmpl_data_analyst** (📊) — Data Analyst (Python + charts)
7. **tmpl_memory_curator** (🧠) — Memory Curator
8. **tmpl_knowledge_base** (📚) — Knowledge Base (RAG)
9. **tmpl_blank** (✦) — Blank slate

Adding a template: edit `worker/src/templates.ts` and push.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/bot-templates` | Public — list all templates |
| GET | `/api/bots` | List user's bots + templates |
| POST | `/api/bots` | Create bot (optionally from template) |
| PUT | `/api/bots/:id` | Update bot |
| DELETE | `/api/bots/:id` | Delete bot (also clears memory + KB) |
| GET | `/api/bots/:id/memory` | List memory entries |
| POST | `/api/bots/:id/memory` | Add memory entry |
| DELETE | `/api/bots/:id/memory/:mid` | Remove memory entry |
| GET | `/api/bots/:id/kb` | List KB docs |
| POST | `/api/bots/:id/kb` | Add KB doc |
| DELETE | `/api/bots/:id/kb/:did` | Remove KB doc |
| POST | `/api/chat` | Send message (specialist or Chief mode) |
| GET | `/healthz` | Health check |

All `/api/*` endpoints (except templates) require a valid Cloudflare Access session.

## Deployment

### Initial setup

```bash
# 1. Create KV namespace
wrangler kv namespace create CACHE
# → returns id, paste into wrangler.toml

# 2. Set secrets
wrangler secret put CF_ACCESS_AUD
wrangler secret put HERMES_API_KEY

# 3. Create Cloudflare Access app (self-hosted, email allowlist)
#    Save the AUD tag — set as CF_ACCESS_AUD secret above

# 4. Create Worker route
#    bot.yourdomain.com/* → hermes-bot-api

# 5. Create Pages custom domain
#    bot.yourdomain.com → your worker
```

### Deploy

```bash
cd worker
wrangler deploy
```

Free tier limits:
- 100K Worker requests/day
- 100K KV reads/day
- 1K KV writes/day
- 50ms CPU per request

## Performance

| Metric | Value |
|---|---|
| Lighthouse Performance | 100/100 |
| First Contentful Paint | 1.1s |
| Largest Contentful Paint | 1.1s |
| Total Blocking Time | 0ms |
| Cumulative Layout Shift | 0 |
| Bundle size (transfer) | 25 KiB |

## Customization

### Branding
- Edit `worker/public/index.html` for title + meta
- Edit `worker/public/styles.css` for theme colors (`--accent`, `--bg`, etc.)
- Replace icons in `worker/src/templates.ts` and `worker/public/app.js` (`ICON_OPTIONS`)

### Adding tools
The `tools` field on bots is informational for v1. In v2, you'll be able to enable/disable specific Hermes skills per bot:
- `memory` — long-term memory
- `web_search` — Web search
- `files` — File read/write
- `cron` — Scheduled tasks
- `terminal` — Shell command execution
- `delegation` — Can call other bots (Chief mode)

## License

MIT
