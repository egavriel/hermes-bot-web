/**
 * Hermes Bot Web — Desktop Bot Mode parity (v6)
 *
 * Architecture:
 *   Browser → Worker (FRA POP via Smart Placement)
 *     → CF Access JWT
 *     → /api/bot-templates, /api/bots/*, memory, kb
 *     → /api/roster, /api/sessions, /api/routines, /api/groups, /api/inbox
 *     → /api/chat (message_agent protocol + Chief)
 *     → /api/groups/:id/chat (2–6 bots, serial rounds, @mentions)
 */

import { jwtVerify, createRemoteJWKSet } from "jose";
import { BOT_TEMPLATES, getTemplate, BotTemplate } from "./templates";
import {
  enrichBot,
  blobAvatar,
  botHandle,
  buildRosterBlock,
  parseMessageAgentCalls,
  stripMessageAgentMarkers,
  resolveRosterTarget,
  extractMentions,
  routineFullName,
  getBotSessions,
  saveBotSessions,
  ensureCanonicalSession,
  compactCanonical,
  appendToBotSession,
  getRoutines,
  saveRoutines,
  getGroups,
  saveGroups,
  getInbox,
  saveInbox,
  getRosterMeta,
  saveRosterMeta,
  type RosterBot,
  type Routine,
  type GroupRoom,
  type InboxItem,
  type ChatSession,
} from "./botmode";

export interface Env {
  HERMES_API_URL: string;
  HERMES_API_KEY: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM: string;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS(team: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  return jwks;
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

/** Decode JWT payload without verify — only used after cookie presence is confirmed. */
function decodeJwtEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = atob(b64 + pad);
    const payload = JSON.parse(json);
    return normalizeEmail(payload.email || payload.common_name || null);
  } catch {
    return null;
  }
}

async function verifyAccessJwt(token: string, env: Env): Promise<{ email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getJWKS(env.CF_ACCESS_TEAM), { audience: env.CF_ACCESS_AUD });
    const email = normalizeEmail((payload.email as string) || null);
    return email ? { email } : null;
  } catch { return null; }
}

