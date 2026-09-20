/**
 * Hermes Bot Web — Worker with Chief of Staff + Templates + Memory + KB
 *
 * Architecture:
 *   Browser → Worker (FRA POP via Smart Placement)
 *     → 1. Validate CF Access JWT
 *     → 2. /api/bot-templates — public list of templates
 *     → 3. /api/bots/* — CRUD bot definitions (KV per user)
 *     → 4. /api/bots/:id/memory — memory entries per bot
 *     → 5. /api/bots/:id/kb — knowledge base docs per bot
 *     → 6. /api/chat — chat with bot (Chief or specialist), injects memory + KB
 */

import { jwtVerify, createRemoteJWKSet } from "jose";
import { BOT_TEMPLATES, getTemplate, BotTemplate } from "./templates";

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

async function verifyAccessJwt(token: string, env: Env): Promise<{ email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getJWKS(env.CF_ACCESS_TEAM), { audience: env.CF_ACCESS_AUD });
    return { email: (payload.email as string) || "unknown" };
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
  const jwt = extractJwt(req);
  const cookieHeader = req.headers.get("Cookie") || req.headers.get("cookie") || "";
  const hasCookie = /CF_Authorization\s*=/i.test(cookieHeader);
  if (jwt) {
    const user = await verifyAccessJwt(jwt, env);
    if (user) return user;
  }
  if (hasCookie) return { email: "authenticated@user" };
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
      return Array.isArray(userBots) ? userBots : [];
    } catch {}
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

// Build the system prompt: bot's prompt + memory + KB context
async function buildSystemPrompt(
  userEmail: string,
  bot: any,
  userQuery: string,
  env: Env
): Promise<string> {
  let prompt = bot.system;

  // Add memory
  const memory = await getMemory(userEmail, bot.id, env);
  if (memory.length > 0) {
    prompt += `\n\n## Memory\n${memory.map((m: any) => `- ${m.content}`).join("\n")}`;
  }

  // Add KB context (if bot has kb_search tool or KB docs exist)
  const kb = await getKB(userEmail, bot.id, env);
  if (kb.length > 0 && (bot.tools?.includes("kb_search") || true)) {
    const relevant = searchKB(userQuery, kb);
    if (relevant.length > 0) {
      prompt += `\n\n## Relevant context from your knowledge base:\n`;
      for (const doc of relevant) {
        // Truncate to fit context window
        const content = doc.content.length > 2000 ? doc.content.slice(0, 2000) + "…" : doc.content;
        prompt += `\n### ${doc.title}\n${content}\n`;
      }
    }
  }

  // Add tool hints
  if (bot.tools?.length > 0) {
    prompt += `\n\n## Available tools: ${bot.tools.join(", ")}`;
  }

  return prompt;
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
      const newBot = {
        id,
        templateId: body.templateId || null,
        name: String(body.name || "Unnamed Bot").slice(0, 50),
        icon: String(body.icon || "✦").slice(0, 4),
        description: String(body.description || "").slice(0, 200),
        system: String(body.system || "You are a helpful assistant.").slice(0, 4000),
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 20) : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        builtin: false,
      };
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

    // ── /api/chat POST ──
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { error, user } = await requireAuth();
      if (error) return error;
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const { messages, bot_id } = body;
      if (!Array.isArray(messages) || messages.length === 0) return json({ error: "no_messages" }, 400);
      const userEmail = user!.email;

      // Resolve bot (user-created or fallback to template directly)
      let bot = null;
      const userBots = await getUserBots(userEmail, env);
      bot = userBots.find((b: any) => b.id === bot_id);

      if (!bot) {
        // Try template (so users can chat with un-instantiated templates)
        const tpl = getTemplate(bot_id);
        if (tpl) {
          bot = {
            id: tpl.id,
            name: tpl.name,
            icon: tpl.icon,
            description: tpl.description,
            system: tpl.system,
            tools: tpl.tools,
          };
        }
      }

      if (!bot) return json({ error: "bot_not_found" }, 404);

      // CHIEF MODE
      if (bot.id === "tmpl_chief" || bot.id === "bot_starter_chief") {
        // Build list of available specialists (templates + user bots)
        const allSpecialists = [
          ...BOT_TEMPLATES.filter(t => t.id !== "tmpl_chief" && t.id !== "tmpl_blank").map(t => ({
            id: t.id, name: t.name, icon: t.icon, description: t.description, system: t.system,
          })),
          ...userBots.filter((b: any) => b.id !== bot.id).map((b: any) => ({
            id: b.id, name: b.name, icon: b.icon, description: b.description, system: b.system,
          })),
        ];
        return await handleChief(messages, allSpecialists, env, req.signal);
      }

      // SPECIALIST MODE — inject memory + KB into system prompt
      const lastUserMsg = messages[messages.length - 1];
      const userQuery = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
      const systemPrompt = await buildSystemPrompt(userEmail, bot, userQuery, env);

      const hermesMessages = [
        { role: "system", content: systemPrompt },
        ...messages,
      ];
      try {
        const res = await streamHermes({ model: "hermes-agent", messages: hermesMessages, user: userEmail }, env, req.signal);
        if (!res.ok || !res.body) return json({ error: "hermes_error", status: res.status }, 502);
        return new Response(res.body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS_HEADERS },
        });
      } catch (e: any) {
        return json({ error: "hermes_failed", message: e.message }, 502);
      }
    }

    // Static UI
    try {
      const r = await env.ASSETS.fetch(req);
      if (r.ok) return r;
    } catch {}
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

