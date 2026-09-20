/**
 * Desktop Bot Mode parity layer for Hermes Bot Web.
 *
 * Implements the Shape A surface from Hermes v0.21.0:
 *   - Deterministic blob avatars
 *   - Canonical Bot Chat sessions (server-side)
 *   - Roster + description routing surface
 *   - message_agent (fire-and-forget bot-to-bot)
 *   - Routines (bot-namespaced cron-like jobs)
 *   - Group rooms (2–6 bots + user, serial rounds, @mentions)
 */

/** Minimal Env surface used by botmode KV helpers (avoids circular import). */
export interface Env {
  CACHE: KVNamespace;
}

// ── Types ───────────────────────────────────────────────
export interface RosterBot {
  id: string;
  name: string;
  icon: string;
  description: string;
  system?: string;
  templateId?: string;
  avatar: string; // data:image/svg+xml
  handle: string; // @slug
  hidden?: boolean;
  order?: number;
}

export interface ChatSession {
  id: string;
  botId: string;
  title: string;
  messages: any[];
  canonical: boolean;
  createdAt: number;
  updatedAt: number;
  compactedAt?: number;
}

export interface Routine {
  id: string;
  botId: string;
  botName: string;
  name: string; // display; full name is [bot:<botName>] <name>
  prompt: string;
  schedule: string; // cron expr or "manual"
  enabled: boolean;
  continuity: boolean;
  lastRunAt?: number;
  lastOutput?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupRoom {
  id: string;
  name: string;
  memberBotIds: string[]; // 2–6
  messages: any[];
  createdAt: number;
  updatedAt: number;
}

export interface InboxItem {
  id: string;
  fromBotId: string;
  fromBotName: string;
  fromBotIcon: string;
  toBotId: string;
  message: string;
  reply?: string;
  status: "pending" | "delivered" | "replied" | "error";
  createdAt: number;
  repliedAt?: number;
}

// ── Avatar (deterministic blob face) ────────────────────
const PALETTE = [
  ["#6c8aff", "#3d5aec"],
  ["#34d399", "#059669"],
  ["#f472b6", "#db2777"],
  ["#fbbf24", "#d97706"],
  ["#a78bfa", "#7c3aed"],
  ["#fb7185", "#e11d48"],
  ["#22d3ee", "#0891b2"],
  ["#fb923c", "#ea580c"],
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function botHandle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "bot";
}

/** Deterministic SVG blob avatar derived from name — Desktop Bot Mode style. */
export function blobAvatar(name: string, icon?: string): string {
  const h = hashStr(name || "bot");
  const [c1, c2] = PALETTE[h % PALETTE.length];
  const r1 = 28 + (h % 10);
  const r2 = 22 + ((h >> 4) % 12);
  const cx = 40 + ((h >> 8) % 20) - 10;
  const cy = 38 + ((h >> 12) % 16) - 8;
  const eyeY = 42 + ((h >> 16) % 6);
  const eyeSpread = 10 + ((h >> 20) % 6);
  const label = (icon && icon.length <= 2 ? icon : (name || "?").trim().charAt(0).toUpperCase()) || "✦";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="80" height="80" rx="28" fill="#0a0a0c"/>
  <circle cx="${cx}" cy="${cy}" r="${r1}" fill="url(#g)" opacity="0.95"/>
  <circle cx="${cx + 8}" cy="${cy - 6}" r="${r2}" fill="${c1}" opacity="0.35"/>
  <circle cx="${40 - eyeSpread}" cy="${eyeY}" r="3.2" fill="#0a0a0c"/>
  <circle cx="${40 + eyeSpread}" cy="${eyeY}" r="3.2" fill="#0a0a0c"/>
  <text x="40" y="68" text-anchor="middle" font-size="14" fill="white" font-family="system-ui,sans-serif" opacity="0.9">${escapeXml(label)}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

export function enrichBot(b: any): RosterBot {
  const name = b.name || "Bot";
  return {
    id: b.id,
    name,
    icon: b.icon || "✦",
    description: b.description || "",
    system: b.system,
    templateId: b.templateId,
    avatar: b.avatar || blobAvatar(name, b.icon),
    handle: b.handle || botHandle(name),
    hidden: !!b.hidden,
    order: typeof b.order === "number" ? b.order : 0,
  };
}

// ── KV helpers ──────────────────────────────────────────
async function kvGet<T>(env: Env, key: string, fallback: T): Promise<T> {
  const raw = await env.CACHE.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
async function kvPut(env: Env, key: string, value: any, ttlDays = 365): Promise<void> {
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: 60 * 60 * 24 * ttlDays });
}

// Sessions
export async function getBotSessions(email: string, botId: string, env: Env): Promise<ChatSession[]> {
  return kvGet<ChatSession[]>(env, `sessions:${email}:${botId}`, []);
}
export async function saveBotSessions(email: string, botId: string, sessions: ChatSession[], env: Env): Promise<void> {
  await kvPut(env, `sessions:${email}:${botId}`, sessions.slice(0, 40));
}
export async function ensureCanonicalSession(email: string, botId: string, botName: string, env: Env): Promise<ChatSession> {
  const all = await getBotSessions(email, botId, env);
  let canon = all.find((s) => s.canonical);
  if (!canon) {
    canon = {
      id: `canon_${botId}`,
      botId,
      title: `${botName} · Bot Chat`,
      messages: [],
      canonical: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    all.unshift(canon);
    await saveBotSessions(email, botId, all, env);
  }
  return canon;
}
export async function compactCanonical(email: string, botId: string, env: Env): Promise<ChatSession | null> {
  const all = await getBotSessions(email, botId, env);
  const canon = all.find((s) => s.canonical);
  if (!canon) return null;
  // Desktop: /new → compact (keep identity, drop messages)
  canon.messages = [];
  canon.title = canon.title.replace(/ · compacted.*$/, "") + " · compacted";
  canon.compactedAt = Date.now();
  canon.updatedAt = Date.now();
  await saveBotSessions(email, botId, all, env);
  return canon;
}
export async function appendToBotSession(
  email: string,
  botId: string,
  messages: any[],
  env: Env,
  opts?: { title?: string; createIfMissing?: boolean; botName?: string }
): Promise<ChatSession> {
  const all = await getBotSessions(email, botId, env);
  let session = all.find((s) => s.canonical) || all[0];
  if (!session) {
    session = {
      id: `canon_${botId}`,
      botId,
      title: opts?.title || `${opts?.botName || "Bot"} · Bot Chat`,
      messages: [],
      canonical: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    all.unshift(session);
  }
  session.messages.push(...messages);
  // Keep last 80 messages
  if (session.messages.length > 80) session.messages = session.messages.slice(-80);
  session.updatedAt = Date.now();
  if (opts?.title) session.title = opts.title;
  const idx = all.findIndex((s) => s.id === session!.id);
  if (idx >= 0) all[idx] = session; else all.unshift(session);
  await saveBotSessions(email, botId, all, env);
  return session;
}

// Routines
export async function getRoutines(email: string, env: Env): Promise<Routine[]> {
  return kvGet<Routine[]>(env, `routines:${email}`, []);
}
export async function saveRoutines(email: string, routines: Routine[], env: Env): Promise<void> {
  await kvPut(env, `routines:${email}`, routines.slice(0, 50));
}

// Groups
export async function getGroups(email: string, env: Env): Promise<GroupRoom[]> {
  return kvGet<GroupRoom[]>(env, `groups:${email}`, []);
}
export async function saveGroups(email: string, groups: GroupRoom[], env: Env): Promise<void> {
  await kvPut(env, `groups:${email}`, groups.slice(0, 20));
}

// Inbox (message_agent deliveries)
export async function getInbox(email: string, env: Env): Promise<InboxItem[]> {
  return kvGet<InboxItem[]>(env, `inbox:${email}`, []);
}
export async function saveInbox(email: string, items: InboxItem[], env: Env): Promise<void> {
  await kvPut(env, `inbox:${email}`, items.slice(0, 100));
}

// Roster meta (order / hidden)
export async function getRosterMeta(email: string, env: Env): Promise<Record<string, { order?: number; hidden?: boolean }>> {
  return kvGet(env, `roster_meta:${email}`, {});
}
export async function saveRosterMeta(email: string, meta: Record<string, any>, env: Env): Promise<void> {
  await kvPut(env, `roster_meta:${email}`, meta);
}

// ── message_agent protocol ──────────────────────────────
export function buildRosterBlock(roster: RosterBot[], selfId: string): string {
  const peers = roster.filter((b) => b.id !== selfId && !b.hidden);
  if (peers.length === 0) return "";
  const lines = peers.map((b) => `- @${b.handle} (${b.name}): ${b.description || "no description"} [id=${b.id}]`).join("\n");
  return `
## Bot Mode protocol (message_agent)
You can message other bots on the roster with a fire-and-forget handoff.
When you need another specialist, end your reply with EXACTLY one line in this form (no other text on that line):

MESSAGE_AGENT: {"target":"<handle-or-id>","message":"<your composed request>"}

Rules:
- Validate target against the roster below. Unknown target = do not emit MESSAGE_AGENT.
- Compose your own message; never forward the user verbatim.
- Sender attribution is automatic. Recipient sees: Message from 🤖 <you>.
- Fire-and-forget: finish your turn; the reply arrives later as a background completion.
- Prefer answering yourself when you can. Use MESSAGE_AGENT only when a peer is clearly better.

Live roster:
${lines}
`;
}

export function parseMessageAgentCalls(text: string): Array<{ target: string; message: string }> {
  const out: Array<{ target: string; message: string }> = [];
  const re = /MESSAGE_AGENT:\s*(\{[\s\S]*?\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      if (j.target && j.message) out.push({ target: String(j.target), message: String(j.message) });
    } catch {}
  }
  // Also accept fenced tool-call style
  const re2 = /message_agent\s*\(\s*target\s*=\s*["']([^"']+)["']\s*,\s*message\s*=\s*["']([\s\S]*?)["']\s*\)/gi;
  while ((m = re2.exec(text)) !== null) {
    out.push({ target: m[1], message: m[2] });
  }
  return out;
}

export function stripMessageAgentMarkers(text: string): string {
  return text
    .replace(/MESSAGE_AGENT:\s*\{[\s\S]*?\}/g, "")
    .replace(/message_agent\s*\([\s\S]*?\)/gi, "")
    .trim();
}

export function resolveRosterTarget(roster: RosterBot[], target: string): RosterBot | null {
  const t = target.replace(/^@/, "").toLowerCase().trim();
  return (
    roster.find((b) => b.id.toLowerCase() === t) ||
    roster.find((b) => b.handle.toLowerCase() === t) ||
    roster.find((b) => botHandle(b.name) === t) ||
    roster.find((b) => b.name.toLowerCase() === t) ||
    null
  );
}

/** Detect @mentions in user text for group routing. */
export function extractMentions(text: string, roster: RosterBot[]): RosterBot[] {
  const found: RosterBot[] = [];
  const re = /@([a-z0-9][a-z0-9_-]{0,31})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hit = resolveRosterTarget(roster, m[1]);
    if (hit && !found.find((b) => b.id === hit.id)) found.push(hit);
  }
  return found;
}

export function routineFullName(botName: string, name: string): string {
  return `[bot:${botName}] ${name}`;
}