function extractJwt(req: Request): string | null {
  const headerJwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (headerJwt) return headerJwt;
  const cookieHeader = req.headers.get("Cookie") || req.headers.get("cookie") || "";
  if (cookieHeader) {
    const matches = cookieHeader.match(/(?:^|;\s*)(?:CF_Authorization|cf_authorization)=([^;]+)/gi);
    if (matches) {
      const m = matches[0].match(/=([^;]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
  }
  return null;
}

async function authUser(req: Request, env: Env): Promise<{ email: string } | null> {
  // CF Access injects this on every authenticated request at the edge
  const headerEmail = normalizeEmail(req.headers.get("Cf-Access-Authenticated-User-Email"));
  if (headerEmail) return { email: headerEmail };

  const jwt = extractJwt(req);
  if (jwt) {
    const user = await verifyAccessJwt(jwt, env);
    if (user) return user;
    // JWT present but JWKS verify failed (network blip / clock skew).
    // Still extract email so KV keys stay stable — NEVER share one bucket.
    const email = decodeJwtEmail(jwt);
    if (email) return { email };
  }
  return null;
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

async function streamHermes(body: any, env: Env, signal?: AbortSignal): Promise<Response> {
  return fetch(`${env.HERMES_API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.HERMES_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
}

async function collectHermesText(body: any, env: Env, signal?: AbortSignal): Promise<string> {
  const res = await streamHermes(body, env, signal);
  if (!res.ok || !res.body) throw new Error(`Hermes returned ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content;
          if (d) text += d;
        } catch {}
      }
    }
  }
  return text;
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── User bot storage ────────────────────────────────────
async function getUserBots(userEmail: string, env: Env): Promise<any[]> {
  const key = `bots:${userEmail}`;
  const raw = await env.CACHE.get(key);
  if (raw) {
    try {
      const userBots = JSON.parse(raw);
      if (Array.isArray(userBots) && userBots.length > 0) return userBots;
    } catch {}
  }
  // Migrate bots seeded under the old shared fallback identity
  if (userEmail !== "authenticated@user") {
    const legacy = await env.CACHE.get("bots:authenticated@user");
    if (legacy) {
      try {
        const bots = JSON.parse(legacy);
        if (Array.isArray(bots) && bots.length > 0) {
          await saveUserBots(userEmail, env, bots);
          return bots;
        }
      } catch {}
    }
  }
  return [];
}

async function saveUserBots(userEmail: string, env: Env, userBots: any[]): Promise<void> {
  await env.CACHE.put(`bots:${userEmail}`, JSON.stringify(userBots), { expirationTtl: 60 * 60 * 24 * 365 });
}

// ── Memory storage ──────────────────────────────────────
async function getMemory(userEmail: string, botId: string, env: Env): Promise<any[]> {
  const raw = await env.CACHE.get(`bot_memory:${userEmail}:${botId}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveMemory(userEmail: string, botId: string, entries: any[], env: Env): Promise<void> {
  await env.CACHE.put(`bot_memory:${userEmail}:${botId}`, JSON.stringify(entries));
}

// ── Knowledge Base storage ──────────────────────────────
async function getKB(userEmail: string, botId: string, env: Env): Promise<any[]> {
  const raw = await env.CACHE.get(`bot_kb:${userEmail}:${botId}`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveKB(userEmail: string, botId: string, docs: any[], env: Env): Promise<void> {
  await env.CACHE.put(`bot_kb:${userEmail}:${botId}`, JSON.stringify(docs));
}

// Simple keyword match — find top 3 most relevant docs
function searchKB(query: string, docs: any[]): any[] {
  if (docs.length === 0) return [];
  const queryWords = new Set(
    query.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3)
  );
  if (queryWords.size === 0) return [];
  const scored = docs.map(d => {
    const text = `${d.title} ${d.content}`.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      const re = new RegExp(`\\b${word}\\b`, "gi");
      const matches = text.match(re);
      score += matches ? matches.length : 0;
    }
    return { doc: d, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(s => s.doc);
}

async function buildRoster(userEmail: string, env: Env): Promise<RosterBot[]> {
  const userBots = await getUserBots(userEmail, env);
  const meta = await getRosterMeta(userEmail, env);
  const fromUser = userBots.map((b: any) => {
    const e = enrichBot(b);
    const m = meta[b.id] || {};
    return { ...e, hidden: m.hidden ?? e.hidden, order: m.order ?? e.order };
  });
  // Always expose templates as chatable roster peers (Desktop Shape A)
  const fromTpl = BOT_TEMPLATES.filter((t) => t.id !== "tmpl_blank").map((t) => {
    const e = enrichBot({
      id: t.id,
      name: t.name,
      icon: t.icon,
      description: t.description,
      system: t.system,
      templateId: t.id,
    });
    const m = meta[t.id] || {};
    return { ...e, hidden: m.hidden ?? false, order: m.order ?? 100 };
  });
  // Prefer user bots over same-named templates
  const seen = new Set(fromUser.map((b) => b.id));
  const merged = [...fromUser, ...fromTpl.filter((t) => !seen.has(t.id))];
  return merged.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

async function resolveBotAny(userEmail: string, botId: string, env: Env): Promise<any | null> {
  if (!botId) return null;
  const userBots = await getUserBots(userEmail, env);
  let bot = userBots.find((b: any) => b.id === botId) || null;
  if (!bot) {
    const tplId = botId === "bot_starter_chief" ? "tmpl_chief" : botId;
    const tpl = getTemplate(tplId);
    if (tpl) {
      bot = {
        id: botId === "bot_starter_chief" ? "bot_starter_chief" : tpl.id,
        name: tpl.name,
        icon: tpl.icon,
        description: tpl.description,
        system: tpl.system,
        tools: tpl.tools,
        templateId: tpl.id,
      };
    }
  }
  if (bot) {
    bot.avatar = bot.avatar || blobAvatar(bot.name, bot.icon);
    bot.handle = bot.handle || botHandle(bot.name);
  }
  return bot;
}

// Build the system prompt: bot's prompt + memory + KB + roster protocol
async function buildSystemPrompt(
  userEmail: string,
  bot: any,
  userQuery: string,
  env: Env,
  roster?: RosterBot[]
): Promise<string> {
  let prompt = bot.system || "You are a helpful assistant.";

  const memory = await getMemory(userEmail, bot.id, env);
  if (memory.length > 0) {
    prompt += `\n\n## Memory\n${memory.map((m: any) => `- ${m.content}`).join("\n")}`;
  }

  const kb = await getKB(userEmail, bot.id, env);
  if (kb.length > 0) {
    const relevant = searchKB(userQuery, kb);
    if (relevant.length > 0) {
      prompt += `\n\n## Relevant context from your knowledge base:\n`;
      for (const doc of relevant) {
        const content = doc.content.length > 2000 ? doc.content.slice(0, 2000) + "…" : doc.content;
        prompt += `\n### ${doc.title}\n${content}\n`;
      }
    }
  }

  if (bot.tools?.length > 0) {
    prompt += `\n\n## Available tools: ${bot.tools.join(", ")}`;
  }

  const r = roster || (await buildRoster(userEmail, env));
  prompt += buildRosterBlock(r, bot.id);

  return prompt;
}

/** Deliver message_agent fire-and-forget into target bot canonical chat + inbox. */
async function deliverMessageAgent(
  userEmail: string,
  fromBot: any,
  target: RosterBot,
  composedMessage: string,
  env: Env,
  signal?: AbortSignal
): Promise<InboxItem> {
  const item: InboxItem = {
    id: crypto.randomUUID(),
    fromBotId: fromBot.id,
    fromBotName: fromBot.name,
    fromBotIcon: fromBot.icon || "✦",
    toBotId: target.id,
    message: composedMessage,
    status: "pending",
    createdAt: Date.now(),
  };

  const attributed = `Message from 🤖 ${fromBot.name} (@${fromBot.handle || botHandle(fromBot.name)}):\n\n${composedMessage}`;

  // Drop into target's canonical Bot Chat as a user-attributed message
  await appendToBotSession(
    userEmail,
    target.id,
    [{ role: "user", content: attributed, id: crypto.randomUUID(), ts: Date.now(), fromBot: fromBot.id }],
    env,
    { botName: target.name }
  );

  // Run one turn on the target bot (async completion)
  try {
    const targetBot = await resolveBotAny(userEmail, target.id, env);
    if (!targetBot) throw new Error(`target ${target.id} missing`);
    const roster = await buildRoster(userEmail, env);
    const system = await buildSystemPrompt(userEmail, targetBot, composedMessage, env, roster);
    const reply = await collectHermesText(
      {
        model: "hermes-agent",
        messages: [
          { role: "system", content: system },
          { role: "user", content: attributed },
        ],
      },
      env,
      signal
    );
    const clean = stripMessageAgentMarkers(reply);
    await appendToBotSession(
      userEmail,
      target.id,
      [{ role: "assistant", content: clean, id: crypto.randomUUID(), ts: Date.now() }],
      env,
      { botName: target.name }
    );
    // Also notify the sender's canonical chat
    await appendToBotSession(
      userEmail,
      fromBot.id,
      [{
        role: "assistant",
        content: `📬 Reply from ${target.name} (@${target.handle}):\n\n${clean}`,
        id: crypto.randomUUID(),
        ts: Date.now(),
        fromBot: target.id,
        kind: "message_agent_reply",
      }],
      env,
      { botName: fromBot.name }
    );
    item.reply = clean;
    item.status = "replied";
    item.repliedAt = Date.now();
  } catch (e: any) {
    item.status = "error";
    item.reply = e?.message || "delivery failed";
  }

  const inbox = await getInbox(userEmail, env);
  inbox.unshift(item);
  await saveInbox(userEmail, inbox, env);
  return item;
}

// ── Default seeded bots (created on first request) ─────
function getSeedBots(): any[] {
  // Seed 1 starter bot so user has something to chat with immediately
  return [
    {
      id: "bot_starter_chief",
      templateId: "tmpl_chief",
      name: "Chief of Staff",
      icon: "⚔️",
      description: "Your default orchestrator",
      system: BOT_TEMPLATES[0].system,
      tools: ["delegation"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      builtin: false,
    },
  ];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json({ ok: true });

    const requireAuth = async () => {
      const user = await authUser(req, env);
      if (!user) return { error: json({ error: "unauthorized" }, 401), user: null };
      return { error: null, user };
    };

    // ── /api/bot-templates GET (public — no auth required) ──
    if (url.pathname === "/api/bot-templates" && req.method === "GET") {
      return json({ templates: BOT_TEMPLATES });
    }

    // ── /api/bots GET ──
    if (url.pathname === "/api/bots" && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let bots = await getUserBots(user!.email, env);
      // Auto-seed on first call
      if (bots.length === 0) {
        bots = getSeedBots();
        await saveUserBots(user!.email, env, bots);
      }
      bots = bots.map((b: any) => enrichBot(b));
      // Include templates in response (for UI to show)
      return json({ bots, templates: BOT_TEMPLATES });
    }

    // ── /api/bots POST (create) ──
    if (url.pathname === "/api/bots" && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

      const bots = await getUserBots(user!.email, env);
      const id = body.id || `bot_${crypto.randomUUID().slice(0, 8)}`;
      const name = String(body.name || "Unnamed Bot").slice(0, 50);
      const icon = String(body.icon || "✦").slice(0, 4);
      const newBot = enrichBot({
        id,
        templateId: body.templateId || null,
        name,
        icon,
        description: String(body.description || "").slice(0, 200),
        system: String(body.system || "You are a helpful assistant.").slice(0, 4000),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 20) : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        builtin: false,
      });
      bots.unshift(newBot);
      await saveUserBots(user!.email, env, bots);

      // If created from a template, seed memory + KB
      if (body.templateId) {
        const tpl = getTemplate(body.templateId);
        if (tpl) {
          // Seed memory if template has memorySchema
          if (tpl.memorySchema) {
            const seedEntry = {
              id: `mem_${crypto.randomUUID().slice(0, 8)}`,
              botId: id,
              content: `[Template default] ${tpl.memorySchema.split("\n")[0]}`,
              category: "template",
              createdAt: Date.now(),
            };
            await saveMemory(user!.email, id, [seedEntry], env);
          }
          // Seed KB if template has KB
          if (tpl.knowledgeBase?.documents?.length) {
            const seedDocs = tpl.knowledgeBase.documents.map(d => ({
              id: `doc_${crypto.randomUUID().slice(0, 8)}`,
              botId: id,
              title: d.title,
              content: d.content,
              size: d.content.length,
              createdAt: Date.now(),
            }));
            await saveKB(user!.email, id, seedDocs, env);
          }
        }
      }

      return json({ bot: newBot, bots });
    }

    // ── /api/bots/:id PUT ──
    if (url.pathname.startsWith("/api/bots/") && req.method === "PUT") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3]; // /api/bots/:id
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const bots = await getUserBots(user!.email, env);
      const idx = bots.findIndex(b => b.id === id);
      if (idx === -1) return json({ error: "not_found" }, 404);
      bots[idx] = {
        ...bots[idx],
        name: String(body.name || bots[idx].name).slice(0, 50),
        icon: String(body.icon || bots[idx].icon).slice(0, 4),
        description: String(body.description || bots[idx].description).slice(0, 200),
        system: String(body.system || bots[idx].system).slice(0, 4000),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 20) : (bots[idx].tools || []),
        updatedAt: Date.now(),
      };
      await saveUserBots(user!.email, env, bots);
      return json({ bot: bots[idx], bots });
    }

    // ── /api/bots/:id DELETE ──
    if (url.pathname.startsWith("/api/bots/") && req.method === "DELETE") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3];
      const bots = await getUserBots(user!.email, env).then(b => b.filter((x: any) => x.id !== id));
      await saveUserBots(user!.email, env, bots);
      // Also delete memory + KB
      await env.CACHE.delete(`bot_memory:${user!.email}:${id}`);
      await env.CACHE.delete(`bot_kb:${user!.email}:${id}`);
      return json({ ok: true, bots });
    }

    // ── /api/bots/:id/memory GET ──
    if (url.pathname.match(/^\/api\/bots\/[^/]+\/memory$/) && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.pathname.split("/")[3];
      const memory = await getMemory(user!.email, botId, env);
      return json({ memory });
    }

    // ── /api/bots/:id/memory POST ──
    if (url.pathname.match(/^\/api\/bots\/[^/]+\/memory$/) && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.pathname.split("/")[3];
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const content = String(body.content || "").trim();
      if (!content) return json({ error: "missing_content" }, 400);
      const memory = await getMemory(user!.email, botId, env);
      const entry = {
        id: `mem_${crypto.randomUUID().slice(0, 8)}`,
        botId,
        content: content.slice(0, 2000),
        category: String(body.category || "fact").slice(0, 50),
        createdAt: Date.now(),
      };
      memory.push(entry);
      await saveMemory(user!.email, botId, memory, env);
      return json({ entry, memory });
    }

    // ── /api/bots/:id/memory/:mid DELETE ──
    if (url.pathname.match(/^\/api\/bots\/[^/]+\/memory\/[^/]+$/) && req.method === "DELETE") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const parts = url.pathname.split("/");
      const botId = parts[3];
      const memId = parts[5];
      const memory = (await getMemory(user!.email, botId, env)).filter(m => m.id !== memId);
      await saveMemory(user!.email, botId, memory, env);
      return json({ ok: true, memory });
    }

    // ── /api/bots/:id/kb GET ──
    if (url.pathname.match(/^\/api\/bots\/[^/]+\/kb$/) && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.pathname.split("/")[3];
      const docs = await getKB(user!.email, botId, env);
      return json({ docs });
    }

    // ── /api/bots/:id/kb POST ──
    if (url.pathname.match(/^\/api\/bots\/[^/]+\/kb$/) && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.pathname.split("/")[3];
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const title = String(body.title || "Untitled").slice(0, 200);
      const content = String(body.content || "").slice(0, 100000); // 100KB max per doc
      if (!content.trim()) return json({ error: "missing_content" }, 400);
      const docs = await getKB(user!.email, botId, env);
      if (docs.length >= 20) return json({ error: "too_many_docs", limit: 20 }, 400);
      const doc = {
        id: `doc_${crypto.randomUUID().slice(0, 8)}`,
        botId,
        title,
        content,
        size: content.length,
        createdAt: Date.now(),
      };
      docs.push(doc);
      await saveKB(user!.email, botId, docs, env);
      return json({ doc, docs });
    }

    // ── /api/bots/:id/kb/:did DELETE ──
    if (url.pathname.match(/^\/api\/bots\/[^/]+\/kb\/[^/]+$/) && req.method === "DELETE") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const parts = url.pathname.split("/");
      const botId = parts[3];
      const docId = parts[5];
      const docs = (await getKB(user!.email, botId, env)).filter(d => d.id !== docId);
      await saveKB(user!.email, botId, docs, env);
      return json({ ok: true, docs });
    }

    // ── /api/roster GET ──
    if (url.pathname === "/api/roster" && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const roster = await buildRoster(user!.email, env);
      return json({ roster });
    }

    // ── /api/roster PUT (order / hidden) ──
    if (url.pathname === "/api/roster" && req.method === "PUT") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const meta = await getRosterMeta(user!.email, env);
      if (Array.isArray(body.order)) {
        body.order.forEach((id: string, i: number) => {
          meta[id] = { ...(meta[id] || {}), order: i };
        });
      }
      if (body.hidden && typeof body.hidden === "object") {
        for (const [id, v] of Object.entries(body.hidden)) {
          meta[id] = { ...(meta[id] || {}), hidden: !!v };
        }
      }
      await saveRosterMeta(user!.email, meta, env);
      return json({ roster: await buildRoster(user!.email, env) });
    }

    // ── /api/sessions/:botId GET ──
    if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.pathname.split("/")[3];
      const bot = await resolveBotAny(user!.email, botId, env);
      const sessions = await getBotSessions(user!.email, botId, env);
      if (sessions.length === 0 && bot) {
        const canon = await ensureCanonicalSession(user!.email, botId, bot.name, env);
        return json({ sessions: [canon], canonical: canon });
      }
      const canonical = sessions.find((s) => s.canonical) || sessions[0] || null;
      return json({ sessions, canonical });
    }

    // ── /api/sessions/:botId POST (create / upsert) ──
    if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.pathname.split("/")[3];
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const bot = await resolveBotAny(user!.email, botId, env);
      const all = await getBotSessions(user!.email, botId, env);
      if (body.action === "compact") {
        const canon = await compactCanonical(user!.email, botId, env);
        return json({ session: canon, sessions: await getBotSessions(user!.email, botId, env) });
      }
      if (body.action === "ensure_canonical") {
        const canon = await ensureCanonicalSession(user!.email, botId, bot?.name || "Bot", env);
        return json({ session: canon, sessions: await getBotSessions(user!.email, botId, env) });
      }
      // upsert session snapshot from client
      if (body.session?.id) {
        const s: ChatSession = {
          id: body.session.id,
          botId,
          title: body.session.title || "Chat",
          messages: Array.isArray(body.session.messages) ? body.session.messages.slice(-80) : [],
          canonical: !!body.session.canonical,
          createdAt: body.session.createdAt || Date.now(),
          updatedAt: Date.now(),
        };
        const idx = all.findIndex((x) => x.id === s.id);
        if (idx >= 0) all[idx] = s; else all.unshift(s);
        await saveBotSessions(user!.email, botId, all, env);
        return json({ session: s, sessions: all });
      }
      // new non-canonical session
      const s: ChatSession = {
        id: crypto.randomUUID(),
        botId,
        title: body.title || "New chat",
        messages: [],
        canonical: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      all.unshift(s);
      await saveBotSessions(user!.email, botId, all, env);
      return json({ session: s, sessions: all });
    }

    // ── /api/sessions/:botId/:sid DELETE ──
    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/[^/]+$/) && req.method === "DELETE") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const parts = url.pathname.split("/");
      const botId = parts[3];
      const sid = parts[4];
      let all = await getBotSessions(user!.email, botId, env);
      const target = all.find((s) => s.id === sid);
      if (target?.canonical) return json({ error: "cannot_delete_canonical" }, 400);
      all = all.filter((s) => s.id !== sid);
      await saveBotSessions(user!.email, botId, all, env);
      return json({ ok: true, sessions: all });
    }

    // ── /api/routines ──
    if (url.pathname === "/api/routines" && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.searchParams.get("bot_id");
      let routines = await getRoutines(user!.email, env);
      if (botId) routines = routines.filter((r) => r.botId === botId);
      return json({ routines });
    }
    if (url.pathname === "/api/routines" && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const bot = await resolveBotAny(user!.email, body.bot_id, env);
      if (!bot) return json({ error: "bot_not_found" }, 404);
      const routine: Routine = {
        id: crypto.randomUUID(),
        botId: bot.id,
        botName: bot.name,
        name: String(body.name || "Routine").slice(0, 80),
        prompt: String(body.prompt || "").slice(0, 4000),
        schedule: String(body.schedule || "manual").slice(0, 80),
        enabled: body.enabled !== false,
        continuity: !!body.continuity,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const routines = await getRoutines(user!.email, env);
      routines.unshift(routine);
      await saveRoutines(user!.email, routines, env);
      return json({ routine, routines, fullName: routineFullName(bot.name, routine.name) });
    }
    if (url.pathname.match(/^\/api\/routines\/[^/]+$/) && req.method === "PUT") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3];
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const routines = await getRoutines(user!.email, env);
      const idx = routines.findIndex((r) => r.id === id);
      if (idx < 0) return json({ error: "not_found" }, 404);
      routines[idx] = {
        ...routines[idx],
        name: body.name ?? routines[idx].name,
        prompt: body.prompt ?? routines[idx].prompt,
        schedule: body.schedule ?? routines[idx].schedule,
        enabled: body.enabled ?? routines[idx].enabled,
        continuity: body.continuity ?? routines[idx].continuity,
        updatedAt: Date.now(),
      };
      await saveRoutines(user!.email, routines, env);
      return json({ routine: routines[idx], routines });
    }
    if (url.pathname.match(/^\/api\/routines\/[^/]+$/) && req.method === "DELETE") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3];
      const routines = (await getRoutines(user!.email, env)).filter((r) => r.id !== id);
      await saveRoutines(user!.email, routines, env);
      return json({ ok: true, routines });
    }
    if (url.pathname.match(/^\/api\/routines\/[^/]+\/run$/) && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3];
      const routines = await getRoutines(user!.email, env);
      const routine = routines.find((r) => r.id === id);
      if (!routine) return json({ error: "not_found" }, 404);
      const bot = await resolveBotAny(user!.email, routine.botId, env);
      if (!bot) return json({ error: "bot_not_found" }, 404);
      const roster = await buildRoster(user!.email, env);
      const system = await buildSystemPrompt(user!.email, bot, routine.prompt, env, roster);
      const continuityBlock = routine.continuity && routine.lastOutput
        ? `\n\n## Previous run output\n${routine.lastOutput.slice(0, 2000)}`
        : "";
      try {
        const output = await collectHermesText({
          model: "hermes-agent",
          messages: [
            { role: "system", content: system + continuityBlock },
            { role: "user", content: `[Routine: ${routineFullName(bot.name, routine.name)}]\n${routine.prompt}` },
          ],
        }, env, req.signal);
        const clean = stripMessageAgentMarkers(output);
        routine.lastRunAt = Date.now();
        routine.lastOutput = clean;
        routine.updatedAt = Date.now();
        await saveRoutines(user!.email, routines, env);
        await appendToBotSession(
          user!.email,
          bot.id,
          [
            { role: "user", content: `⏱ Routine ran: ${routine.name}`, id: crypto.randomUUID(), ts: Date.now(), kind: "routine" },
            { role: "assistant", content: clean, id: crypto.randomUUID(), ts: Date.now(), kind: "routine" },
          ],
          env,
          { botName: bot.name }
        );
        return json({ ok: true, output: clean, routine });
      } catch (e: any) {
        return json({ error: "run_failed", message: e.message }, 502);
      }
    }

    // ── /api/groups ──
    if (url.pathname === "/api/groups" && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      return json({ groups: await getGroups(user!.email, env) });
    }
    if (url.pathname === "/api/groups" && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const members = Array.isArray(body.memberBotIds) ? body.memberBotIds.slice(0, 6) : [];
      if (members.length < 2) return json({ error: "need_2_to_6_bots" }, 400);
      const group: GroupRoom = {
        id: crypto.randomUUID(),
        name: String(body.name || "Group").slice(0, 60),
        memberBotIds: members,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const groups = await getGroups(user!.email, env);
      groups.unshift(group);
      await saveGroups(user!.email, groups, env);
      return json({ group, groups });
    }
    if (url.pathname.match(/^\/api\/groups\/[^/]+$/) && req.method === "DELETE") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3];
      const groups = (await getGroups(user!.email, env)).filter((g) => g.id !== id);
      await saveGroups(user!.email, groups, env);
      return json({ ok: true, groups });
    }
    if (url.pathname.match(/^\/api\/groups\/[^/]+\/chat$/) && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const id = url.pathname.split("/")[3];
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const groups = await getGroups(user!.email, env);
      const group = groups.find((g) => g.id === id);
      if (!group) return json({ error: "not_found" }, 404);
      const text = String(body.message || "").trim();
      if (!text) return json({ error: "empty" }, 400);
      return await handleGroupChat(user!.email, group, groups, text, env, req.signal);
    }

    // ── /api/inbox GET ──
    if (url.pathname === "/api/inbox" && req.method === "GET") {
      const { error, user } = await requireAuth();
      if (error) return error;
      const botId = url.searchParams.get("bot_id");
      let items = await getInbox(user!.email, env);
      if (botId) items = items.filter((i) => i.toBotId === botId || i.fromBotId === botId);
      return json({ inbox: items });
    }

    // ── /api/message-agent POST (explicit operator-triggered handoff) ──
    if (url.pathname === "/api/message-agent" && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const fromBot = await resolveBotAny(user!.email, body.from_bot_id, env);
      if (!fromBot) return json({ error: "from_bot_not_found" }, 404);
      const roster = await buildRoster(user!.email, env);
      const target = resolveRosterTarget(roster, body.target);
      if (!target) return json({ error: "unknown_target", message: `No bot matching "${body.target}"` }, 404);
      const item = await deliverMessageAgent(user!.email, fromBot, target, String(body.message || ""), env, req.signal);
      return json({ ok: true, item });
    }

    // ── /api/chat POST ──
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const { messages, bot_id } = body;
      if (!Array.isArray(messages) || messages.length === 0) return json({ error: "no_messages" }, 400);
      const userEmail = user!.email;

      const bot = await resolveBotAny(userEmail, bot_id, env);
      if (!bot) {
        return json({
          error: "bot_not_found",
          message: `Bot "${bot_id || "(missing)"}" not found. Open the bot switcher and pick Chief of Staff or create one from a template.`,
          bot_id: bot_id || null,
        }, 404);
      }

      // Ensure canonical Bot Chat exists (Desktop: clicking a bot always lands there)
      await ensureCanonicalSession(userEmail, bot.id, bot.name, env);

      const roster = await buildRoster(userEmail, env);
      const userBots = await getUserBots(userEmail, env);

      // CHIEF MODE — still supported + message_agent capable
      if (bot.id === "tmpl_chief" || bot.id === "bot_starter_chief" || bot.templateId === "tmpl_chief") {
        const allSpecialists = roster.filter((b) => b.id !== bot.id && !b.hidden);
        return await handleChief(messages, allSpecialists, env, req.signal, {
          userEmail, bot, roster,
        });
      }

      // SPECIALIST MODE — stream + parse message_agent calls
      const lastUserMsg = messages[messages.length - 1];
      const userQuery = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
      const systemPrompt = await buildSystemPrompt(userEmail, bot, userQuery, env, roster);

      // Composer @mention → auto message_agent dispatch (Desktop behavior)
      const mentions = extractMentions(userQuery, roster.filter((b) => b.id !== bot.id));
      if (mentions.length > 0 && !body.skip_mentions) {
        // Fire-and-forget: active bot composes via a short turn, then delivers
        return await handleMentionDispatch(userEmail, bot, mentions, userQuery, messages, env, req.signal, roster);
      }

      return await handleSpecialistChat(userEmail, bot, messages, systemPrompt, roster, env, req.signal);
    }

    // Static UI
    try {
      const r = await env.ASSETS.fetch(req);
      if (r.ok) return r;
    } catch {}
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