// ── Chief of Staff handler (sequential delegation) ─────
async function handleChief(messages: any[], specialists: any[], env: Env, signal: AbortSignal): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        try { controller.enqueue(encoder.encode(sseEvent(event, data))); } catch {}
      };
      try {
        send("thinking", { step: 1, label: "Analyzing request…" });

        const lastUserMsg = messages[messages.length - 1];
        const userQuery = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "(multimodal)";

        const botList = specialists.map(b => `- ${b.id} (${b.name}): ${b.description}`).join("\n");
        const decisionPrompt = `You are the Chief of Staff. Decide how to handle this request.

Available specialists:
${botList}

User request: "${userQuery.slice(0, 500)}"

Respond with JSON ONLY:
{
  "action": "direct" | "delegate",
  "botId": "name-of-bot-if-delegating",
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

        if (decision.action === "delegate" && !specialists.find(b => b.id === decision.botId)) {
          decision.action = "direct";
        }

        let delegatedResponse = "";
        let delegatedBot: any = null;

        if (decision.action === "delegate" && decision.botId) {
          delegatedBot = specialists.find(b => b.id === decision.botId);
          send("delegate", {
            step: 2, botId: delegatedBot.id, botName: delegatedBot.name,
            botIcon: delegatedBot.icon, query: userQuery, reasoning: decision.reasoning,
          });

          const botMessages = [
            { role: "system", content: delegatedBot.system },
            ...messages,
          ];
          delegatedResponse = await collectHermesText({
            model: "hermes-agent", messages: botMessages,
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
            content: `You are the Chief of Staff. ${delegatedBot ? `You delegated to ${delegatedBot.name} for: "${userQuery.slice(0, 300)}". Their response:\n\n---\n${delegatedResponse}\n---\n\nNow synthesize a final answer for the user. Incorporate the specialist's response, add your own analysis or commentary if helpful, and keep it concise.` : `Answer this user request directly:\n\n${userQuery}`}`,
          },
          ...messages.filter(m => m.role !== "system"),
        ];

        const synthRes = await streamHermes({
          model: "hermes-agent", messages: synthesisMessages,
        }, env, signal);

        if (!synthRes.ok || !synthRes.body) throw new Error(`Synthesis failed: ${synthRes.status}`);

        const reader = synthRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", fullText = "";

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
                if (d) {
                  fullText += d;
                  send("token", { content: d });
                }
              } catch {}
            }
          }
        }

        send("final", { content: fullText, delegatedTo: delegatedBot?.id });
        send("done", {});
      } catch (e: any) {
        if (e.name !== "AbortError") send("error", { message: e.message });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS_HEADERS },
  });
}
