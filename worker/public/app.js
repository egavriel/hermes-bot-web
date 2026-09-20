/**
 * Hermes Bot Web — Mobile Chat UI v5 (Templates + Memory + KB)
 *
 * Features:
 *   - 9 bot templates (Chief, Assistant, Code Mentor, Writer, Researcher, Data Analyst, Memory Curator, Knowledge Base, Blank)
 *   - Create bots FROM templates (with pre-seeded memory + KB)
 *   - Per-bot Memory (KV-backed, surfaced in chat context)
 *   - Per-bot Knowledge Base (upload txt/md, keyword-retrieved)
 *   - Multi-bot switcher with template gallery
 *   - Multi-session drawer
 *   - Voice input, image upload, PWA, markdown
 *
 * No framework. Direct DOM.
 */

const $app = document.getElementById("app");

// ── Icon catalog ────────────────────────────────────────
const ICON_OPTIONS = [
  "✦", "✺", "⌘", "✎", "◆", "●", "▲", "■", "★", "♦", "♢",
  "⚔️", "🧠", "📚", "📊", "🔍", "💡", "⚙", "⚡", "✨", "🚀",
  "👁", "🎯", "🔥", "💎", "🌟", "🎨", "🔧", "🛡",
];

// ── Storage helpers (sessions only — bots/memory/KB come from server) ──
const LS = {
  sessions: (botId) => `hermes.sessions.${botId}`,
  current: (botId) => `hermes.current.${botId}`,
  botId: () => `hermes.bot_id`,
};
const loadSessions = (botId) => { try { return JSON.parse(localStorage.getItem(LS.sessions(botId)) || "[]"); } catch { return []; } };
const saveSessions = (botId, s) => { try { localStorage.setItem(LS.sessions(botId), JSON.stringify(s)); } catch {} };
const newSession = (botId, messages = []) => {
  const firstUser = messages.find(m => m.role === "user");
  let title = "New chat";
  if (firstUser) {
    const text = typeof firstUser.content === "string" ? firstUser.content : "(attachment)";
    title = text.slice(0, 50) + (text.length > 50 ? "…" : "");
  }
  return { id: crypto.randomUUID(), botId, title, messages, createdAt: Date.now(), updatedAt: Date.now() };
};
const upsertSession = (s) => {
  const all = loadSessions(s.botId);
  const idx = all.findIndex(x => x.id === s.id);
  s.updatedAt = Date.now();
  if (idx >= 0) all[idx] = s; else all.unshift(s);
  saveSessions(s.botId, all.slice(0, 50));
};
const deleteSession = (botId, sid) => saveSessions(botId, loadSessions(botId).filter(s => s.id !== sid));
const getCurrentSessionId = (botId) => localStorage.getItem(LS.current(botId));
const setCurrentSessionId = (botId, id) => localStorage.setItem(LS.current(botId), id);