// ── SSE helper for Bot Mode chat paths ─────────────────
function sseStream(run: (send: (event: string, data: any) => void, close: () => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        try { controller.enqueue(encoder.encode(sseEvent(event, data))); } catch {}
      };
      const close = () => { try { controller.close(); } catch {} };
      try {
        await run(send, close);
      } catch (e: any) {
        if (e?.name !== "AbortError") send("error", { message: e?.message || "error" });
        close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS_HEADERS },
  });
}

async function streamAndCollect(
  body: any,
  env: Env,
  signal: AbortSignal | undefined,
  onToken: (t: string) => void
): Promise<string> {
  const res = await streamHermes(body, env, signal);
  if (!res.ok || !res.body) throw new Error(`hermes ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content;
          if (d) { full += d; onToken(d); }
        } catch {}
      }
    }
  }
  return full;
}

/** After a bot reply, parse message_agent(...) and deliver fire-and-forget. */
async function processMessageAgentCalls(
  userEmail: string,
  fromBot: any,
  fullText: string,
  roster: RosterBot[],
  env: Env,
  signal: AbortSignal | undefined,
  send: (event: string, data: any) => void
): Promise<string> {
  const calls = parseMessageAgentCalls(fullText);
  if (!calls.length) return stripMessageAgentMarkers(fullText);

  for (const call of calls) {
    const target = resolveRosterTarget(roster, call.target);
    if (!target) {
      send("agent_error", { target: call.target, message: "unknown target" });
      continue;
    }
    send("agent_dispatch", {
      from: fromBot.id,
      fromName: fromBot.name,
      to: target.id,
      toName: target.name,
      toIcon: target.icon,
      message: call.message.slice(0, 200),
    });
    const item = await deliverMessageAgent(userEmail, fromBot, target, call.message, env, signal);
    send("agent_result", {
      from: fromBot.id,
      to: target.id,
      toName: target.name,
      status: item.status,
      replyPreview: (item.reply || "").slice(0, 300),
    });
  }
  return stripMessageAgentMarkers(fullText);
}

async function handleSpecialistChat(
  userEmail: string,
  bot: any,
  messages: any[],
  systemPrompt: string,
  roster: RosterBot[],
  env: Env,
  signal: AbortSignal
): Promise<Response> {
  return sseStream(async (send, close) => {
    const hermesMessages = [{ role: "system", content: systemPrompt }, ...messages];
    let full = "";
    try {
      full = await streamAndCollect(
        { model: "hermes-agent", messages: hermesMessages, user: userEmail },
        env,
        signal,
        (t) => send("token", { content: t })
      );
    } catch (e: any) {
      send("error", { message: e.message });
      close();
      return;
    }
    const clean = await processMessageAgentCalls(userEmail, bot, full, roster, env, signal, send);
    const lastUser = messages[messages.length - 1];
    await appendToBotSession(
      userEmail,
      bot.id,
      [
        { role: "user", content: typeof lastUser?.content === "string" ? lastUser.content : "(msg)", id: crypto.randomUUID(), ts: Date.now() },
        { role: "assistant", content: clean, id: crypto.randomUUID(), ts: Date.now() },
      ],
      env,
      { botName: bot.name }
    );
    send("final", { content: clean });
    send("done", {});
    close();
  });
}

async function handleMentionDispatch(
  userEmail: string,
  bot: any,
  mentions: RosterBot[],
  userQuery: string,
  messages: any[],
  env: Env,
  signal: AbortSignal,
  roster: RosterBot[]
): Promise<Response> {
  return sseStream(async (send, close) => {
    send("thinking", { label: `Routing @mention to ${mentions.map((m) => m.name).join(", ")}…` });
    const system = await buildSystemPrompt(userEmail, bot, userQuery, env, roster);
    const ackPrompt =
      system +
      `\n\nThe user @mentioned other bot(s). Briefly acknowledge you'll route their request, then call message_agent for each mentioned bot with a clear task. Mentions: ${mentions
        .map((m) => `@${m.handle} (${m.name})`)
        .join(", ")}.`;
    let full = "";
    try {
      full = await streamAndCollect(
        {
          model: "hermes-agent",
          messages: [{ role: "system", content: ackPrompt }, ...messages],
          user: userEmail,
        },
        env,
        signal,
        (t) => send("token", { content: t })
      );
    } catch (e: any) {
      for (const m of mentions) {
        send("agent_dispatch", { from: bot.id, to: m.id, toName: m.name, message: userQuery.slice(0, 200) });
        const item = await deliverMessageAgent(userEmail, bot, m, userQuery, env, signal);
        send("agent_result", { to: m.id, toName: m.name, status: item.status, replyPreview: (item.reply || "").slice(0, 300) });
      }
      send("final", { content: `Routed to ${mentions.map((m) => m.name).join(", ")}.` });
      send("done", {});
      close();
      return;
    }
    let clean = await processMessageAgentCalls(userEmail, bot, full, roster, env, signal, send);
    const calls = parseMessageAgentCalls(full);
    if (!calls.length) {
      const stripped = userQuery.replace(/@[\w.-]+/g, "").trim() || userQuery;
      for (const m of mentions) {
        send("agent_dispatch", { from: bot.id, to: m.id, toName: m.name, message: stripped.slice(0, 200) });
        const item = await deliverMessageAgent(userEmail, bot, m, stripped, env, signal);
        send("agent_result", { to: m.id, toName: m.name, status: item.status, replyPreview: (item.reply || "").slice(0, 300) });
      }
      if (!clean.trim()) clean = `Routed to ${mentions.map((m) => m.name).join(", ")}.`;
    }
    await appendToBotSession(
      userEmail,
      bot.id,
      [
        { role: "user", content: userQuery, id: crypto.randomUUID(), ts: Date.now() },
        { role: "assistant", content: clean, id: crypto.randomUUID(), ts: Date.now() },
      ],
      env,
      { botName: bot.name }
    );
    send("final", { content: clean });
    send("done", {});
    close();
  });
}

async function handleGroupChat(
  userEmail: string,
  group: GroupRoom,
  groups: GroupRoom[],
  text: string,
  env: Env,
  signal: AbortSignal
): Promise<Response> {
  return sseStream(async (send, close) => {
    const roster = await buildRoster(userEmail, env);
    const members = group.memberBotIds
      .map((id) => roster.find((b) => b.id === id))
      .filter(Boolean) as RosterBot[];

    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
      speaker: "you",
    };
    group.messages.push(userMsg);
    send("group_user", userMsg);

    const mentioned = extractMentions(text, members);
    const speakers = mentioned.length ? mentioned : members;

    const recent = group.messages.slice(-12).map((m: any) => {
      const who = m.speaker || m.role;
      return `${who}: ${typeof m.content === "string" ? m.content : ""}`;
    }).join("\n");

    for (const speaker of speakers) {
      send("group_typing", { botId: speaker.id, botName: speaker.name, botIcon: speaker.icon });
      const bot = await resolveBotAny(userEmail, speaker.id, env);
      if (!bot) continue;
      const others = members.filter((m) => m.id !== speaker.id).map((m) => `@${m.handle || botHandle(m.name)} (${m.name})`).join(", ");
      const system =
        (bot.system || "You are a helpful assistant.") +
        `\n\n## Group room: ${group.name}\nYou are ${bot.name} (@${bot.handle || botHandle(bot.name)}). Other members: ${others}.\nRespond in character. Keep it concise. You may @mention others.\n\n## Recent conversation\n${recent}`;
      let reply = "";
      try {
        reply = await collectHermesText(
          {
            model: "hermes-agent",
            messages: [
              { role: "system", content: system },
              { role: "user", content: text },
            ],
          },
          env,
          signal
        );
      } catch (e: any) {
        reply = `(${speaker.name} failed: ${e.message})`;
      }
      const clean = stripMessageAgentMarkers(reply);
      const botMsg = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: clean,
        ts: Date.now(),
        speaker: speaker.name,
        botId: speaker.id,
        botIcon: speaker.icon,
        avatar: speaker.avatar,
      };
      group.messages.push(botMsg);
      send("group_bot", botMsg);
    }

    group.messages = group.messages.slice(-100);
    group.updatedAt = Date.now();
    const gidx = groups.findIndex((g) => g.id === group.id);
    if (gidx >= 0) groups[gidx] = group;
    await saveGroups(userEmail, groups, env);
    send("done", { groupId: group.id });
    close();
  });
}

// ── Chief of Staff handler (delegation + message_agent) ─────
async function handleChief(
  messages: any[],
  specialists: any[],
  env: Env,
  signal: AbortSignal,
  ctx?: { userEmail: string; bot: any; roster: RosterBot[] }
): Promise<Response> {
  return sseStream(async (send, close) => {
    try {
      send("thinking", { step: 1, label: "Analyzing request…" });

      const lastUserMsg = messages[messages.length - 1];
      const userQuery = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "(multimodal)";
      const userEmail = ctx?.userEmail || "";
      const chiefBot = ctx?.bot;
      const roster = ctx?.roster || specialists;

      if (chiefBot && userEmail) {
        const mentions = extractMentions(userQuery, roster.filter((b: any) => b.id !== chiefBot.id));
        if (mentions.length) {
          const itemReplies: string[] = [];
          for (const m of mentions) {
            send("agent_dispatch", { from: chiefBot.id, to: m.id, toName: m.name, toIcon: m.icon, message: userQuery.slice(0, 200) });
            const item = await deliverMessageAgent(userEmail, chiefBot, m, userQuery, env, signal);
            send("agent_result", { to: m.id, toName: m.name, status: item.status, replyPreview: (item.reply || "").slice(0, 400) });
            if (item.reply) itemReplies.push(`**${m.name}:** ${item.reply}`);
          }
          const summary = itemReplies.length
            ? `Routed to ${mentions.map((m) => m.name).join(", ")}.\n\n${itemReplies.join("\n\n")}`
            : `Routed to ${mentions.map((m) => m.name).join(", ")}.`;
          send("token", { content: summary });
          send("final", { content: summary });
          send("done", {});
          close();
          return;
        }
      }

      const botList = specialists.map((b: any) => `- ${b.id} / @${b.handle || botHandle(b.name)} (${b.name}): ${b.description}`).join("\n");
      const decisionPrompt = `You are the Chief of Staff. Decide how to handle this request.

Available specialists:
${botList}

User request: "${userQuery.slice(0, 500)}"

Respond with JSON ONLY:
{
  "action": "direct" | "delegate",
  "botId": "id-or-handle-if-delegating",
  "reasoning": "one short sentence"
}

Rules:
- Greetings/chitchat/simple questions → "action": "direct"
- Domain-specific (coding, writing, etc.) → "action": "delegate"
- Complex multi-part → pick the MOST relevant specialist`;

      const decisionText = await collectHermesText({
        model: "hermes-agent",
        messages: [
          { role: "system", content: "You output only valid JSON, no prose." },
          { role: "user", content: decisionPrompt },
        ],
      }, env, signal);

      let decision: any = { action: "direct", reasoning: "fallback" };
      try {
        const jsonMatch = decisionText.match(/\{[\s\S]*\}/);
        if (jsonMatch) decision = JSON.parse(jsonMatch[0]);
      } catch {}

      const resolved = decision.botId
        ? specialists.find((b: any) => b.id === decision.botId) ||
          resolveRosterTarget(specialists as RosterBot[], decision.botId)
        : null;
      if (decision.action === "delegate" && !resolved) decision.action = "direct";

      let delegatedResponse = "";
      let delegatedBot: any = null;

      if (decision.action === "delegate" && resolved) {
        delegatedBot = resolved;
        send("delegate", {
          step: 2, botId: delegatedBot.id, botName: delegatedBot.name,
          botIcon: delegatedBot.icon, query: userQuery, reasoning: decision.reasoning,
        });

        const fullBot = userEmail ? await resolveBotAny(userEmail, delegatedBot.id, env) : delegatedBot;
        const specialistSystem = userEmail && fullBot
          ? await buildSystemPrompt(userEmail, fullBot, userQuery, env, roster as RosterBot[])
          : (delegatedBot.system || "You are a helpful specialist.");

        delegatedResponse = await collectHermesText({
          model: "hermes-agent",
          messages: [{ role: "system", content: specialistSystem }, ...messages.filter((m: any) => m.role !== "system")],
        }, env, signal);

        send("bot_response", {
          step: 3, botId: delegatedBot.id, botName: delegatedBot.name,
          botIcon: delegatedBot.icon, content: delegatedResponse,
        });
      }

      send("synthesizing", { step: 4, label: "Synthesizing final answer…" });

      const synthesisMessages = [
        {
          role: "system",
          content: `You are the Chief of Staff. ${
            delegatedBot
              ? `You delegated to ${delegatedBot.name} for: "${userQuery.slice(0, 300)}". Their response:\n\n---\n${delegatedResponse}\n---\n\nSynthesize a final answer. Concise. You may call message_agent(target, "follow-up") if another bot should act.`
              : `Answer this user request directly:\n\n${userQuery}`
          }${chiefBot ? buildRosterBlock(roster as RosterBot[], chiefBot.id) : ""}`,
        },
        ...messages.filter((m: any) => m.role !== "system"),
      ];

      let fullText = await streamAndCollect(
        { model: "hermes-agent", messages: synthesisMessages },
        env,
        signal,
        (t) => send("token", { content: t })
      );

      if (chiefBot && userEmail) {
        fullText = await processMessageAgentCalls(userEmail, chiefBot, fullText, roster as RosterBot[], env, signal, send);
        await appendToBotSession(
          userEmail,
          chiefBot.id,
          [
            { role: "user", content: userQuery, id: crypto.randomUUID(), ts: Date.now() },
            { role: "assistant", content: fullText, id: crypto.randomUUID(), ts: Date.now() },
          ],
          env,
          { botName: chiefBot.name }
        );
      } else {
        fullText = stripMessageAgentMarkers(fullText);
      }

      send("final", { content: fullText, delegatedTo: delegatedBot?.id });
      send("done", {});
      close();
    } catch (e: any) {
      if (e?.name !== "AbortError") send("error", { message: e.message });
      close();
    }
  });
}