// ── API helpers ────────────────────────────────────────
const api = {
  async bots() {
    const r = await fetch("/api/bots", { credentials: "include" });
    if (!r.ok) throw new Error(`bots: ${r.status}`);
    return r.json();
  },
  async createBot(body) {
    const r = await fetch("/api/bots", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`createBot: ${r.status}`);
    return r.json();
  },
  async updateBot(id, body) {
    const r = await fetch(`/api/bots/${id}`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`updateBot: ${r.status}`);
    return r.json();
  },
  async deleteBot(id) {
    const r = await fetch(`/api/bots/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok) throw new Error(`deleteBot: ${r.status}`);
    return r.json();
  },
  async memory(botId) {
    const r = await fetch(`/api/bots/${botId}/memory`, { credentials: "include" });
    return r.ok ? r.json() : { memory: [] };
  },
  async addMemory(botId, content, category) {
    const r = await fetch(`/api/bots/${botId}/memory`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, category }),
    });
    if (!r.ok) throw new Error(`addMemory: ${r.status}`);
    return r.json();
  },
  async deleteMemory(botId, memId) {
    const r = await fetch(`/api/bots/${botId}/memory/${memId}`, { method: "DELETE", credentials: "include" });
    return r.ok ? r.json() : { memory: [] };
  },
  async kb(botId) {
    const r = await fetch(`/api/bots/${botId}/kb`, { credentials: "include" });
    return r.ok ? r.json() : { docs: [] };
  },
  async addKB(botId, title, content) {
    const r = await fetch(`/api/bots/${botId}/kb`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    if (!r.ok) throw new Error(`addKB: ${r.status}`);
    return r.json();
  },
  async deleteKB(botId, docId) {
    const r = await fetch(`/api/bots/${botId}/kb/${docId}`, { method: "DELETE", credentials: "include" });
    return r.ok ? r.json() : { docs: [] };
  },
};

// ── State ───────────────────────────────────────────────
const state = {
  session: null,
  controller: null,
  isStreaming: false,
  currentBotId: localStorage.getItem(LS.botId()) || "bot_starter_chief",
  bots: [],
  templates: [],
  loaded: false,
  botsListOpen: false,
  drawerOpen: false,
  botEditorOpen: false,
  botEditorTab: "basics", // basics | memory | kb
  editingBot: null, // null = create new, {id, ...} = edit
  creatingFromTemplate: null, // template object being instantiated
};

// ── Markdown renderer ───────────────────────────────────
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  const codeBlocks = [];
  let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || "", code });
    return `\x00CODEBLOCK_${codeBlocks.length - 1}\x00`;
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  s = s.replace(/(?:^|\n)((?:[-*] .+\n?)+)/g, (_, b) => {
    const items = b.trim().split("\n").map(l => `<li>${l.replace(/^[-*] /, "")}</li>`).join("");
    return `\n<ul>${items}</ul>`;
  });
  s = s.replace(/(?:^|\n)((?:\d+\. .+\n?)+)/g, (_, b) => {
    const items = b.trim().split("\n").map(l => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
    return `\n<ol>${items}</ol>`;
  });
  s = s.split(/\n{2,}/).map(p => {
    if (p.startsWith("<h") || p.startsWith("<ul") || p.startsWith("<ol") || p.includes("\x00CODEBLOCK_")) return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  s = s.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, i) => {
    const { lang, code } = codeBlocks[parseInt(i)];
    return `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`;
  });
  return s;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (h < 24) return `${h}h`;
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}

// ── Render shell ────────────────────────────────────────
function renderShell() {
  $app.innerHTML = `
    <div class="scrim" id="scrim"></div>
    <header class="header">
      <button class="icon-btn drawer-btn" id="drawerBtn" type="button" aria-label="Open menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <button class="bot-switch" id="botSwitch" type="button" aria-label="Switch bot">
        <span class="bot-icon" id="botIcon"></span>
        <span class="bot-name" id="botName"></span>
        <span class="bot-caret">▾</span>
      </button>
      <div class="header-actions">
        <button class="icon-btn" id="newBotBtn" type="button" aria-label="New bot" title="New bot">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 5v3M12 16v3M5 12h3M16 12h3"/>
          </svg>
        </button>
        <button class="icon-btn" id="newChatBtn" type="button" aria-label="New chat" title="New chat">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <div class="status" title="Connection status">
          <div class="status-dot" id="statusDot"></div>
        </div>
      </div>
    </header>
    <aside class="drawer" id="drawer" aria-label="Conversations">
      <div class="drawer-header">
        <h2>Conversations</h2>
        <button class="icon-btn" id="closeDrawerBtn" type="button" aria-label="Close menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="drawer-list" id="drawerList"></div>
      <div class="drawer-footer">
        <div class="drawer-bot-info" id="drawerBotInfo"></div>
      </div>
    </aside>
    <div class="bot-list" id="botList" hidden></div>
    <div class="bot-editor" id="botEditor" hidden></div>
    <main class="messages" id="messages"></main>
    <!-- Floating chat input: collapsed = circle (FAB), expanded = pill with input -->
    <div class="chat-fab" id="chatFab">
      <form id="form">
        <button id="fabToggle" type="button" aria-label="Open chat input">
          <svg class="fab-icon-open" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <svg class="fab-icon-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <div class="fab-expanded">
          <div class="fab-attach-row" id="fabAttachRow"></div>
          <div class="fab-input-row">
            <button id="attachBtn" type="button" aria-label="Attach image" title="Attach image (or paste)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
              </svg>
            </button>
            <button id="micBtn" type="button" aria-label="Voice input" hidden title="Voice input">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            </button>
            <textarea id="input" rows="1" placeholder="Ask anything…"
              autocomplete="off" autocorrect="off" autocapitalize="sentences"
              spellcheck="true" enterkeyhint="send"></textarea>
            <button id="send" type="submit" aria-label="Send" disabled>
              <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
              <svg class="icon-stop" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  `;

  const $scrim = document.getElementById("scrim");
  const $input = document.getElementById("input");
  const $inputWrap = document.querySelector(".fab-input-row");
  const $send = document.getElementById("send");
  const $micBtn = document.getElementById("micBtn");
  const $newChatBtn = document.getElementById("newChatBtn");
  const $newBotBtn = document.getElementById("newBotBtn");
  const $form = document.getElementById("form");
  const $messages = document.getElementById("messages");
  const $statusDot = document.getElementById("statusDot");
  const $botSwitch = document.getElementById("botSwitch");
  const $botName = document.getElementById("botName");
  const $botIcon = document.getElementById("botIcon");
  const $botList = document.getElementById("botList");
  const $drawerBtn = document.getElementById("drawerBtn");
  const $drawer = document.getElementById("drawer");
  const $drawerList = document.getElementById("drawerList");
  const $closeDrawerBtn = document.getElementById("closeDrawerBtn");
  const $drawerBotInfo = document.getElementById("drawerBotInfo");
  const $botEditor = document.getElementById("botEditor");

  const assistantBubbles = new Map();

  // ── Bot loading ──
  async function loadBotsFromServer() {
    try {
      const data = await api.bots();
      state.bots = data.bots || [];
      state.templates = data.templates || [];
      state.loaded = true;
      // Validate current bot still exists
      const allIds = new Set([
        ...state.bots.map(b => b.id),
        ...state.templates.map(t => t.id),
      ]);
      if (!allIds.has(state.currentBotId)) {
        state.currentBotId = state.bots[0]?.id || "tmpl_assistant";
        localStorage.setItem(LS.botId(), state.currentBotId);
      }
      updateBotLabel();
    } catch (e) {
      console.error("Failed to load bots:", e);
    }
  }

  function currentBot() {
    return state.bots.find(b => b.id === state.currentBotId)
      || state.templates.find(t => t.id === state.currentBotId)
      || state.bots[0]
      || { id: "bot_starter_chief", name: "Chief of Staff", icon: "⚔️" };
  }

  function updateBotLabel() {
    const bot = currentBot();
    if (!bot) return;
    $botIcon.textContent = bot.icon;
    $botName.textContent = bot.name;
    $drawerBotInfo.innerHTML = `
      <span class="drawer-bot-icon">${bot.icon}</span>
      <div>
        <div class="drawer-bot-name">${escapeHtml(bot.name)}</div>
        <div class="drawer-bot-desc">${escapeHtml(bot.description || "")}</div>
      </div>
    `;
  }

  // ── Drawer ──
  function openDrawer() {
    state.drawerOpen = true;
    renderDrawerList();
    $drawer.classList.add("open");
    $scrim.classList.add("open");
  }
  function closeDrawer() {
    state.drawerOpen = false;
    $drawer.classList.remove("open");
    $scrim.classList.remove("open");
  }
  $drawerBtn.addEventListener("click", openDrawer);
  $closeDrawerBtn.addEventListener("click", closeDrawer);
  $scrim.addEventListener("click", () => {
    if (state.drawerOpen) closeDrawer();
    if (state.botsListOpen) closeBotList();
    if (state.botEditorOpen) closeBotEditor();
  });

  function renderDrawerList() {
    const sessions = loadSessions(state.currentBotId);
    if (sessions.length === 0) {
      $drawerList.innerHTML = `
        <div class="drawer-empty">
          <div class="drawer-empty-icon">✦</div>
          <p>No conversations yet</p>
          <p class="drawer-empty-sub">Tap + to start a new chat</p>
        </div>
      `;
      return;
    }
    $drawerList.innerHTML = sessions.map(s => `
      <div class="drawer-item ${s.id === state.session?.id ? "active" : ""}" data-session-id="${s.id}">
        <button class="drawer-item-main" type="button">
          <div class="drawer-item-title">${escapeHtml(s.title)}</div>
          <div class="drawer-item-meta">
            <span class="drawer-item-time">${relativeTime(s.updatedAt)}</span>
            <span class="drawer-item-count">${s.messages.filter(m => m.role === "user").length} msgs</span>
          </div>
        </button>
        <button class="drawer-item-delete" type="button" aria-label="Delete" data-session-id="${s.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-2 14H7L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `).join("");
    $drawerList.querySelectorAll(".drawer-item-main").forEach(($btn, i) => {
      $btn.addEventListener("click", () => {
        switchToSession(sessions[i]);
        closeDrawer();
      });
    });
    $drawerList.querySelectorAll(".drawer-item-delete").forEach($btn => {
      $btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sid = $btn.dataset.sessionId;
        if (confirm("Delete this conversation?")) {
          deleteSession(state.currentBotId, sid);
          if (state.session?.id === sid) startNewSession();
          renderDrawerList();
        }
      });
    });
  }

  // ── Bot switcher with templates gallery ──
  function renderBotList() {
    const customBots = state.bots;
    const builtins = state.templates;

    // User-created bots section (compact)
    let html = "";
    if (customBots.length > 0) {
      html += `<div class="bot-section-label">My bots</div>`;
      html += customBots.map(b => `
        <div class="bot-row-wrapper">
          <button class="bot-row ${b.id === state.currentBotId ? "active" : ""}" data-bot-id="${b.id}" data-action="switch" type="button">
            <span class="bot-icon">${b.icon}</span>
            <span class="bot-info">
              <span class="bot-row-name">${escapeHtml(b.name)}</span>
              <span class="bot-row-desc">${escapeHtml(b.description || "")}</span>
            </span>
            ${b.id === state.currentBotId ? '<span class="bot-check">✓</span>' : ""}
          </button>
          <button class="bot-row-edit" data-bot-id="${b.id}" data-action="edit" type="button" aria-label="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </button>
        </div>
      `).join("");
    }

    // Templates section (gallery with previews)
    html += `<div class="bot-section-label">Templates ${builtins.length}</div>`;
    html += builtins.map(t => `
      <div class="template-card" data-template-id="${t.id}">
        <div class="template-card-header">
          <span class="template-icon">${t.icon}</span>
          <div class="template-info">
            <div class="template-name">${escapeHtml(t.name)}</div>
            <div class="template-desc">${escapeHtml(t.description)}</div>
          </div>
        </div>
        <button class="template-use" data-template-id="${t.id}" data-action="use-template" type="button">
          Use template
        </button>
      </div>
    `).join("");

    // Blank / advanced
    html += `
      <button class="bot-create-btn" data-action="blank" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        Start blank
      </button>
    `;

    $botList.innerHTML = html;

    $botList.querySelectorAll("[data-action='switch']").forEach($row => {
      $row.addEventListener("click", () => {
        const newId = $row.dataset.botId;
        if (newId !== state.currentBotId) switchBot(newId);
        closeBotList();
      });
    });
    $botList.querySelectorAll("[data-action='edit']").forEach($btn => {
      $btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openBotEditor(null, $btn.dataset.botId);
      });
    });
    $botList.querySelectorAll("[data-action='use-template']").forEach($btn => {
      $btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tpl = state.templates.find(t => t.id === $btn.dataset.templateId);
        if (tpl) openBotEditor(tpl, null);
      });
    });
    $botList.querySelector("[data-action='blank']").addEventListener("click", () => {
      openBotEditor(null, null); // blank
    });
  }

  function openBotList() {
    state.botsListOpen = true;
    renderBotList();
    $botList.hidden = false;
    requestAnimationFrame(() => $botList.classList.add("open"));
  }
  function closeBotList() {
    state.botsListOpen = false;
    $botList.classList.remove("open");
    setTimeout(() => { $botList.hidden = true; }, 200);
  }
  $botSwitch.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.botsListOpen) closeBotList();
    else openBotList();
  });
  document.addEventListener("click", (e) => {
    if (!state.botsListOpen) return;
    if (!$botList.contains(e.target) && !$botSwitch.contains(e.target)) closeBotList();
  });

  // ── Bot editor (with Basics / Memory / KB tabs) ──
  async function openBotEditor(template, editBotId) {
    state.botEditorTab = "basics";
    state.creatingFromTemplate = template;
    state.editingBotId = editBotId;

    let bot;
    if (editBotId) {
      bot = state.bots.find(b => b.id === editBotId);
      if (!bot) return;
    } else if (template) {
      // Pre-fill from template
      bot = {
        name: template.name,
        icon: template.icon,
        description: template.description,
        system: template.system,
        tools: template.tools || [],
      };
    } else {
      // Blank
      bot = {
        name: "",
        icon: "✦",
        description: "",
        system: "You are a helpful assistant.",
        tools: [],
      };
    }

    const isEdit = !!editBotId;
    const isFromTemplate = !!template;

    $botEditor.innerHTML = `
      <div class="bot-editor-content">
        <div class="bot-editor-header">
          <button class="icon-btn" id="backEditorBtn" type="button" aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <h2>${isEdit ? "Edit bot" : (template ? "New from " + template.name : "New bot")}</h2>
          <button class="icon-btn" id="closeEditorBtn" type="button" aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="bot-editor-tabs">
          <button class="tab active" data-tab="basics" type="button">Basics</button>
          ${isEdit || isFromTemplate ? `<button class="tab" data-tab="memory" type="button">Memory</button>` : ""}
          ${isEdit || isFromTemplate ? `<button class="tab" data-tab="kb" type="button">Knowledge Base</button>` : ""}
        </div>
        <form id="botEditorForm" class="bot-editor-form">
          <div class="tab-panel active" data-panel="basics">
            <label class="field">
              <span class="field-label">Name</span>
              <input type="text" id="botName" maxlength="50" required placeholder="e.g. Email Drafter" value="${escapeHtml(bot.name || "")}" />
            </label>

            <div class="field">
              <span class="field-label">Icon</span>
              <div class="icon-picker" id="iconPicker"></div>
            </div>

            <label class="field">
              <span class="field-label">Description</span>
              <input type="text" id="botDesc" maxlength="200" placeholder="Short tagline shown in bot list" value="${escapeHtml(bot.description || "")}" />
            </label>

            <label class="field">
              <span class="field-label">System prompt</span>
              <textarea id="botSystem" rows="8" maxlength="4000" required placeholder="You are a…">${escapeHtml(bot.system || "You are a helpful assistant.")}</textarea>
              <span class="field-hint">Defines the bot's persona, capabilities, and behavior.</span>
            </label>

            <div class="bot-editor-actions">
              ${isEdit ? `<button type="button" class="btn-danger" id="deleteBotBtn">Delete</button>` : ""}
              <div class="spacer"></div>
              <button type="button" class="btn-secondary" id="cancelEditorBtn">Cancel</button>
              <button type="submit" class="btn-primary">${isEdit ? "Save" : "Create"}</button>
            </div>
          </div>

          ${isEdit || isFromTemplate ? `
          <div class="tab-panel" data-panel="memory">
            <p class="panel-hint">Memory entries are automatically included in the bot's context.</p>
            <div class="memory-list" id="memoryList"></div>
            <form id="addMemoryForm" class="add-memory-form">
              <textarea id="newMemoryContent" rows="2" maxlength="2000" placeholder="Add a memory entry (e.g., 'User prefers concise answers')" required></textarea>
              <select id="newMemoryCategory">
                <option value="fact">Fact</option>
                <option value="preference">Preference</option>
                <option value="context">Context</option>
              </select>
              <button type="submit" class="btn-primary">Add memory</button>
            </form>
          </div>
          ` : ""}

          ${isEdit || isFromTemplate ? `
          <div class="tab-panel" data-panel="kb">
            <p class="panel-hint">Knowledge base documents. Relevant passages are retrieved when the bot responds.</p>
            <div class="kb-list" id="kbList"></div>
            <form id="addKBForm" class="add-kb-form">
              <input type="text" id="newKBTitle" placeholder="Document title" maxlength="200" required />
              <input type="file" id="newKBFile" accept=".txt,.md,.markdown,.json,.csv" />
              <textarea id="newKBContent" rows="6" maxlength="100000" placeholder="Or paste document content here..."></textarea>
              <button type="submit" class="btn-primary">Add document</button>
            </form>
          </div>
          ` : ""}
        </form>
      </div>
    `;

    // Icon picker
    const $iconPicker = document.getElementById("iconPicker");
    const currentIcon = bot.icon || "✦";
    $iconPicker.innerHTML = ICON_OPTIONS.map(icon => `
      <button type="button" class="icon-option ${icon === currentIcon ? "selected" : ""}" data-icon="${icon}">${icon}</button>
    `).join("");
    $iconPicker.querySelectorAll(".icon-option").forEach($opt => {
      $opt.addEventListener("click", () => {
        $iconPicker.querySelectorAll(".icon-option").forEach(o => o.classList.remove("selected"));
        $opt.classList.add("selected");
      });
    });

    // Tabs
    $botEditor.querySelectorAll(".tab").forEach($tab => {
      $tab.addEventListener("click", () => {
        const tab = $tab.dataset.tab;
        state.botEditorTab = tab;
        $botEditor.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === $tab));
        $botEditor.querySelectorAll(".tab-panel").forEach(p => {
          p.classList.toggle("active", p.dataset.panel === tab);
        });
        // Lazy-load tab data
        if (tab === "memory") loadMemoryTab();
        if (tab === "kb") loadKBTab();
      });
    });

    // Handlers
    document.getElementById("closeEditorBtn").addEventListener("click", closeBotEditor);
    document.getElementById("cancelEditorBtn").addEventListener("click", closeBotEditor);
    document.getElementById("backEditorBtn").addEventListener("click", closeBotEditor);
    document.getElementById("botEditorForm").addEventListener("submit", handleEditorSubmit);

    if (isEdit) {
      document.getElementById("deleteBotBtn")?.addEventListener("click", handleEditorDelete);
      // Load memory + KB for existing bot
      loadMemoryTab();
      loadKBTab();
    } else if (isFromTemplate) {
      // After save, reload memory/KB
      // (Will be triggered after create)
    }

    $botEditor.hidden = false;
    requestAnimationFrame(() => $botEditor.classList.add("open"));
    closeBotList();
  }

  function closeBotEditor() {
    $botEditor.classList.remove("open");
    setTimeout(() => { $botEditor.hidden = true; }, 200);
    state.editingBotId = null;
    state.creatingFromTemplate = null;
  }

  // ── Memory tab ──
  async function loadMemoryTab() {
    if (!state.editingBotId) return;
    const $list = document.getElementById("memoryList");
    if (!$list) return;
    try {
      const { memory } = await api.memory(state.editingBotId);
      if (memory.length === 0) {
        $list.innerHTML = `<div class="list-empty">No memory yet. Add entries below.</div>`;
      } else {
        $list.innerHTML = memory.map(m => `
          <div class="memory-item" data-id="${m.id}">
            <div class="memory-content">${escapeHtml(m.content)}</div>
            <div class="memory-meta">
              <span class="memory-category">${escapeHtml(m.category || "fact")}</span>
              <span class="memory-date">${relativeTime(m.createdAt)}</span>
              <button class="memory-delete" data-id="${m.id}" type="button" aria-label="Delete">×</button>
            </div>
          </div>
        `).join("");
        $list.querySelectorAll(".memory-delete").forEach($btn => {
          $btn.addEventListener("click", async () => {
            if (!confirm("Delete this memory?")) return;
            await api.deleteMemory(state.editingBotId, $btn.dataset.id);
            loadMemoryTab();
          });
        });
      }

      // Add memory form
      const $addForm = document.getElementById("addMemoryForm");
      if ($addForm && !$addForm.dataset.bound) {
        $addForm.dataset.bound = "1";
        $addForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const content = document.getElementById("newMemoryContent").value.trim();
          const category = document.getElementById("newMemoryCategory").value;
          if (!content) return;
          await api.addMemory(state.editingBotId, content, category);
          document.getElementById("newMemoryContent").value = "";
          loadMemoryTab();
        });
      }
    } catch (e) {
      console.error("loadMemoryTab:", e);
    }
  }

  // ── KB tab ──
  async function loadKBTab() {
    if (!state.editingBotId) return;
    const $list = document.getElementById("kbList");
    if (!$list) return;
    try {
      const { docs } = await api.kb(state.editingBotId);
      if (docs.length === 0) {
        $list.innerHTML = `<div class="list-empty">No documents yet. Add .txt/.md files or paste content below.</div>`;
      } else {
        $list.innerHTML = docs.map(d => `
          <div class="kb-item" data-id="${d.id}">
            <div class="kb-item-header">
              <div class="kb-title">${escapeHtml(d.title)}</div>
              <button class="kb-delete" data-id="${d.id}" type="button" aria-label="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-2 14H7L5 6"/>
                </svg>
              </button>
            </div>
            <div class="kb-preview">${escapeHtml(d.content.slice(0, 200))}${d.content.length > 200 ? "…" : ""}</div>
            <div class="kb-meta">${(d.size / 1024).toFixed(1)} KB · ${relativeTime(d.createdAt)}</div>
          </div>
        `).join("");
        $list.querySelectorAll(".kb-delete").forEach($btn => {
          $btn.addEventListener("click", async () => {
            if (!confirm("Delete this document?")) return;
            await api.deleteKB(state.editingBotId, $btn.dataset.id);
            loadKBTab();
          });
        });
      }

      // Add KB form
      const $addForm = document.getElementById("addKBForm");
      if ($addForm && !$addForm.dataset.bound) {
        $addForm.dataset.bound = "1";
        const $file = document.getElementById("newKBFile");
        const $content = document.getElementById("newKBContent");
        $file.addEventListener("change", () => {
          const f = $file.files[0];
          if (!f) return;
          if (f.size > 5 * 1024 * 1024) {
            alert("File too large. Max 5 MB.");
            $file.value = "";
            return;
          }
          const reader = new FileReader();
          reader.onload = (e) => {
            $content.value = e.target.result;
            if (!document.getElementById("newKBTitle").value) {
              document.getElementById("newKBTitle").value = f.name.replace(/\.[^.]+$/, "");
            }
          };
          reader.readAsText(f);
        });
        $addForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const title = document.getElementById("newKBTitle").value.trim();
          const content = $content.value.trim();
          if (!title || !content) return;
          await api.addKB(state.editingBotId, title, content);
          document.getElementById("newKBTitle").value = "";
          $content.value = "";
          $file.value = "";
          loadKBTab();
        });
      }
    } catch (e) {
      console.error("loadKBTab:", e);
    }
  }

  async function handleEditorSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("botName").value.trim();
    const description = document.getElementById("botDesc").value.trim();
    const system = document.getElementById("botSystem").value.trim();
    const icon = document.querySelector(".icon-option.selected")?.dataset.icon || "✦";
    if (!name || !system) return;

    try {
      if (state.editingBotId) {
        const { bots } = await api.updateBot(state.editingBotId, { name, description, system, icon });
        state.bots = bots;
      } else {
        const body = { name, description, system, icon };
        if (state.creatingFromTemplate) {
          body.templateId = state.creatingFromTemplate.id;
        }
        const { bot, bots } = await api.createBot(body);
        state.bots = bots;
        state.editingBotId = bot.id; // Now we can manage memory/KB
        // Don't close — switch to memory tab to show seeded data
        document.querySelector(".tab[data-tab='memory']")?.click();
      }
      updateBotLabel();
    } catch (e) {
      alert(`Failed to save bot: ${e.message}`);
    }
  }

  async function handleEditorDelete() {
    if (!state.editingBotId) return;
    if (!confirm("Delete this bot permanently? Its memory and knowledge base will also be deleted.")) return;
    try {
      const { bots } = await api.deleteBot(state.editingBotId);
      state.bots = bots;
      if (state.currentBotId === state.editingBotId) {
        state.currentBotId = state.bots[0]?.id || "tmpl_assistant";
        localStorage.setItem(LS.botId(), state.currentBotId);
      }
      updateBotLabel();
      closeBotEditor();
    } catch (e) {
      alert(`Failed to delete bot: ${e.message}`);
    }
  }

  // ── Session management ──
  function switchBot(newBotId) {
    if (state.session) saveCurrentSession();
    state.currentBotId = newBotId;
    localStorage.setItem(LS.botId(), newBotId);
    updateBotLabel();
    const sessions = loadSessions(newBotId);
    if (sessions.length > 0) switchToSession(sessions[0]);
    else startNewSession();
  }

  function startNewSession() {
    state.session = newSession(state.currentBotId);
    setCurrentSessionId(state.currentBotId, state.session.id);
    assistantBubbles.clear();
    $messages.replaceChildren();
    showEmptyState();
    if (state.drawerOpen) renderDrawerList();
  }

  function switchToSession(session) {
    if (state.isStreaming) stopStream();
    if (state.session) saveCurrentSession();
    state.session = session;
    setCurrentSessionId(state.currentBotId, session.id);
    rerenderMessages();
    if (state.drawerOpen) renderDrawerList();
  }

  function saveCurrentSession() {
    if (!state.session) return;
    state.session.messages = currentMessages();
    upsertSession(state.session);
  }

  $newChatBtn.addEventListener("click", () => {
    if (state.isStreaming) stopStream();
    saveCurrentSession();
    startNewSession();
  });

  $newBotBtn.addEventListener("click", () => openTemplatePicker());

  function openTemplatePicker() {
    // Build a template picker overlay
    const overlay = document.createElement("div");
    overlay.className = "template-picker-overlay";
    overlay.innerHTML = `
      <div class="template-picker">
        <div class="template-picker-header">
          <h2>Create new bot</h2>
          <button class="icon-btn close-picker" type="button" aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <p class="template-picker-hint">Pick a template to get started. Each template includes a system prompt, suggested memory, and (where relevant) seed documents.</p>
        <div class="template-picker-grid">
          ${state.templates.map(t => `
            <button class="template-picker-card" data-template-id="${t.id}" type="button">
              <div class="template-picker-icon">${t.icon}</div>
              <div class="template-picker-name">${escapeHtml(t.name)}</div>
              <div class="template-picker-desc">${escapeHtml(t.description)}</div>
              <div class="template-picker-cat">${escapeHtml(t.category)}</div>
            </button>
          `).join("")}
          <button class="template-picker-card template-blank" data-template-id="" type="button">
            <div class="template-picker-icon">+</div>
            <div class="template-picker-name">Blank</div>
            <div class="template-picker-desc">Start from scratch</div>
            <div class="template-picker-cat">blank</div>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));

    // Handlers
    function close() {
      overlay.classList.remove("open");
      setTimeout(() => overlay.remove(), 200);
    }
    overlay.querySelector(".close-picker").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll(".template-picker-card").forEach($card => {
      $card.addEventListener("click", () => {
        const tid = $card.dataset.templateId;
        close();
        if (tid) {
          const tpl = state.templates.find(t => t.id === tid);
          if (tpl) openBotEditor(tpl, null);
        } else {
          openBotEditor(null, null);
        }
      });
    });
  }

  // ── Floating chat input (FAB pattern) ──
  const $chatFab = document.getElementById("chatFab");
  const $fabToggle = document.getElementById("fabToggle");
  let fabExpanded = false;

  function expandFab() {
    if (fabExpanded) return;
    fabExpanded = true;
    $chatFab.classList.add("expanded");
    setTimeout(() => $input.focus(), 200);
  }

  function collapseFab(force = false) {
    if (!fabExpanded) return;
    // Only auto-collapse if empty (unless forced)
    if (!force && $input.value.trim().length > 0) return;
    fabExpanded = false;
    $chatFab.classList.remove("expanded");
    $input.blur();
  }

  $fabToggle.addEventListener("click", () => {
    if (fabExpanded) {
      collapseFab(true);
    } else {
      expandFab();
    }
  });

  // Tap-outside-to-collapse when empty
  document.addEventListener("click", (e) => {
    if (!fabExpanded) return;
    if ($chatFab.contains(e.target)) return;
    collapseFab();
  });

  // Open FAB when typing chips or focusing input elsewhere
  $input.addEventListener("focus", expandFab);

  // Keep FAB above keyboard using visualViewport API
  function updateFabPosition() {
    if (!window.visualViewport) return;
    const vv = window.visualViewport;
    const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
    if (keyboardHeight > 50) {
      // Keyboard is open — push FAB above it
      $chatFab.style.bottom = `${keyboardHeight + 12}px`;
    } else {
      $chatFab.style.bottom = "";
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateFabPosition);
    window.visualViewport.addEventListener("scroll", updateFabPosition);
  } else {
    window.addEventListener("resize", updateFabPosition);
  }

  // Auto-expand on chip tap (so the typed text is visible)
  document.addEventListener("click", (e) => {
    if (e.target.closest(".chip")) expandFab();
  });

  function setStatus(online) {
    $statusDot.classList.toggle("offline", !online);
  }

  function showEmptyState() {
    const bot = currentBot() || {};
    const $empty = document.createElement("div");
    $empty.className = "empty";
    const hasNoUserBots = state.bots.length === 0;
    $empty.innerHTML = `
      <div class="empty-icon">${bot.icon || "✦"}</div>
      <h2>${escapeHtml(bot.name || "Hermes")}</h2>
      <p>${escapeHtml(bot.description || "")}</p>
      ${hasNoUserBots ? `
        <button class="empty-cta" id="emptyCreateBotBtn" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Browse templates
        </button>
      ` : ""}
      <div class="chips">
        <button class="chip" data-prompt="Hello">Say hello</button>
        <button class="chip" data-prompt="What can you help me with?">What can you do?</button>
      </div>
    `;
    $messages.replaceChildren($empty);
    $empty.querySelectorAll(".chip").forEach($chip => {
      $chip.addEventListener("click", () => {
        $input.value = $chip.dataset.prompt;
        autoResize();
        $send.disabled = false;
        $form.requestSubmit();
      });
    });
    const $cta = $empty.querySelector("#emptyCreateBotBtn");
    if ($cta) $cta.addEventListener("click", () => openTemplatePicker());
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  function autoResize() {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 140) + "px";
  }

  function appendUserMessage(msg) {
    const $empty = $messages.querySelector(".empty");
    if ($empty) $empty.remove();
    const $bubble = document.createElement("div");
    $bubble.className = "bubble user";
    if (Array.isArray(msg.content)) {
      const hasImage = msg.content.some(p => p.type === "image_url");
      if (hasImage) $bubble.classList.add("has-image");
      for (const part of msg.content) {
        if (part.type === "image_url") {
          const img = document.createElement("img");
          img.src = part.image_url.url;
          img.alt = "Attached image";
          $bubble.appendChild(img);
        } else if (part.type === "text") {
          if (hasImage) {
            const cap = document.createElement("div");
            cap.className = "image-caption";
            cap.textContent = part.text;
            $bubble.appendChild(cap);
          } else {
            $bubble.appendChild(document.createTextNode(part.text));
          }
        }
      }
    } else {
      $bubble.textContent = msg.content;
    }
    $messages.appendChild($bubble);
    scrollToBottom();
  }

  function appendAssistantMessage(msg) {
    const $empty = $messages.querySelector(".empty");
    if ($empty) $empty.remove();
    const $wrapper = document.createElement("div");
    $wrapper.className = "msg-wrapper assistant";
    $wrapper.dataset.messageId = msg.id;
    const $bubble = document.createElement("div");
    $bubble.className = "bubble assistant streaming";
    $wrapper.appendChild($bubble);
    const $steps = document.createElement("div");
    $steps.className = "chief-steps";
    $wrapper.appendChild($steps);
    const $tools = document.createElement("div");
    $tools.className = "tools";
    $wrapper.appendChild($tools);
    const $footer = document.createElement("div");
    $footer.className = "msg-footer";
    $wrapper.appendChild($footer);
    $messages.appendChild($wrapper);
    assistantBubbles.set(msg.id, { bubble: $bubble, steps: $steps, tools: $tools, footer: $footer, wrapper: $wrapper });
    scrollToBottom();
  }

  function appendChiefStep(messageId, step) {
    const refs = assistantBubbles.get(messageId);
    if (!refs) return;
    const $step = document.createElement("div");
    $step.className = `chief-step chief-step-${step.type}${step.done ? " done" : ""}`;
    $step.innerHTML = `
      <span class="chief-step-icon">${step.icon}</span>
      <div class="chief-step-body">
        <div class="chief-step-label">${escapeHtml(step.label)}</div>
        ${step.detail ? `<div class="chief-step-detail">${escapeHtml(step.detail)}</div>` : ""}
      </div>
    `;
    refs.steps.appendChild($step);
    scrollToBottom();
  }

  function completeChiefStep(messageId) {
    const refs = assistantBubbles.get(messageId);
    if (!refs) return;
    const $step = refs.steps.querySelector(".chief-step:not(.done):last-child");
    if ($step) $step.classList.add("done");
  }

  const pending = new Map();
  let rafScheduled = false;
  function scheduleRender(messageId) {
    if (!pending.has(messageId)) pending.set(messageId, "");
    rafScheduled = true;
    requestAnimationFrame(() => {
      for (const [id, _] of pending) {
        const refs = assistantBubbles.get(id);
        const msg = currentMessages().find(m => m.id === id);
        if (refs && msg) {
          refs.bubble.innerHTML = renderMarkdown(msg.content);
          if (!refs.footer.dataset.initialized && !msg.streaming) {
            renderFooter(refs, msg);
          }
        }
      }
      pending.clear();
      rafScheduled = false;
      scrollToBottom();
    });
  }

  function renderFooter(refs, msg) {
    refs.footer.dataset.initialized = "1";
    refs.footer.innerHTML = `
      <button class="msg-action" data-action="copy" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy
      </button>
      <button class="msg-action" data-action="regenerate" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Regenerate
      </button>
    `;
    refs.footer.querySelector('[data-action="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(msg.content);
        const $btn = refs.footer.querySelector('[data-action="copy"]');
        $btn.classList.add("copied");
        setTimeout(() => $btn.classList.remove("copied"), 1200);
      } catch {}
    });
    refs.footer.querySelector('[data-action="regenerate"]').addEventListener("click", () => {
      regenerate(msg);
    });
  }

  function regenerate(msg) {
    const idx = currentMessages().findIndex(m => m.id === msg.id);
    if (idx < 1) return;
    state.session.messages = state.session.messages.slice(0, idx - 1);
    rerenderMessages();
    const lastUser = state.session.messages[state.session.messages.length - 1];
    if (lastUser && lastUser.role === "user") sendMessage(lastUser.content, true);
  }

  function rerenderMessages() {
    assistantBubbles.clear();
    $messages.replaceChildren();
    const msgs = currentMessages();
    if (msgs.length === 0) { showEmptyState(); return; }
    for (const msg of msgs) {
      if (msg.role === "user") {
        appendUserMessage(msg);
      } else if (msg.role === "assistant") {
        appendAssistantMessage(msg);
        const refs = assistantBubbles.get(msg.id);
        if (refs) {
          refs.bubble.innerHTML = renderMarkdown(msg.content);
          if (msg.chiefSteps) for (const step of msg.chiefSteps) appendChiefStep(msg.id, { ...step, done: true });
          if (!msg.streaming) renderFooter(refs, msg);
        }
      }
    }
    scrollToBottom();
  }

  function currentMessages() {
    return state.session?.messages || [];
  }

  async function sendMessage(text, isRegenerate = false) {
    if (state.isStreaming) return;
    if (!state.session) startNewSession();
    setStatus(true);
    const pendingAttachments = $inputWrap._pendingAttachments || [];

    if (!isRegenerate || pendingAttachments.length > 0) {
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const att of pendingAttachments) {
        content.push({ type: "image_url", image_url: { url: att.dataUrl } });
      }
      const userMsg = {
        role: "user",
        content: content.length === 1 && content[0].type === "text" ? text : content,
        id: crypto.randomUUID(), ts: Date.now(),
      };
      state.session.messages.push(userMsg);
      if (state.session.messages.filter(m => m.role === "user").length === 1) {
        state.session.title = (text || "(image)").slice(0, 50) + ((text || "").length > 50 ? "…" : "");
      }
      appendUserMessage(userMsg);
      $inputWrap._pendingAttachments = [];
      $inputWrap.querySelectorAll(".attachment-preview").forEach(el => el.remove());
    }

    const assistantMsg = {
      role: "assistant", content: "", toolCalls: [], chiefSteps: [],
      streaming: true, id: crypto.randomUUID(), ts: Date.now(),
    };
    state.session.messages.push(assistantMsg);
    appendAssistantMessage(assistantMsg);

    state.isStreaming = true;
    $send.classList.add("stop");
    $send.disabled = false;
    state.controller = new AbortController();

    const bot = currentBot();
    const isChief = bot.id === "tmpl_chief" || bot.id === "bot_starter_chief";
    const payloadMessages = currentMessages().filter(m => !m.streaming).map(({ role, content }) => ({ role, content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payloadMessages, bot_id: bot.id }),
        signal: state.controller.signal,
      });

      if (!res.ok) {
        let msgText = `Error ${res.status}`;
        try { const j = await res.json(); if (j.message) msgText = j.message; } catch {}
        const refs = assistantBubbles.get(assistantMsg.id);
        if (refs) refs.bubble.textContent = msgText;
        assistantMsg.content = msgText;
        assistantMsg.streaming = false;
        if (refs) refs.bubble.classList.remove("streaming");
        saveCurrentSession();
        return;
      }

      const reader = res.body.getReader();
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
          let curEvent = "", curData = "";
          for (const line of event.split("\n")) {
            if (line.startsWith("event: ")) curEvent = line.slice(7).trim();
            else if (line.startsWith("data: ")) curData = line.slice(6).trim();
          }
          if (!curEvent || !curData) continue;
          let payload;
          try { payload = JSON.parse(curData); } catch { continue; }

          if (isChief) {
            if (curEvent === "thinking") {
              appendChiefStep(assistantMsg.id, { type: "thinking", icon: "🧠", label: payload.label });
              assistantMsg.chiefSteps.push({ type: "thinking", icon: "🧠", label: payload.label });
            } else if (curEvent === "delegate") {
              appendChiefStep(assistantMsg.id, { type: "delegate", icon: payload.botIcon || "→", label: `Delegated to ${payload.botName}`, detail: payload.reasoning });
              assistantMsg.chiefSteps.push({ type: "delegate", icon: payload.botIcon || "→", label: `Delegated to ${payload.botName}`, detail: payload.reasoning });
              completeChiefStep(assistantMsg.id);
            } else if (curEvent === "bot_response") {
              appendChiefStep(assistantMsg.id, { type: "bot_response", icon: payload.botIcon || "→", label: `${payload.botName} responded`, detail: payload.content.slice(0, 200) + (payload.content.length > 200 ? "…" : "") });
              assistantMsg.chiefSteps.push({ type: "bot_response", icon: payload.botIcon || "→", label: `${payload.botName} responded`, detail: payload.content.slice(0, 200) });
              completeChiefStep(assistantMsg.id);
            } else if (curEvent === "synthesizing") {
              appendChiefStep(assistantMsg.id, { type: "synthesizing", icon: "⚔️", label: payload.label });
              assistantMsg.chiefSteps.push({ type: "synthesizing", icon: "⚔️", label: payload.label });
              completeChiefStep(assistantMsg.id);
            } else if (curEvent === "token") {
              fullText += payload.content;
              assistantMsg.content = fullText;
              scheduleRender(assistantMsg.id);
            } else if (curEvent === "done") {
              completeChiefStep(assistantMsg.id);
            } else if (curEvent === "error") {
              throw new Error(payload.message);
            }
          }
        }
      }

      assistantMsg.streaming = false;
      const refs = assistantBubbles.get(assistantMsg.id);
      if (refs) {
        refs.bubble.innerHTML = renderMarkdown(fullText);
        refs.bubble.classList.remove("streaming");
        renderFooter(refs, assistantMsg);
      }
      saveCurrentSession();
      setStatus(true);
    } catch (err) {
      const refs = assistantBubbles.get(assistantMsg.id);
      if (refs) {
        refs.bubble.textContent = err.name === "AbortError" ? "[stopped]" : `Network error: ${err.message}`;
        refs.bubble.classList.remove("streaming");
      }
      assistantMsg.streaming = false;
      saveCurrentSession();
      setStatus(false);
    } finally {
      state.isStreaming = false;
      state.controller = null;
      $send.classList.remove("stop");
      $send.disabled = $input.value.trim().length === 0;
    }
  }

  function stopStream() {
    if (state.controller) state.controller.abort();
  }

  $input.addEventListener("focus", expandFab);
  $input.addEventListener("input", () => {
    autoResize();
    $send.disabled = $input.value.trim().length === 0 || state.isStreaming;
    if ($input.value.length === 1 && !fabExpanded) expandFab();
  });
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $form.requestSubmit();
    }
  });
  $form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.isStreaming) return stopStream();
    const text = $input.value.trim();
    if (!text) return;
    $input.value = "";
    autoResize();
    $send.disabled = true;
    sendMessage(text);
  });

  // ── Voice input ──
  let recognition = null, isListening = false;
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    $micBtn.hidden = false;
    recognition = new SR();
    recognition.continuous = false; recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    let finalTranscript = "";
    recognition.onstart = () => { isListening = true; finalTranscript = ""; $micBtn.classList.add("listening"); $input.placeholder = "Listening…"; };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += t; else interim += t;
      }
      $input.value = finalTranscript + interim;
      autoResize();
      $send.disabled = $input.value.trim().length === 0 || state.isStreaming;
    };
    recognition.onerror = () => stopListening();
    recognition.onend = () => {
      isListening = false;
      $micBtn.classList.remove("listening");
      $input.placeholder = "Ask anything…";
      if ($input.value.trim()) $form.requestSubmit();
    };
    $micBtn.addEventListener("click", () => {
      if (isListening) stopListening();
      else { try { recognition.start(); } catch {} }
    });
  }
  function stopListening() { if (recognition && isListening) try { recognition.stop(); } catch {} }
  setupVoice();

  // ── Image attachments ──
  const $fileInput = document.createElement("input");
  $fileInput.type = "file"; $fileInput.accept = "image/*"; $fileInput.multiple = true;
  $fileInput.style.display = "none";
  document.body.appendChild($fileInput);
  $inputWrap._pendingAttachments = [];
  function addAttachment(file) {
    if (!file || !file.type.startsWith("image/")) return;
    if (file.size > 5 * 1024 * 1024) { alert("Image too large. Max 5 MB."); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      $inputWrap._pendingAttachments.push({ name: file.name, dataUrl, size: file.size });
      const $preview = document.createElement("div");
      $preview.className = "attachment-preview";
      $preview.innerHTML = `<img src="${dataUrl}" alt="" /><button class="attachment-remove" type="button" aria-label="Remove">×</button>`;
      $preview.querySelector(".attachment-remove").addEventListener("click", () => {
        const idx = $inputWrap._pendingAttachments.findIndex(a => a.dataUrl === dataUrl);
        if (idx >= 0) $inputWrap._pendingAttachments.splice(idx, 1);
        $preview.remove();
      });
      $chatFab.querySelector(".fab-attach-row").appendChild($preview);
      $input.focus();
    };
    reader.readAsDataURL(file);
  }
  $input.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) { e.preventDefault(); addAttachment(file); }
      }
    }
  });
  $fileInput.addEventListener("change", (e) => {
    for (const file of e.target.files) addAttachment(file);
    $fileInput.value = "";
  });
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length > 0) {
      e.preventDefault();
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith("image/")) addAttachment(file);
      }
    }
  });
  $attachBtn.addEventListener("click", () => $fileInput.click());

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $input && !state.botsListOpen && !state.botEditorOpen) {
      e.preventDefault(); $input.focus();
    }
    if (e.key === "Escape") {
      if (state.botsListOpen) closeBotList();
      if (state.drawerOpen) closeDrawer();
      if (state.botEditorOpen) closeBotEditor();
    }
  });

  // ── Boot ──
  updateBotLabel();
  const sessions = loadSessions(state.currentBotId);
  const currentId = getCurrentSessionId(state.currentBotId);
  let sessionToLoad = currentId ? sessions.find(s => s.id === currentId) : null;
  if (!sessionToLoad && sessions.length > 0) sessionToLoad = sessions[0];
  if (sessionToLoad) {
    state.session = sessionToLoad;
    setCurrentSessionId(state.currentBotId, sessionToLoad.id);
    if (sessionToLoad.messages.length > 0) rerenderMessages();
    else showEmptyState();
  } else {
    startNewSession();
  }
  setTimeout(() => $input.focus(), 100);

  fetch("/healthz", { credentials: "include" })
    .then(r => setStatus(r.ok))
    .catch(() => setStatus(false));

  // Load bots + templates from server
  loadBotsFromServer().then(() => {
    updateBotLabel();
  });
}

renderShell();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
