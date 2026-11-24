// Shoal — interface
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (p) => (p || "").replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/i, "~");
// platform: shortcuts are ⌘ on macOS; on Windows/Linux Ctrl (+ Shift for letters, since Ctrl+K/J are terminal keys)
const IS_MAC = window.shoal?.platform ? window.shoal.platform === "darwin" : /mac/i.test(navigator.platform || "");
document.documentElement.classList.add(IS_MAC ? "is-mac" : "not-mac");
const kbd = (k) => (IS_MAC ? "⌘" + k.toUpperCase() : /^[0-9]$/.test(k) ? "Ctrl+" + k : "Ctrl+Shift+" + k.toUpperCase());
const isShortcut = (e) => (IS_MAC ? e.metaKey : e.ctrlKey && !e.altKey && (/^[0-9]$/.test(e.key) ? !e.shiftKey : e.shiftKey));
// only touches the DOM if the content really changed (avoids rebuilding the list on every server message)
const TOKEN = window.shoal?.token || ""; // given by the app (preload), never embedded in the page
const setHTML = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };
// tags: user-defined labels (Settings → Tags), one per conversation, used to filter both lists
// Notion-like palette (dark mode): background of the pill + a brighter dot for the color list
const TAG_COLORS = {
  default: ["#373C3F", "#9BA3A0", "Default", "Par défaut"], gray: ["#4B5154", "#A6ADAB", "Gray", "Gris"], brown: ["#5C3B23", "#C9926B", "Brown", "Marron"],
  orange: ["#7A4416", "#F09B52", "Orange", "Orange"], yellow: ["#7A5E1C", "#E8C15A", "Yellow", "Jaune"], green: ["#1F5641", "#4FD39A", "Green", "Vert"],
  blue: ["#1F4470", "#6CB0F5", "Blue", "Bleu"], purple: ["#45306A", "#B794F0", "Purple", "Violet"], pink: ["#6A2D4E", "#F08CC0", "Pink", "Rose"], red: ["#6E2C2C", "#F2837B", "Red", "Rouge"],
};
const COLOR_KEYS = Object.keys(TAG_COLORS);
const isLightTheme = () => ["light", "malachite-light", "lavender", "amber-light"].includes(settings.theme);
const tagBg = (c) => (TAG_COLORS[c] || TAG_COLORS.default)[0]; // same color in every theme, always white text
const tagOf = (id) => (settings.tags || []).find((t) => t.id === id);
const pillHTML = (t, extra = "") => `<span class="tagpill" style="--tc:${tagBg(t.color)}"${extra}>${esc(t.name)}</span>`;
const tagPill = (id) => { const t = tagOf(id); return t ? pillHTML(t, ` data-act="tag"`) : ""; };
// tag filter: several tags can be selected at once (a conversation shows if it has ANY of them; "none" = untagged)
let tagFilter = new Set((() => { try { return JSON.parse(localStorage.getItem("shoal.tagFilter2") || "[]"); } catch { return []; } })());
const saveFilter = () => { try { localStorage.setItem("shoal.tagFilter2", JSON.stringify([...tagFilter])); } catch {} };
const passTag = (id) => !tagFilter.size || (tagOf(id) ? tagFilter.has(id) : tagFilter.has("none"));
const TAG_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`;

// language (settings ⚙): English by default, French optional. L("english", "français")
let LANG = (() => { try { return localStorage.getItem("shoal.lang") || "en"; } catch { return "en"; } })();
const L = (en, fr) => (LANG === "fr" ? fr : en);
const LOC = () => (LANG === "fr" ? "fr-FR" : "en-US");

let daily = null, weeks = null, weekIdx = 0, showAllTasks = false, judging = 0;
const TOP_N = 5;
let ws, sessions = [], usage = null, week = null, recents = [], history = [];
let settings = {}, autoDailyTarget = 20, homeDir = "", envInfo = null, appVersion = "";
const IS_APP = /Electron/.test(navigator.userAgent) || new URLSearchParams(location.search).has("app");
if (IS_APP) document.documentElement.classList.add("is-app");
let tab = location.hash === "#hist" ? "hist" : (localStorage.getItem("shoal.tab") || "convs");
let active = localStorage.getItem("shoal.active") || null;
const terms = new Map(); // id -> { term, fit, el, ready }
const dayLong = (d) => new Date(2024, 0, 7 + d).toLocaleDateString(LOC(), { weekday: "long" }); // d: 0 = Sunday

// ---------------------------------------------------------------- connection
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${TOKEN}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1000);
}
const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

function onMessage(m) {
  if (m.t === "state") {
    // the server only sends the parts that changed
    if ("sessions" in m) sessions = m.sessions;
    if ("usage" in m) usage = m.usage;
    if ("daily" in m) daily = m.daily || null;
    if ("weeks" in m) weeks = m.weeks || null;
    if ("judging" in m) judging = m.judging || 0;
    if ("recents" in m) recents = m.recents || [];
    if ("history" in m) history = m.history || [];
    if ("autoDaily" in m) autoDailyTarget = m.autoDaily;
    if ("home" in m) homeDir = m.home;
    if ("env" in m) envInfo = m.env;
    if ("version" in m) appVersion = m.version;
    if ("settings" in m) { settings = m.settings || {}; applySettings(); maybeStartTour(); }
    if ("sessions" in m) syncTerms();
    render();
  } else if (m.t === "replay") {
    const t = ensureTerm(m.id); t.pend = [m.data]; t.pendLen = m.data.length; t.reset = true; t.stale = false; flushTerm(m.id);
  } else if (m.t === "out") {
    const t = ensureTerm(m.id);
    t.pend.push(m.data); t.pendLen += m.data.length;
    // terminal idle too long: drop it, it will be resynced when opened
    if (t.pendLen > 1_500_000) { t.pend = []; t.pendLen = 0; t.stale = true; }
    flushTerm(m.id);
  } else if (m.t === "stats") {
    renderStats(m);
  } else if (m.t === "created") {
    ensureTerm(m.id); select(m.id);
  } else if (m.t === "alert") {
    onAlert(m.id, m.kind);
  }
}

// ---------------------------------------------------------------- terminals
// terminal colors per theme (the UI colors come from style.css)
const DARK_ANSI = { black: "#0B1E2C", red: "#FF6B7F", green: "#3FE5AD", yellow: "#FFC46B", blue: "#6CB8FF", magenta: "#C9A2FF", cyan: "#5EE6E0", white: "#CFE3DC",
  brightBlack: "#4E6A63", brightRed: "#FF9AA8", brightGreen: "#A0F7CD", brightYellow: "#FFDCA0", brightBlue: "#A6D4FF", brightMagenta: "#DEC7FF", brightCyan: "#9DF2EE", brightWhite: "#FFFFFF" };
const LIGHT_ANSI = { black: "#24292F", red: "#CF222E", green: "#116329", yellow: "#9A6700", blue: "#0969DA", magenta: "#8250DF", cyan: "#1B7C83", white: "#6E7781",
  brightBlack: "#57606A", brightRed: "#A40E26", brightGreen: "#1A7F37", brightYellow: "#633C01", brightBlue: "#218BFF", brightMagenta: "#A475F9", brightCyan: "#3192AA", brightWhite: "#8C959F" };
const TERM_THEMES = {
  malachite: { ...DARK_ANSI, background: "#050E18", foreground: "#E2F1EB", cursor: "#3FE5AD", cursorAccent: "#050E18", selectionBackground: "rgba(63,229,173,0.30)" },
  amethyst: { ...DARK_ANSI, green: "#7EE0B5", background: "#0E0A1B", foreground: "#EEE8FA", cursor: "#B48CFF", cursorAccent: "#0E0A1B", selectionBackground: "rgba(180,140,255,0.30)", black: "#1B1331", brightBlack: "#6E5F8C" },
  amber: { ...DARK_ANSI, background: "#120D06", foreground: "#F3EADB", cursor: "#FFB02E", cursorAccent: "#120D06", selectionBackground: "rgba(255,176,46,0.28)", black: "#20180D", brightBlack: "#7A6A52" },
  dark: { ...DARK_ANSI, green: "#4ADE80", background: "#141517", foreground: "#E6E7E9", cursor: "#3CCFE0", cursorAccent: "#141517", selectionBackground: "rgba(60,207,224,0.28)", black: "#1F2023", brightBlack: "#5F6368" },
  light: { ...LIGHT_ANSI, background: "#FFFFFF", foreground: "#1F2328", cursor: "#0A7A8C", cursorAccent: "#FFFFFF", selectionBackground: "rgba(10,122,140,0.20)" },
  "amber-light": { ...LIGHT_ANSI, background: "#FFFDF8", foreground: "#2A1D0B", cursor: "#AD5C05", cursorAccent: "#FFFDF8", selectionBackground: "rgba(217,119,6,0.20)" },
  "malachite-light": { ...LIGHT_ANSI, background: "#FBFEFD", foreground: "#0C2A22", cursor: "#00A37C", cursorAccent: "#FBFEFD", selectionBackground: "rgba(0,163,124,0.22)" },
  lavender: { ...LIGHT_ANSI, background: "#FDFCFF", foreground: "#1F1533", cursor: "#7C4DDB", cursorAccent: "#FDFCFF", selectionBackground: "rgba(124,77,219,0.22)" },
};
const termTheme = () => TERM_THEMES[settings.theme] || TERM_THEMES.malachite;
// apply the last theme before the server answers (no flash of the default theme)
try { const th = localStorage.getItem("shoal.theme"); if (th && th !== "malachite") document.documentElement.dataset.theme = th; } catch {}
try { document.documentElement.dataset.side = localStorage.getItem("shoal.side") || "right"; } catch {}


// open a link in the default browser: the URL must be passed to window.open (the app forwards it to the browser and denies the window)
function openLink(uri) { if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener"); }

function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const el = document.createElement("div");
  el.className = "term" + (id === active ? " active" : "");
  $("#terms").appendChild(el);
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, ui-monospace, monospace', fontSize: settings.fontSize || 13, lineHeight: 1.18,
    cursorBlink: false, allowProposedApi: true, macOptionIsMeta: true, scrollback: settings.scrollback || 5000, theme: termTheme(),
    // OSC 8 links (Claude Code underlines its links this way): xterm's default asks for confirmation, then opens a blank window
    linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => openLink(uri)));
  const uni = new Unicode11Addon.Unicode11Addon(); term.loadAddon(uni); term.unicode.activeVersion = "11";
  term.open(el);
  term.onData((d) => send({ t: "in", id, data: d }));
  // when the app reads the mouse (Claude Code full screen), xterm turns a trackpad gesture into
  // very few wheel steps (small moves damped to 30 %, at most one step per event): scrolling lagged behind the
  // fingers. Here every line of movement becomes one wheel step, like Terminal.app.
  let wheelAcc = 0;
  term.attachCustomWheelEventHandler((e) => {
    const core = term._core, ms = core && core.coreMouseService;
    if (!ms || !ms.areMouseEventsActive || e.shiftKey || !e.deltaY) return true;
    const cell = core._renderService?.dimensions?.css?.cell?.height;
    const pos = cell && core._mouseService?.getMouseReportCoords(e, core.screenElement);
    if (!pos) return true;
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * term.rows : e.deltaY / cell;
    if (Math.sign(lines) !== Math.sign(wheelAcc)) wheelAcc = 0; // direction change: start over
    wheelAcc += lines;
    const n = Math.trunc(wheelAcc); wheelAcc -= n;
    for (let i = 0; i < Math.min(Math.abs(n), 60); i++)
      ms.triggerMouseEvent({ col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: 4, action: n < 0 ? 0 : 1, ctrl: e.ctrlKey, alt: e.altKey, shift: false });
    e.preventDefault(); e.stopPropagation();
    return false;
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Enter" && e.shiftKey) { send({ t: "in", id, data: "\x1b\r" }); return false; } // newline in the prompt
    if (isShortcut(e) && /^[1-9jk,]$/i.test(e.key)) return false; // handled by the global shortcut
    // Windows / Linux: Ctrl+C copies when text is selected (otherwise it interrupts, as in any terminal)
    if (!IS_MAC && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c" && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    return true;
  });
  const t = { term, fit, el, pend: [], pendLen: 0, reset: false, stale: false };
  terms.set(id, t);
  return t;
}

// Only the displayed terminal (visible window) processes what it receives; the others buffer it
// and catch up in one go when opened. Otherwise every background terminal would keep decoding
// Claude's animations ("✻ Thinking…") for nothing.
const isLive = (id) => id === active && !document.hidden;
function flushTerm(id) {
  const t = terms.get(id);
  if (!t || !isLive(id)) return;
  if (t.stale) { t.stale = false; send({ t: "sync", id }); return; }
  if (!t.pendLen && !t.reset) return;
  const replay = t.reset;
  if (t.reset) { t.term.reset(); t.reset = false; }
  const data = t.pend.length === 1 ? t.pend[0] : t.pend.join("");
  t.pend = []; t.pendLen = 0;
  t.term.write(data, replay ? () => repaintFullScreen(id) : undefined);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) flushTerm(active); });
// a replayed full-screen app only has the end of its output (the buffer is trimmed): ask it to redraw
function repaintFullScreen(id) {
  const t = terms.get(id);
  if (!t || t.term.buffer.active.type !== "alternate" || t.term.rows < 6) return;
  send({ t: "resize", id, cols: t.term.cols, rows: t.term.rows - 1 });
  setTimeout(() => { const u = terms.get(id); if (u) send({ t: "resize", id, cols: u.term.cols, rows: u.term.rows }); }, 80);
}

function syncTerms() {
  const ids = new Set(sessions.map((s) => s.id));
  for (const [id, t] of terms) if (!ids.has(id)) { t.term.dispose(); t.el.remove(); terms.delete(id); }
  sessions.forEach((s) => ensureTerm(s.id));
  if (!ids.has(active)) select(sessions[0]?.id || null, { quiet: true });
  else { for (const [tid, t] of terms) t.el.classList.toggle("active", tid === active); setLive(active); }
}

function fitActive() {
  const t = terms.get(active);
  if (!t) return;
  try { t.fit.fit(); send({ t: "resize", id: active, cols: t.term.cols, rows: t.term.rows }); } catch {}
}
new ResizeObserver(() => requestAnimationFrame(fitActive)).observe($("#terms"));

// a single "live" terminal: WebGL rendering + blinking cursor only on the displayed one
function setLive(id) {
  for (const [tid, t] of terms) {
    const on = tid === id;
    t.term.options.cursorBlink = on;
  }
}

function select(id, { quiet } = {}) {
  active = id;
  if (id) localStorage.setItem("shoal.active", id);
  for (const [tid, t] of terms) t.el.classList.toggle("active", tid === id);
  setLive(id);
  flushTerm(id);
  requestAnimationFrame(() => { fitActive(); if (!quiet) terms.get(id)?.term.focus(); });
  markSeen();
  render();
}

function markSeen() {
  const s = sessions.find((x) => x.id === active);
  if (s && s.unread && document.hasFocus()) send({ t: "seen", id: active });
}
window.addEventListener("focus", () => { markSeen(); terms.get(active)?.term.focus(); });

// ---------------------------------------------------------------- permissions
const TOOL_LBL = () => LANG === "fr"
  ? { Bash: "Commande", Edit: "Modifier", MultiEdit: "Modifier", Write: "Créer / écrire", Read: "Lire", WebFetch: "Ouvrir la page", WebSearch: "Rechercher", NotebookEdit: "Modifier le notebook" }
  : { Bash: "Command", Edit: "Edit", MultiEdit: "Edit", Write: "Create / write", Read: "Read", WebFetch: "Open page", WebSearch: "Search", NotebookEdit: "Edit notebook" };
function permText(s) {
  const p = s.permission || {};
  if (!p.tool && !p.detail) return p.message || L("Claude is asking for permission", "Claude demande une autorisation");
  const what = TOOL_LBL()[p.tool] || (p.tool || "").replace(/^mcp__[^_]+__/, "").replace(/__/g, " · ");
  return `${what}${p.detail ? " : " + short(p.detail) : ""}`;
}
const isPerm = (s) => s && s.state === "waiting" && s.waitKind === "permission";
function answer(id, allow) {
  send({ t: "answer", id, allow });
  document.querySelectorAll(`.toast[data-id="${id}"]`).forEach((t) => t.remove());
}

// ---------------------------------------------------------------- alerts
function onAlert(id, kind) {
  // the detailed state (which permission, etc.) arrives right after the alert: wait for it
  setTimeout(() => showAlert(id, kind), 150);
}
function showAlert(id, kind) {
  const s = sessions.find((x) => x.id === id) || {};
  const watching = id === active && document.hasFocus();
  if (watching) { setTimeout(markSeen, 400); return; }
  if (kind === "done" ? settings.notifyDone === false : settings.notifyWaiting === false) return; // settings ⚙
  if (settings.sound !== false) chime(kind);
  if (id !== active) toast(s, kind);
  if (settings.systemNotif !== false && !document.hasFocus() && "Notification" in window && Notification.permission === "granted") {
    const n = new Notification(`${s.emoji || "💬"} ${s.title || L("Conversation", "Conversation")}`, {
      body: kind === "done" ? L("Done, your turn", "Terminé, à toi de jouer") : isPerm(s) ? `${L("Permission requested", "Autorisation demandée")} · ${permText(s)}` : L("Waiting for your reply", "Attend ta réponse"), tag: id, silent: true,
    });
    n.onclick = () => { window.shoal?.focus(); window.focus(); select(id); n.close(); };
  }
}

function toast(s, kind) {
  document.querySelectorAll(`.toast[data-id="${s.id}"]`).forEach((t) => t.remove());
  const perm = kind === "waiting" && isPerm(s);
  const el = document.createElement("div");
  el.className = `toast ${kind}${perm ? " perm" : ""}`;
  el.dataset.id = s.id;
  el.innerHTML = `<div class="tile">${esc(s.emoji || "💬")}</div>
    <div class="t-body"><div class="t-title">${esc(s.title || L("Conversation", "Conversation"))}</div>
    <div class="t-sub">${kind === "done" ? L("Done · your turn", "Terminé · à toi") : perm ? L("Permission requested", "Autorisation demandée") : L("Waiting for your reply", "Attend ta réponse")}</div>
    ${perm ? `<div class="t-perm mono" title="${esc(permText(s))}">${esc(permText(s))}</div>
      <div class="t-actions"><button class="btn btn-ghost btn-sm" data-act="deny">${L("Deny", "Refuser")}</button>
      <button class="btn btn-primary btn-sm" data-act="allow">${L("Allow", "Autoriser")}</button>
      <button class="btn btn-ghost btn-sm" data-act="open">${L("Open", "Ouvrir")}</button></div>` : ""}</div>
    ${perm ? "" : `<span class="t-go">${L("Open", "Ouvrir")}</span>`}`;
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  el.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "allow" || act === "deny") { answer(s.id, act === "allow"); return; }
    select(s.id); kill();
  };
  $("#toasts").prepend(el);
  if (!perm) setTimeout(kill, 7000);
}
// a request handled elsewhere (in the terminal, or via the list) removes its toast
function pruneToasts() {
  document.querySelectorAll(".toast.perm").forEach((t) => { if (!isPerm(sessions.find((x) => x.id === t.dataset.id))) t.remove(); });
}

let audio;
function chime(kind) {
  try {
    audio = audio || new AudioContext();
    const notes = kind === "done" ? [880, 1318.5] : [987.8, 987.8];
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime + i * 0.13;
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.12, t0 + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + 0.4);
    });
  } catch {}
}
document.addEventListener("pointerdown", () => {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  audio = audio || new AudioContext();
}, { once: true });

// ---------------------------------------------------------------- rendering
const STATE_LABEL = () => LANG === "fr" ? { idle: "Prête", working: "En cours", done: "Terminé", waiting: "Attend ta réponse" }
  : { idle: "Ready", working: "Working", done: "Done", waiting: "Waiting for you" };

function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return L("just now", "à l'instant");
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  const dt = new Date(ts);
  return dt.toDateString() === new Date().toDateString() ? dt.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" }) : dt.toLocaleDateString(LOC(), { weekday: "short" });
}

function subLine(s) {
  if (s.state === "working") return `<span class="dots"><i></i><i></i><i></i></span> ${L("Working", "En cours")}`;
  if (isPerm(s)) return L("Permission requested", "Autorisation demandée");
  if (s.state === "waiting") return L("Waiting for your reply", "Attend ta réponse");
  if (s.state === "done") return s.unread ? L("Done · your turn", "Terminé · à toi") : L("Done", "Terminé");
  return s.named ? L("Ready", "Prête") : esc(short(s.cwd));
}

let confirming = null;
function render() {
  // list
  $("#convCount").textContent = sessions.length;
  setHTML($("#convs"), sessions.map((s, i) => {
    if (!passTag(s.tag)) return "";
    const cls = ["conv", `s-${s.state}`, s.unread ? "unread" : "", s.id === active ? "active" : ""].join(" ");
    if (confirming === s.id) {
      return `<li class="${cls}" data-id="${s.id}"><div class="confirm">
        <span class="q">${L("Close", "Fermer")} « ${esc(s.title || L("this conversation", "cette conversation"))} » ?</span>
        <button class="btn btn-ghost" data-act="cancel">${L("Cancel", "Annuler")}</button>
        <button class="btn btn-danger" data-act="kill">${L("Close", "Fermer")}</button></div></li>`;
    }
    return `<li class="${cls}" data-id="${s.id}" tabindex="0" title="${kbd(String(i + 1))}">
      <div class="tile">${esc(s.emoji || "💬")}<span class="badge"></span></div>
      <div class="c-body">
        <div class="c-top"><span class="c-title ${s.named ? "" : "unnamed"}">${esc(s.title || L("New conversation", "Nouvelle conversation"))}</span><span class="c-meta"><span class="c-time">${ago(s.lastActivity)}</span></span></div>
        <div class="c-row2"><div class="c-sub">${subLine(s)}</div><span class="c-meta">${tagPill(s.tag)}</span></div>
        ${isPerm(s) ? `<div class="c-perm mono" title="${esc(permText(s))}">${esc(permText(s))}</div>
          <div class="c-actions"><button class="btn btn-ghost btn-xs" data-act="deny">${L("Deny", "Refuser")}</button><button class="btn btn-primary btn-xs" data-act="allow">${L("Allow", "Autoriser")}</button></div>`
        : s.note && s.state !== "working" ? `<div class="c-note" title="${esc(s.note)}">${esc(s.note)}</div>` : ""}
      </div>
      <button class="c-tagbtn" data-act="tag" title="${L("Tag", "Tag")}" aria-label="${L("Tag", "Tag")}">${TAG_ICON}</button>
      <button class="c-close" data-act="close" title="${L("Close conversation", "Fermer la conversation")}" aria-label="${L("Close", "Fermer")}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </li>`;
  }).join(""));

  // focus terminal header
  const s = sessions.find((x) => x.id === active);
  $("#empty").hidden = sessions.length > 0;
  $("#focusHead").style.visibility = s ? "visible" : "hidden";
  if (s) {
    $("#fEmoji").textContent = s.emoji || "💬";
    if ($("#fTitle").contentEditable !== "true") $("#fTitle").textContent = s.title || L("New conversation", "Nouvelle conversation");
    const st = $("#fState");
    st.className = `pill ${s.state}`;
    st.textContent = isPerm(s) ? L("Permission requested", "Autorisation demandée") : (STATE_LABEL()[s.state] || "");
    $("#fCwd").textContent = short(s.cwd);
    $("#fCtxWrap").hidden = s.ctx == null;
    if (s.ctx != null) { $("#fCtx").textContent = `${s.ctx} %`; setMeter($("#fCtxBar"), s.ctx); }
  }

  // window title = Dock badge (setting: all / waiting only / none)
  const badge = settings.badge || "all";
  const unread = badge === "none" ? 0 : sessions.filter((x) => x.unread && (badge === "all" || x.state === "waiting")).length;
  document.title = unread ? `(${unread}) Shoal` : "Shoal";

  renderTagBar(); renderTabs(); renderHistory(); renderUsage(); renderWeek(); renderSetup(); pruneToasts();
}

// ---------------------------------------------------------------- tags: filter bar, picker (Notion-like), editor
function renderTagBar() {
  const tags = settings.tags || [];
  for (const id of [...tagFilter]) if (id !== "none" && !tagOf(id)) tagFilter.delete(id);
  $("#tagBar").hidden = !tags.length;
  if (!tags.length) return;
  const sel = [...tagFilter];
  setHTML($("#tagBar"), `<button class="tf-btn${sel.length ? " active" : ""}" data-tf="open">${TAG_ICON}<span>${sel.length ? L("Tags", "Tags") : L("Filter by tag", "Filtrer par tag")}</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>` +
    sel.map((id) => id === "none"
      ? `<span class="tf-sel plain">${L("No tag", "Sans tag")}<button data-tfx="none" aria-label="×">×</button></span>`
      : `<span class="tf-sel" style="--tc:${tagBg(tagOf(id).color)}">${esc(tagOf(id).name)}<button data-tfx="${id}" aria-label="×">×</button></span>`).join("") +
    (sel.length > 1 ? `<button class="tf-clear" data-tf="clear">${L("Clear", "Effacer")}</button>` : ""));
}
function renderFilterMenu() {
  const tags = settings.tags || [];
  const row = (id, inner) => `<div class="tm-row${tagFilter.has(id) ? " sel" : ""}" data-ff="${id}"><span class="tf-box">${tagFilter.has(id) ? "✓" : ""}</span>${inner}</div>`;
  filterMenu.innerHTML = `<div class="tm-body"><div class="tm-hint">${L("Show conversations tagged…", "Afficher les conversations taguées…")}</div>` +
    tags.map((t) => row(t.id, pillHTML(t))).join("") + row("none", `<span class="tf-none">${L("No tag", "Sans tag")}</span>`) +
    `<div class="tf-foot"><button data-ff="__clear">${L("Show all", "Tout afficher")}</button><button data-ff="__manage">${L("Manage tags…", "Gérer les tags…")}</button></div></div>`;
}
const filterMenu = $("#filterMenu");
$("#tagBar").addEventListener("click", (e) => {
  e.stopPropagation();
  const x = e.target.closest("[data-tfx]");
  if (x) { tagFilter.delete(x.dataset.tfx); saveFilter(); render(); return; }
  const b = e.target.closest("[data-tf]"); if (!b) return;
  if (b.dataset.tf === "clear") { tagFilter.clear(); saveFilter(); render(); return; }
  if (!filterMenu.hidden) { filterMenu.hidden = true; return; }
  renderFilterMenu(); place(filterMenu, b, false);
});
filterMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  const r = e.target.closest("[data-ff]"); if (!r) return;
  const id = r.dataset.ff;
  if (id === "__clear") tagFilter.clear();
  else if (id === "__manage") { filterMenu.hidden = true; openSettings(true, "tags"); return; }
  else tagFilter.has(id) ? tagFilter.delete(id) : tagFilter.add(id); // multi-select: other selected tags stay selected
  saveFilter(); renderFilterMenu(); render();
});
document.addEventListener("mousedown", (e) => { if (!filterMenu.hidden && !filterMenu.contains(e.target) && !$("#tagBar").contains(e.target)) filterMenu.hidden = true; });

const newTagId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
const COLOR_ORDER = ["blue", "green", "purple", "orange", "pink", "yellow", "red", "brown", "gray"]; // new tags get the most distinct colors first
const nextColor = () => { const used = new Set((settings.tags || []).map((t) => t.color)); return COLOR_ORDER.find((c) => !used.has(c)) || COLOR_ORDER[Math.floor(Math.random() * COLOR_ORDER.length)]; };
const saveTags = (tags) => saveSetting({ tags });
function createTag(name) {
  const t = { id: newTagId(), name: name.trim().slice(0, 24), color: nextColor() };
  saveTags([...(settings.tags || []), t]);
  return t;
}
function place(pop, anchor, alignRight = true) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + pop.offsetHeight > innerHeight - 8 ? r.top - pop.offsetHeight - 6 : r.bottom + 6;
  pop.style.top = Math.max(8, top) + "px";
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, alignRight ? r.right - pop.offsetWidth : r.left)) + "px";
}

// picker: search, pick, create (Enter or "+"), edit (⋯), remove
const tagMenu = $("#tagMenu");
let tagTarget = null;
const currentTag = () => (tagTarget?.id ? sessions.find((x) => x.id === tagTarget.id)?.tag : history.find((h) => h.sid === tagTarget?.sid)?.tag) || "";
function openTagMenu(anchor, target) {
  tagTarget = target; tagEdit.hidden = true;
  tagMenu.innerHTML = `<div class="tm-head"><input class="tm-search" placeholder="${L("Search or create a tag…", "Chercher ou créer un tag…")}" maxlength="24" spellcheck="false"></div><div class="tm-body"></div>`;
  renderTagMenu();
  place(tagMenu, anchor);
  tagMenu.querySelector(".tm-search").focus();
}
function renderTagMenu() {
  const q = tagMenu.querySelector(".tm-search")?.value.trim() || "", cur = currentTag();
  const list = (settings.tags || []).filter((t) => !q || fold(t.name).includes(fold(q)));
  const exact = (settings.tags || []).some((t) => fold(t.name) === fold(q));
  tagMenu.querySelector(".tm-body").innerHTML =
    (cur ? `<div class="tm-cur">${pillHTML(tagOf(cur) || { name: "?", color: "default" })}<button class="tm-x" data-tag="" title="${L("Remove tag", "Retirer le tag")}">×</button></div>` : "") +
    `<div class="tm-hint">${L("Select a tag or create one", "Choisis un tag ou crée-en un")}</div>` +
    list.map((t, i) => `<div class="tm-row${t.id === cur ? " sel" : ""}${i === 0 && q ? " hl" : ""}" data-tag="${t.id}">${pillHTML(t)}<span class="tm-check">${t.id === cur ? "✓" : ""}</span><button class="tm-more" data-edit="${t.id}" title="${L("Edit", "Modifier")}">⋯</button></div>`).join("") +
    (q && !exact ? `<div class="tm-row tm-create${list.length ? "" : " hl"}" data-create="1"><span class="tm-plus">+</span>${L("Create", "Créer")} ${pillHTML({ name: q, color: nextColor() })}</div>`
      : `<div class="tm-row tm-new" data-new="1"><span class="tm-plus">+</span>${L("New tag", "Nouveau tag")}</div>`);
}
tagMenu.addEventListener("input", renderTagMenu);
tagMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { tagMenu.hidden = true; e.stopPropagation(); return; }
  if (e.key !== "Enter") return;
  const hl = tagMenu.querySelector(".tm-row.hl") || tagMenu.querySelector(".tm-row[data-tag]");
  hl?.click();
});
tagMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  const edit = e.target.closest("[data-edit]");
  if (edit) { openTagEditor(edit, edit.dataset.edit); return; }
  if (e.target.closest("[data-new]")) { const i = tagMenu.querySelector(".tm-search"); i.placeholder = L("Name of the new tag, then Enter", "Nom du nouveau tag, puis Entrée"); i.focus(); return; }
  if (e.target.closest("[data-create]")) {
    const t = createTag(tagMenu.querySelector(".tm-search").value);
    send({ t: "tag", ...tagTarget, tag: t.id }); tagMenu.hidden = true; return;
  }
  const b = e.target.closest("[data-tag]"); if (!b) return;
  const id = b.dataset.tag;
  send({ t: "tag", ...tagTarget, tag: id === currentTag() ? "" : id }); // clicking the current tag removes it
  tagMenu.hidden = true;
});

// editor: rename, delete, color (same popover from the picker's ⋯ and from Settings)
const tagEdit = $("#tagEdit");
let editingTag = null;
function openTagEditor(anchor, id) {
  const t = tagOf(id); if (!t) return;
  editingTag = id;
  tagEdit.innerHTML = `<input class="te-name" value="${esc(t.name)}" maxlength="24" spellcheck="false">
    <button class="te-del" data-del="1"><span>🗑</span>${L("Delete", "Supprimer")}</button>
    <div class="te-lbl">${L("Colors", "Couleurs")}</div>
    ${COLOR_KEYS.map((c) => `<button class="te-color" data-color="${c}"><span class="te-sw" style="--tc:${TAG_COLORS[c][0]}"></span>${L(TAG_COLORS[c][2], TAG_COLORS[c][3])}<span class="te-ok">${t.color === c ? "✓" : ""}</span></button>`).join("")}`;
  place(tagEdit, anchor, false);
  const r = anchor.getBoundingClientRect();
  if (r.right + 8 + tagEdit.offsetWidth < innerWidth) tagEdit.style.left = r.right + 8 + "px";
  tagEdit.querySelector(".te-name").select();
}
const updateTag = (id, patch) => saveTags((settings.tags || []).map((t) => (t.id === id ? { ...t, ...patch } : t)));
function refreshTagUIs() { if (!tagMenu.hidden) renderTagMenu(); if (!$("#setBack").hidden) renderSettings(); }
tagEdit.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = e.target.closest("[data-color]");
  if (c) { updateTag(editingTag, { color: c.dataset.color }); tagEdit.querySelectorAll(".te-ok").forEach((x) => (x.textContent = "")); c.querySelector(".te-ok").textContent = "✓"; refreshTagUIs(); return; }
  if (e.target.closest("[data-del]")) { saveTags((settings.tags || []).filter((t) => t.id !== editingTag)); tagEdit.hidden = true; refreshTagUIs(); }
});
tagEdit.addEventListener("input", (e) => { if (e.target.classList.contains("te-name") && e.target.value.trim()) { updateTag(editingTag, { name: e.target.value.trim() }); if (!tagMenu.hidden) renderTagMenu(); } });
tagEdit.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") { tagEdit.hidden = true; e.stopPropagation(); refreshTagUIs(); } });
document.addEventListener("mousedown", (e) => {
  if (!tagEdit.hidden && !tagEdit.contains(e.target)) { tagEdit.hidden = true; refreshTagUIs(); if (tagMenu.contains(e.target)) return; }
  if (!tagMenu.hidden && !tagMenu.contains(e.target) && !tagEdit.contains(e.target)) tagMenu.hidden = true;
});

// settings: list of tags (drag to reorder, ⋯ to edit) + add
function tagManagerHTML(r, desc) {
  return `<div class="s-tags"><div class="s-lbl"><b>${esc(r.label)}</b><span>${esc(desc)}</span></div>
    <div class="tg-list">${(settings.tags || []).map((t) => `<div class="tg-row" draggable="true" data-id="${t.id}"><span class="tm-grip">⋮⋮</span>${pillHTML(t)}
      <span class="tg-count">${sessions.filter((x) => x.tag === t.id).length + history.filter((h) => h.tag === t.id && !h.open).length || ""}</span><button class="tm-more" data-tagedit="${t.id}" title="${L("Edit", "Modifier")}">⋯</button></div>`).join("")}
    <div class="tg-row tg-add"><span class="tm-plus">+</span><input id="tagNew" maxlength="24" placeholder="${L("Add a tag (e.g. Personal), then Enter", "Ajouter un tag (ex. Vie perso), puis Entrée")}" spellcheck="false"></div></div></div>`;
}
let dragId = null;
$("#setBody").addEventListener("dragstart", (e) => { const r = e.target.closest?.(".tg-row[data-id]"); if (r) { dragId = r.dataset.id; r.classList.add("dragging"); } });
$("#setBody").addEventListener("dragover", (e) => { if (dragId && e.target.closest(".tg-row[data-id]")) e.preventDefault(); });
$("#setBody").addEventListener("drop", (e) => {
  const over = e.target.closest(".tg-row[data-id]"); if (!dragId || !over) return;
  e.preventDefault();
  const tags = [...(settings.tags || [])], from = tags.findIndex((t) => t.id === dragId), to = tags.findIndex((t) => t.id === over.dataset.id);
  tags.splice(to, 0, tags.splice(from, 1)[0]); dragId = null; saveTags(tags);
});
$("#setBody").addEventListener("dragend", () => { dragId = null; });

// ---------------------------------------------------------------- setup check (Claude Code + Python)
function renderSetup() {
  const el = $("#setup");
  const missing = envInfo?.checked ? [!envInfo.claude && "claude", !envInfo.python && "python"].filter(Boolean) : [];
  el.hidden = !missing.length;
  if (!missing.length) return;
  const items = missing.map((k) => k === "claude"
    ? L(`<b>Claude Code</b> was not found. Install it, then sign in once in a terminal: <code>curl -fsSL https://claude.ai/install.sh | bash</code> then <code>claude</code>`,
        `<b>Claude Code</b> est introuvable. Installe-le puis connecte-toi une fois dans un terminal : <code>curl -fsSL https://claude.ai/install.sh | bash</code> puis <code>claude</code>`)
    : L(`<b>Python 3</b> was not found: conversations work, but Shoal cannot follow their status. Install it from <code>python.org</code> or with <code>xcode-select --install</code>.`,
        `<b>Python 3</b> est introuvable : les conversations fonctionnent, mais Shoal ne peut pas suivre leur état. Installe-le depuis <code>python.org</code> ou avec <code>xcode-select --install</code>.`));
  setHTML(el, `<div class="setup-body"><b class="setup-title">${L("Almost ready", "Presque prêt")}</b>${items.map((x) => `<p>${x}</p>`).join("")}</div>
    <button class="btn btn-ghost btn-sm" data-act="recheck">${L("Check again", "Vérifier à nouveau")}</button>`);
}
$("#setup").addEventListener("click", (e) => { if (e.target.closest('[data-act="recheck"]')) { send({ t: "recheck" }); e.target.closest("button").textContent = "…"; $("#setup")._h = null; } });

// ---------------------------------------------------------------- history
function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return L("Today", "Aujourd'hui");
  if (days === 1) return L("Yesterday", "Hier");
  if (days < 7) return d.toLocaleDateString(LOC(), { weekday: "long" });
  return d.toLocaleDateString(LOC(), { day: "numeric", month: "long" });
}
const fold = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function renderTabs() {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#convs").hidden = tab !== "convs";
  $("#hist").hidden = tab !== "hist";
  $("#histCount").textContent = history.length;
}

function renderHistory() {
  if (tab !== "hist") return;
  const q = fold($("#histSearch").value.trim());
  const items = history.filter((h) => passTag(h.tag) && (!q || fold(`${h.title} ${h.cwd} ${tagOf(h.tag)?.name || ""}`).includes(q)));
  if (!items.length) { setHTML($("#histList"), `<div class="h-empty">${q ? L("No topic found", "Aucun sujet trouvé") : L("History fills up as you have conversations", "L'historique se remplit au fil des conversations")}</div>`); return; }
  let last = "", html = "";
  for (const h of items) {
    const day = dayLabel(h.end);
    if (day !== last) { html += `<div class="h-day">${esc(day)}</div>`; last = day; }
    const time = new Date(h.end).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" });
    const sub = h.open ? `<span class="h-open">● ${L("Open", "Ouverte")}</span>` : `${time} · ${h.prompts} ${L("exchange", "échange")}${h.prompts > 1 ? "s" : ""} · ${esc(short(h.cwd))}`;
    html += `<div class="h-item" data-sid="${esc(h.sid)}" title="${h.open ? L("Go to conversation", "Aller à la conversation") : L("Resume conversation", "Reprendre la conversation")}">
      <div class="tile">${esc(h.emoji || "💬")}</div>
      <div class="h-body"><div class="h-title">${esc(h.title)}</div><div class="h-sub">${tagPill(h.tag)}${sub}</div></div>
      <span class="h-go">${h.open ? L("Go", "Aller") : L("Resume", "Reprendre")}</span>
      <button class="h-tagbtn" data-act="tag" title="${L("Tag", "Tag")}" aria-label="${L("Tag", "Tag")}">${TAG_ICON}</button>
      <button class="h-x" data-act="forget" title="${L("Remove from history", "Retirer de l'historique")}" aria-label="${L("Remove", "Retirer")}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>`;
  }
  setHTML($("#histList"), html);
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  tab = b.dataset.tab; localStorage.setItem("shoal.tab", tab); render();
  if (tab === "hist") $("#histSearch").focus();
}));
$("#histSearch").addEventListener("input", renderHistory);
$("#histList").addEventListener("click", (e) => {
  const it = e.target.closest(".h-item"); if (!it) return;
  if (e.target.closest('[data-act="forget"]')) { send({ t: "forget", sid: it.dataset.sid }); return; }
  if (e.target.closest('[data-act="tag"]')) { e.stopPropagation(); openTagMenu(e.target.closest('[data-act="tag"]'), { sid: it.dataset.sid }); return; }
  send({ t: "resume", sid: it.dataset.sid });
  tab = "convs"; localStorage.setItem("shoal.tab", tab); render();
});

function setMeter(el, pct) {
  el.style.width = Math.min(100, pct) + "%";
  el.style.background = pct >= 80 ? "var(--crit)" : pct >= 50 ? "var(--warn)" : "var(--good)";
}

function until(ts) {
  if (!ts) return "";
  const ms = (ts > 1e12 ? ts : ts * 1000) - Date.now();
  if (ms <= 0) return L("reset imminent", "reset imminent");
  const h = Math.floor(ms / 36e5), d = Math.floor(h / 24);
  return d >= 1 ? L(`resets in ${d} d ${h % 24} h`, `reset dans ${d} j ${h % 24} h`) : `${L("resets in", "reset dans")} ${h} h ${String(Math.floor((ms % 36e5) / 6e4)).padStart(2, "0")}`;
}

function renderUsage() {
  $("#usageCard").hidden = settings.showLimit === false; // plan without a weekly limit: card hidden
  const w = usage?.seven_day;
  render5h();
  if (!w) { $("#uPct").textContent = "—"; $("#uReset").textContent = L("waiting…", "en attente…"); return; }
  const pct = Math.round(w.used_percentage);
  $("#uPct").textContent = pct + " %";
  const r = w.resets_at ? new Date(w.resets_at * 1000) : null;
  // short on the row (day + time), full date and countdown on hover
  $("#uReset").textContent = r ? `${r.toLocaleDateString(LOC(), { weekday: "short" })} ${r.toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" })}` : "";
  $("#uReset").title = r ? `${L("Resets", "Reset")} ${r.toLocaleDateString(LOC(), { weekday: "long", day: "numeric", month: "long" })} · ${until(w.resets_at)}` : "";
  // color: today's pace vs. today's target (settings ⚙: weekly target / working days)
  const t = daily?.today, target = daily?.target || 20, warn = (daily?.warnAt || 80) / 100, weekly = daily?.weeklyTarget || 100;
  const level = t == null ? "" : t > target ? "over" : t > target * warn ? "near" : "ok";
  const bar = $("#uBar");
  bar.style.width = Math.min(100, pct) + "%";
  bar.style.background = pct > weekly || level === "over" ? "var(--crit)" : level === "near" ? "var(--warn)" : "var(--good)";
  // weekly target marker on the gauge (if below 100%)
  const mark = $("#uMark");
  mark.hidden = weekly >= 100; mark.style.left = weekly + "%"; mark.title = `${L("Weekly goal", "Objectif de la semaine")} : ${weekly} %`;
  $("#uToday").className = `today-row ${level}`;
  setHTML($("#uToday"), t == null ? "" : daily.weekend
    ? `<span class="dot"></span><span>${L(`Day off · ${t} % used today`, `Jour non travaillé · ${t} % utilisés aujourd'hui`)}</span>`
    : `<span class="dot"></span><span>${L("Today", "Aujourd'hui")} <b>${t}&nbsp;%</b> / ${target}&nbsp;% ${L("recommended", "recommandés")}${level === "over" ? L(" · exceeded", " · dépassé") : ""}</span>`);
  $("#u5h").textContent = pct > weekly ? L(`Weekly goal (${weekly} %) exceeded`, `Objectif de la semaine (${weekly} %) dépassé`) : "";
  if (level === "over" && !daily.weekend) warnOverOnce(t, target);
}

// 5-hour rolling window: its own gauge (a past window counts as 0 %)
function render5h() {
  const h = usage?.five_hour, ends = h?.resets_at ? h.resets_at * 1000 : 0, live = h && ends > Date.now();
  const p = live ? Math.round(h.used_percentage) : h ? 0 : null;
  $("#u5Pct").textContent = p == null ? "—" : p + " %";
  const bar = $("#u5Bar");
  bar.style.width = Math.min(100, p || 0) + "%";
  bar.style.background = p >= 90 ? "var(--crit)" : p >= 70 ? "var(--warn)" : "var(--good)";
  const ms = live ? ends - Date.now() : 0, hh = Math.floor(ms / 36e5), mm = String(Math.floor((ms % 36e5) / 6e4)).padStart(2, "0");
  $("#u5Reset").textContent = live ? `${hh} h ${mm}` : "";
  $("#u5Reset").title = live ? `${L("Resets at", "Reset à")} ${new Date(ends).toLocaleTimeString(LOC(), { hour: "2-digit", minute: "2-digit" })}` : "";
}
setInterval(() => { if (usage) render5h(); }, 60e3); // the countdown moves even without new data

// a single alert per day when today's target is exceeded ("Notify…" setting)
function warnOverOnce(t, target) {
  if (settings.overNotify === false || settings.showLimit === false) return;
  const k = "shoal.over." + new Date().toDateString();
  try { if (localStorage.getItem(k)) return; localStorage.setItem(k, "1"); } catch { return; }
  const body = L(`${t} % of your weekly limit used today, ${target} % recommended`, `${t} % de ta limite hebdo utilisés aujourd'hui, pour ${target} % recommandés`);
  if (settings.sound !== false) chime("waiting");
  infoToast("📊", L("Daily goal exceeded", "Objectif du jour dépassé"), body);
  if (settings.systemNotif !== false && !document.hasFocus() && "Notification" in window && Notification.permission === "granted")
    new Notification("📊 " + L("Daily goal exceeded", "Objectif du jour dépassé"), { body, silent: true });
}
function infoToast(emoji, title, sub) {
  const el = document.createElement("div");
  el.className = "toast waiting";
  el.innerHTML = `<div class="tile">${esc(emoji)}</div><div class="t-body"><div class="t-title">${esc(title)}</div><div class="t-sub">${esc(sub)}</div></div>`;
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  el.onclick = kill;
  $("#toasts").prepend(el);
  setTimeout(kill, 9000);
}

const fmtH = (h) => { const v = (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10).toString(); return LANG === "fr" ? v.replace(".", ",") : v; };
function weekLabel(w) {
  if (w.current) return L("This week", "Cette semaine");
  const [y, m, d] = w.key.split("-").map(Number), start = new Date(y, m - 1, d), end = new Date(y, m - 1, d + 4);
  return `${start.getDate()}–${end.toLocaleDateString(LOC(), { day: "numeric", month: "short" })}`;
}
function renderWeek() {
  if (weeks?.length) { weekIdx = Math.min(weekIdx, weeks.length - 1); week = weeks[weekIdx]; }
  if (!week) return;
  $("#pWeek").textContent = week.key ? weekLabel(week) : L("This week", "Cette semaine");
  $("#wkPrev").disabled = !weeks || weekIdx >= weeks.length - 1;
  $("#wkNext").disabled = !weeks || weekIdx === 0;
  if (!Array.isArray(week.tasks)) { // server not restarted yet
    $("#pSaved").textContent = "—"; $("#pSub").textContent = L("Restart Shoal to enable task tracking", "Redémarre Shoal pour activer le suivi des tâches"); $("#pTasks").innerHTML = ""; return;
  }
  const rb = $("#pRefresh"); rb.hidden = week.current === false; rb.classList.toggle("busy", judging > 0); rb.disabled = judging > 0;
  rb.title = judging > 0 ? L("Updating the hours…", "Mise à jour des temps…") : L("Update the hours now", "Mettre à jour les temps maintenant");
  $("#pSaved").textContent = fmtH(week.savedH);
  $("#prodSummary .ps-go-txt").textContent = $("#prodCard").classList.contains("open") ? L("Collapse", "Réduire") : L("Details", "Détails");
  $("#psSaved").textContent = fmtH(week.savedH);
  document.querySelector(".ps-lbl").textContent = week.current === false ? `${L("saved", "économisées")} · ${weekLabel(week)}` : L("saved", "économisées");
  $("#prodSummary").title = `${weekLabel(week)}${week.tasks?.length ? ` · ${week.done} / ${week.tasks.length} ${L("tasks done", "tâches faites")}` : ""}`;
  $("#pCount").textContent = week.tasks.length ? `${week.done} / ${week.tasks.length} ${L("done", "faites")}` : "";
  $("#pSub").textContent = week.tasks.length ? "" : week.current === false ? L("No tasks that week", "Aucune tâche cette semaine-là") : L("Tasks appear as you work with Claude", "Les tâches apparaissent au fil de tes conversations");
  // ranking by time saved, full list on demand
  const ranked = week.tasks.slice().sort((a, b) => b.savedH - a.savedH);
  const shown = showAllTasks ? ranked : ranked.slice(0, TOP_N);
  $("#pMore").hidden = ranked.length <= TOP_N;
  $("#pMore").textContent = showAllTasks ? L("Show less", "Réduire") : L(`See full ranking (${ranked.length} tasks)`, `Voir le classement complet (${ranked.length} tâches)`);
  $("#pTasks").classList.toggle("all", showAllTasks);
  setHTML($("#pTasks"), shown.map((t, i) => `
    <li class="task ${t.status}" data-task="${t.id}">
      <span class="t-rank">${i + 1}</span><span class="t-emo">${esc(t.emoji || "📌")}</span>
      <span class="t-name" data-tip="${esc(`<b>${esc(t.title)}</b><br>≈ ${fmtH(t.savedH)} h ${L("of work saved", "de travail économisées")}${(t.items || []).length ? "<br><br>" + t.items.map((i) => `· ${esc(i.quoi)} — ${i.min >= 60 ? fmtH(i.min / 60) + " h" : i.min + " min"}`).join("<br>") + (t.nItems > t.items.length ? L(`<br>… and ${t.nItems - t.items.length} more items`, `<br>… et ${t.nItems - t.items.length} autres éléments`) : "") : t.livrables.length ? "<br>" + L("Delivered", "Livré") + " : " + esc(t.livrables.join(" ; ")) : ""}`)}">${esc(t.title)}</span>
      <button class="t-h${t.adjusted ? " adjusted" : ""}" data-act="hours" title="${t.adjusted ? L(`Adjusted by you (estimate: ${fmtH(t.computedH)} h). Click to edit`, `Corrigé par toi (estimation : ${fmtH(t.computedH)} h). Clic pour modifier`) : L("Click to adjust", "Clic pour corriger")}">+${fmtH(t.savedH)} h</button>
      <button class="t-status" data-act="toggle" title="${L("Click to change", "Cliquer pour changer")}">${t.status === "faite" ? L("Done", "Faite") : L("In progress", "En cours")}</button>
      <button class="t-x" data-act="remove" title="${L("Not a task: remove", "Ce n'est pas une tâche : retirer")}" aria-label="${L("Remove", "Retirer")}">×</button>
    </li>`).join(""));
}

$("#wkPrev").addEventListener("click", () => { weekIdx++; renderWeek(); });
$("#pMore").addEventListener("click", () => { showAllTasks = !showAllTasks; renderWeek(); });
// the hours card is one line (hours saved); a click opens the details over the column
const prodCard = $("#prodCard");
// accordion inside the column: opening takes room from the conversation list (never covers the limits card);
// the header (hours + chevron) stays visible and closes it again; the state is remembered
function setProdOpen(open) {
  prodCard.classList.toggle("open", open);
  $("#prodSummary").setAttribute("aria-expanded", String(open));
  $("#prodSummary .ps-go-txt").textContent = open ? L("Collapse", "Réduire") : L("Details", "Détails");
  try { localStorage.setItem("shoal.prodOpen", open ? "1" : ""); } catch {}
  if (open) { showAllTasks = true; renderWeek(); }
}
$("#prodSummary").addEventListener("click", (e) => { e.stopPropagation(); setProdOpen(!prodCard.classList.contains("open")); });
try { if (localStorage.getItem("shoal.prodOpen")) setProdOpen(true); } catch {}
$("#wkNext").addEventListener("click", () => { weekIdx = Math.max(0, weekIdx - 1); renderWeek(); });
$("#pRefresh").addEventListener("click", (e) => { e.stopPropagation(); send({ t: "tasksRefresh" }); });

// tooltips (tasks + method)
const tip = $("#tip");
function showTip(el, html) {
  tip.innerHTML = html; tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)) + "px";
  tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + "px";
}
$("#pTasks").addEventListener("mouseover", (e) => { const n = e.target.closest("[data-tip]"); if (n) showTip(n, n.dataset.tip); });
$("#pTasks").addEventListener("mouseleave", () => (tip.hidden = true));
const METHOD = () => LANG !== "fr"
  ? "<b>How it's calculated</b><br>When a conversation pauses for a few minutes (or when you click Refresh), every item Claude actually produced since the last update (a fix, a feature, an email, a slide…) is classified by size, from XS to XL, against fixed reference points (e.g. dev: small fix 30 min, contained feature 75 min, feature touching data + UI or a script with real logic such as image processing 3 h, new app 7 h). The duration comes from that table, not from the model. Safeguards: improving or redoing something already counted is an iteration (30 min at most); the code Claude wrote can only cap the size, since it writes 3 to 5 times more lines than a developer would; a batch never counts more than 12 times Claude's working time. The time you spent steering the AI is subtracted. Click a task's hours to correct them: your corrections adjust future estimates for that type of work."
  : "<b>Comment c'est calculé</b><br>Quand une conversation marque une pause de quelques minutes (ou quand tu cliques sur Rafraîchir), chaque élément réellement produit par Claude depuis la dernière mise à jour (un correctif, une fonctionnalité, un mail, une slide…) est classé par taille, de XS à XL, selon des repères fixes (ex. dev : petit correctif 30 min, fonctionnalité contenue 75 min, fonctionnalité qui touche données + interface ou script avec une vraie logique comme du traitement d'image 3 h, nouvelle app 7 h). La durée vient de ce tableau, pas du modèle. Garde-fous : améliorer ou refaire quelque chose de déjà compté est une itération (30 min au plus) ; le code écrit par Claude sert seulement de plafond, car il écrit 3 à 5 fois plus de lignes qu'un développeur ; un lot ne compte jamais plus de 12 fois le temps de travail de Claude. Le temps passé à piloter l'IA est retiré. Clique sur les heures d'une tâche pour les corriger : tes corrections ajustent les estimations suivantes pour ce type de travail.";
$("#pInfo").addEventListener("mouseenter", (e) => showTip(e.target, METHOD()));
$("#pInfo").addEventListener("mouseleave", () => (tip.hidden = true));
$("#pTasks").addEventListener("click", (e) => {
  const li = e.target.closest(".task"); if (!li) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "hours") {
    const btn = e.target.closest(".t-h"), cur = btn.textContent.replace(/[^\d,]/g, "").replace(",", ".");
    const inp = document.createElement("input");
    Object.assign(inp, { type: "number", step: "0.25", min: "0", value: cur, className: "t-h-input", title: L("Hours saved · Enter to confirm · empty = automatic estimate", "Heures économisées · Entrée pour valider · vide = estimation automatique") });
    btn.replaceWith(inp); inp.focus(); inp.select();
    const done = (save) => {
      if (save) send({ t: "taskHours", task: li.dataset.task, week: week?.key, hours: inp.value === "" ? null : Number(inp.value), reset: inp.value === "" });
      $("#pTasks")._h = null; renderWeek();
    };
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); ev.stopPropagation(); });
    inp.addEventListener("blur", () => done(false));
    return;
  }
  if (act === "toggle") send({ t: "taskStatus", task: li.dataset.task, week: week?.key, status: li.classList.contains("faite") ? "en_cours" : "faite" });
  if (act === "remove") { li.remove(); $("#pTasks")._h = null; tip.hidden = true; send({ t: "taskRemove", task: li.dataset.task }); }
});

// ---------------------------------------------------------------- interactions
$("#convs").addEventListener("click", (e) => {
  const li = e.target.closest(".conv"); if (!li) return;
  const id = li.dataset.id, act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "close") { send({ t: "close", id }); li.classList.add("closing"); return; }
  if (act === "tag") { e.stopPropagation(); openTagMenu(e.target.closest("[data-act]"), { id }); return; }
  if (act === "cancel") { confirming = null; render(); return; }
  if (act === "kill") { confirming = null; send({ t: "close", id }); return; }
  if (act === "allow" || act === "deny") { answer(id, act === "allow"); return; }
  confirming = null;
  select(id);
});
$("#convs").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.id) select(e.target.dataset.id); });

document.querySelectorAll('[data-action="new"]').forEach((b) => b.addEventListener("click", () => send({ t: "new" })));

const menu = $("#folderMenu");
$("#folderBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  if (menu.hidden) return;
  menu.innerHTML = `<div class="m-label">${L("New conversation in…", "Nouvelle conversation dans…")}</div>` +
    recents.map((r) => `<button data-cwd="${esc(r)}"><span>📁</span><span class="path">${esc(short(r))}</span></button>`).join("") +
    `<div class="m-label">${L("Other folder", "Autre dossier")}</div><input id="cwdInput" class="mono" placeholder="${L("~/my-project then Enter", "~/mon-projet puis Entrée")}"
       style="width:100%;background:var(--raised);border:1px solid var(--border-strong);border-radius:8px;color:var(--text);padding:8px">`;
  $("#cwdInput").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const v = ev.target.value.trim().replace(/^~/, recents.find((r) => /^\/Users\/[^/]+$/.test(r)) || "~");
    if (v) send({ t: "new", cwd: v }); menu.hidden = true;
  });
});
menu.addEventListener("click", (e) => { const b = e.target.closest("[data-cwd]"); if (b) { send({ t: "new", cwd: b.dataset.cwd }); menu.hidden = true; } });
document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.hidden = true; });

// rename: double-click the title
const fTitle = $("#fTitle");
fTitle.addEventListener("dblclick", () => {
  fTitle.contentEditable = "true"; fTitle.focus();
  document.getSelection().selectAllChildren(fTitle);
});
fTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); fTitle.blur(); }
  if (e.key === "Escape") { fTitle.textContent = sessions.find((s) => s.id === active)?.title || ""; fTitle.blur(); }
});
fTitle.addEventListener("blur", () => {
  if (fTitle.contentEditable !== "true") return;
  fTitle.contentEditable = "false";
  const v = fTitle.textContent.trim();
  if (v && active) send({ t: "rename", id: active, title: v });
  terms.get(active)?.term.focus();
});

// shortcuts: ⌘1-9 go to · ⌘J next waiting · ⌘K new conversation
function handleShortcut(e) {
  if (/^[1-9]$/.test(e.key)) { const s = sessions[+e.key - 1]; if (s) select(s.id); return true; }
  if (e.key.toLowerCase() === "j") {
    const order = sessions.filter((s) => s.id !== active && (s.state === "waiting" || (s.state === "done" && s.unread)))
      .sort((a, b) => (a.state === "waiting" ? 0 : 1) - (b.state === "waiting" ? 0 : 1));
    if (order[0]) select(order[0].id);
    return true;
  }
  if (e.key.toLowerCase() === "k") { send({ t: "new" }); return true; }
  return false;
}
document.addEventListener("keydown", (e) => { if (isShortcut(e) && handleShortcut(e)) e.preventDefault(); }, true);

// ---------------------------------------------------------------- pasted / dropped images
async function attach(files) {
  if (!active || !files.length) return;
  const paths = [];
  for (const f of files) {
    try {
      const r = await fetch(`/upload?name=${encodeURIComponent(f.name || "capture.png")}`, { method: "POST", headers: { "x-shoal-token": TOKEN }, body: f });
      if (r.ok) paths.push((await r.json()).path);
    } catch {}
  }
  // sent as a terminal paste: Claude Code then turns each image path into an [Image #n] attachment
  for (const p of paths) send({ t: "in", id: active, data: "\x1b[200~" + p + "\x1b[201~" });
  if (paths.length) terms.get(active)?.term.focus();
}
document.addEventListener("paste", (e) => {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
  if (!imgs.length) return;              // text: normal paste
  e.preventDefault(); e.stopPropagation();
  attach(imgs);
}, true);
const card = $(".term-card");
let dragDepth = 0;
card.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; card.classList.add("dropping"); } });
card.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; card.classList.remove("dropping"); } });
card.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
card.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; card.classList.remove("dropping");
  attach([...(e.dataTransfer?.files || [])]);
});
window.addEventListener("dragover", (e) => e.preventDefault());   // prevents opening the file in place of the app
window.addEventListener("drop", (e) => e.preventDefault());

// ---------------------------------------------------------------- static page text (index.html)
// Each element carries data-en="English" (and data-en-title / data-en-ph / data-en-aria); the French is the original text.
function translateStatic() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll("[data-en]")) {
    if (el.dataset.fr == null) el.dataset.fr = el.innerHTML;
    el.innerHTML = LANG === "fr" ? el.dataset.fr : el.dataset.en;
  }
  for (const [attr, key] of [["title", "enTitle"], ["placeholder", "enPh"], ["aria-label", "enAria"]]) {
    for (const el of document.querySelectorAll(`[data-${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}]`)) {
      const frKey = "fr" + key.slice(2);
      if (el.dataset[frKey] == null) el.dataset[frKey] = el.getAttribute(attr) || "";
      el.setAttribute(attr, LANG === "fr" ? el.dataset[frKey] : el.dataset[key]);
    }
  }
}
// shortcut hints in the page follow the platform (before the first translation)
$(".kbd-hint").textContent = kbd("k");
for (const el of document.querySelectorAll("#setBtn")) { el.title = el.title.replace("⌘,", kbd(",")); el.dataset.enTitle = el.dataset.enTitle.replace("⌘,", kbd(",")); }
translateStatic();

// ---------------------------------------------------------------- settings (⚙ or ⌘,)
// logo variant of the theme's gem (light themes use the same logo as their dark version)
const LOGO = { amethyst: "icon-amethyst.png", lavender: "icon-amethyst.png", amber: "icon-amber.png", "amber-light": "icon-amber.png", dark: "icon-aquamarine.png", light: "icon-aquamarine.png" };
try { const th = localStorage.getItem("shoal.theme"); if (LOGO[th]) $("#logo").src = "/" + LOGO[th]; } catch {} // no flash of the default logo
function applyTheme() {
  const th = TERM_THEMES[settings.theme] ? settings.theme : "malachite";
  $("#logo").src = "/" + (LOGO[th] || "icon.png");
  if (th === "malachite") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th;
  try { localStorage.setItem("shoal.theme", th); } catch {}
  for (const t of terms.values()) t.term.options.theme = termTheme();
  for (const id of ["#convs", "#histList", "#tagBar"]) $(id)._h = null; // tag pill colors depend on the theme
}
function applySettings() {
  if (applySettings.theme !== settings.theme) { applySettings.theme = settings.theme; applyTheme(); }
  const side = settings.sidebar === "left" ? "left" : "right";
  if (document.documentElement.dataset.side !== side) { document.documentElement.dataset.side = side; try { localStorage.setItem("shoal.side", side); } catch {} requestAnimationFrame(fitActive); }
  const lang = settings.lang === "fr" ? "fr" : "en";
  if (lang !== LANG || !applySettings.done) {
    LANG = lang; applySettings.done = true;
    try { localStorage.setItem("shoal.lang", lang); } catch {}
    translateStatic();
    for (const el of document.querySelectorAll("[data-h]")) el._h = null; // force re-render in the new language
    $("#convs")._h = $("#histList")._h = $("#pTasks")._h = $("#uToday")._h = null;
    document.querySelectorAll(".toast").forEach((t) => t.remove());
  }
  for (const [id, t] of terms) {
    if (settings.fontSize && t.term.options.fontSize !== settings.fontSize) { t.term.options.fontSize = settings.fontSize; if (id === active) requestAnimationFrame(fitActive); }
    if (settings.scrollback && t.term.options.scrollback !== settings.scrollback) t.term.options.scrollback = settings.scrollback;
  }
  $("#prodCard").hidden = settings.productivity === false;
  if (!$("#setBack").hidden) renderSettings();
}

const WD = () => LANG === "fr" ? [[1, "L"], [2, "M"], [3, "M"], [4, "J"], [5, "V"], [6, "S"], [0, "D"]] : [[1, "M"], [2, "T"], [3, "W"], [4, "T"], [5, "F"], [6, "S"], [0, "S"]];
const SETTINGS_UI = () => [
  { id: "appearance", title: L("Appearance", "Apparence"), rows: [
    { key: "theme", type: "themes", label: L("Theme", "Thème") },
    { key: "sidebar", type: "seg", label: L("Sidebar position", "Position de la colonne"), desc: L("Conversations, weekly limit and hours saved", "Conversations, limite de la semaine et heures économisées"), options: [["left", L("Left", "Gauche")], ["right", L("Right", "Droite")]] },
    { key: "fontSize", type: "num", min: 10, max: 20, step: 1, unit: "px", label: L("Terminal text size", "Taille du texte du terminal") },
  ] },
  { id: "general", title: L("General", "Général"), rows: [
    { key: "lang", type: "seg", label: L("Language", "Langue"), options: [["en", "English"], ["fr", "Français"]] },
    { key: "tour", type: "action", label: L("Quick tour of the interface", "Visite rapide de l'interface"), button: L("Show", "Afficher") },
    { key: "keepRunning", type: "toggle", label: L("Keep conversations running after quitting", "Garder les conversations actives après avoir quitté"),
      desc: L(`Otherwise quitting Shoal${IS_MAC ? " (⌘Q)" : ""} stops them; they are resumed at the next launch`, `Sinon quitter Shoal${IS_MAC ? " (⌘Q)" : ""} les arrête ; elles sont reprises au lancement suivant`) },
  ] },
  { id: "notifications", title: "Notifications", rows: [
    { key: "notifyDone", type: "toggle", label: L("Conversation finished", "Conversation terminée"), desc: L("Alert when Claude is done and hands back to you", "Alerte quand Claude a fini et te rend la main") },
    { key: "notifyWaiting", type: "toggle", label: L("Question or permission", "Question ou autorisation"), desc: L("Alert when Claude is waiting for your reply or approval", "Alerte quand Claude attend ta réponse ou ton accord") },
    { key: "systemNotif", type: "toggle", label: IS_MAC ? L("macOS notifications", "Notifications macOS") : L("System notifications", "Notifications système"), desc: L("When Shoal isn't in the foreground", "Quand Shoal n'est pas au premier plan") },
    { key: "sound", type: "toggle", label: L("Sound", "Son"), desc: L("A short chime with each alert", "Petit carillon avec chaque alerte") },
    { key: "badge", type: "seg", label: L("Dock badge", "Pastille du Dock"), desc: L("What the icon counts", "Ce qui est compté sur l'icône"),
      options: [["all", L("All", "Tout")], ["waiting", L("Waiting", "Attentes")], ["none", L("None", "Rien")]] },
  ] },
  { id: "limit", title: L("Usage limit", "Limite d'utilisation"), rows: [
    { key: "showLimit", type: "toggle", label: L("Track the weekly limit", "Suivre la limite de la semaine"), desc: L("Turn off if your plan has no weekly limit", "À couper si ton offre n'a pas de limite hebdomadaire") },
    { key: "weeklyTarget", type: "num", min: 5, max: 100, step: 5, unit: "%", label: L("Weekly goal", "Objectif de la semaine"), desc: L("Share of your weekly limit you allow yourself", "Part de ta limite hebdo que tu t'autorises à utiliser"), needs: "showLimit" },
    { key: "workdays", type: "days", label: L("Working days", "Jours travaillés"), desc: L("The weekly goal is spread over these days", "L'objectif de la semaine est réparti sur ces jours"), needs: "showLimit" },
    { key: "dailyTarget", type: "num", min: 1, max: 100, step: 1, unit: "%", auto: true, label: L("Daily goal", "Objectif par jour"), desc: () => L(`Empty = automatic (${autoPreview()} % per day)`, `Vide = automatique (${autoPreview()} % par jour)`), needs: "showLimit" },
    { key: "warnAt", type: "num", min: 30, max: 100, step: 5, unit: "%", label: L("Turn orange at", "Passer à l'orange à"), desc: L("of the daily goal", "de l'objectif du jour"), needs: "showLimit" },
    { key: "overNotify", type: "toggle", label: L("Warn when the daily goal is exceeded", "Prévenir si l'objectif du jour est dépassé"), desc: L("One alert per day, when it happens", "Une alerte par jour, au moment du dépassement"), needs: "showLimit" },
  ] },
  { id: "new", title: L("New conversations", "Nouvelles conversations"), rows: [
    { key: "defaultCwd", type: "text", label: L("Default folder", "Dossier par défaut"), desc: L("Empty = last folder used", "Vide = le dernier dossier utilisé"), placeholder: "~/Claude" },
    { key: "defaultModel", type: "select", label: L("Model", "Modèle"), desc: L("For new conversations (a resumed one keeps its own)", "Pour les nouvelles conversations (une reprise garde le sien)"),
      options: [["", L("Claude Code setting", "Réglage de Claude Code")], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]] },
    { key: "autoName", type: "toggle", label: L("Automatic emoji and title", "Emoji et titre automatiques"), desc: L("Picked by Haiku from the first message. Otherwise: its first words", "Choisis par Haiku au 1er message. Sinon : les premiers mots du message") },
  ] },
  { id: "tags", title: "Tags", rows: [
    { key: "autoTag", type: "toggle", label: L("Tag new conversations automatically", "Taguer automatiquement les nouvelles conversations"),
      desc: L("Haiku picks one of your tags from the first message, or none if nothing fits. You can change it at any time", "Haiku choisit un de tes tags d'après le 1er message, ou aucun si rien ne correspond. Tu peux le changer à tout moment") },
    { key: "tags", type: "tags", label: L("Your tags", "Tes tags"), desc: L("To sort conversations by project, company or personal life. Click a tag to rename it or change its color, drag to reorder", "Pour classer les conversations par projet, société ou vie perso. Clic sur un tag pour le renommer ou changer sa couleur, glisser pour réordonner") },
  ] },
  { id: "history", title: L("History", "Historique"), rows: [
    { key: "importHistory", type: "toggle", label: L("Show conversations made in the terminal", "Afficher les conversations faites dans le terminal"),
      desc: L("Your Claude Code conversations of the last 30 days (2 messages or more) appear in History and can be resumed. Read locally", "Tes conversations Claude Code des 30 derniers jours (2 messages ou plus) apparaissent dans l'Historique et peuvent être reprises. Lecture locale") },
    { key: "importNow", type: "action", label: L("Import now", "Importer maintenant"), button: L("Import", "Importer"), needs: "importHistory" },
  ] },
  { id: "terminal", title: "Terminal", rows: [
    { key: "scrollback", type: "seg", label: L("Lines kept in memory", "Lignes gardées en mémoire"), desc: L("Per conversation. Fewer lines = less memory", "Par conversation. Moins de lignes = moins de mémoire"),
      options: [[2000, "2k"], [5000, "5k"], [10000, "10k"], [20000, "20k"]] },
  ] },
  { id: "productivity", title: L("Productivity", "Productivité"), rows: [
    { key: "productivity", type: "toggle", label: L("Track hours saved", "Suivi des heures économisées"), desc: L("Haiku reviews your exchanges in batches, after each pause (tasks, hours, status line). Turning it off removes these calls", "Haiku analyse tes échanges par lots, à chaque pause (tâches, heures, ligne « où j'en suis »). Le couper supprime ces appels") },
  ] },
];
const autoPreview = () => Math.max(1, Math.round((settings.weeklyTarget || 100) / Math.max(1, (settings.workdays || []).length)));

// defaults (same as the server): a never-touched setting still shows as selected
const SETTING_DEFAULTS = { sidebar: "right", theme: "malachite", lang: "en", keepRunning: false, importHistory: true, tags: [], autoTag: true, notifyDone: true, notifyWaiting: true, systemNotif: true, sound: true, badge: "all", showLimit: true, weeklyTarget: 100,
  workdays: [1, 2, 3, 4, 5], dailyTarget: 0, warnAt: 80, overNotify: true, defaultCwd: "", defaultModel: "", autoName: true, fontSize: 13, scrollback: 5000, productivity: true };
function control(r) {
  const v = r.key === "lang" ? LANG : settings[r.key] ?? SETTING_DEFAULTS[r.key];
  if (r.type === "toggle") return `<button class="switch" role="switch" aria-checked="${v !== false}" data-k="${r.key}" aria-label="${esc(r.label)}"><i></i></button>`;
  if (r.type === "seg") return `<div class="seg">${r.options.map(([val, lbl]) => `<button data-k="${r.key}" data-v="${esc(val)}" class="${String(v) === String(val) ? "on" : ""}">${esc(lbl)}</button>`).join("")}</div>`;
  if (r.type === "days") return `<div class="seg days">${WD().map(([d, l]) => `<button data-k="workdays" data-d="${d}" class="${(v || []).includes(d) ? "on" : ""}" title="${dayLong(d)}">${l}</button>`).join("")}</div>`;
  if (r.type === "select") return `<select class="s-input" data-k="${r.key}">${r.options.map(([val, lbl]) => `<option value="${esc(val)}" ${v === val ? "selected" : ""}>${esc(lbl)}</option>`).join("")}</select>`;
  if (r.type === "num") return `<span class="s-num"><input class="s-input" type="number" data-k="${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.auto && !v ? "" : v ?? ""}" placeholder="${r.auto ? autoPreview() : ""}"><span>${r.unit || ""}</span></span>`;
  if (r.type === "themes") return "";
  if (r.type === "action") return `<button class="btn btn-ghost btn-sm" data-run="${r.key}">${esc(r.button)}</button>`;
  if (r.type === "tags") return "";
  if (r.type === "text") return `<input class="s-input s-text mono" data-k="${r.key}" value="${esc(short(v || ""))}" placeholder="${esc(r.placeholder || "")}" spellcheck="false">`;
  return "";
}


// four gems, each in a dark and a light version (internal ids kept: "dark"/"light" = aquamarine, "lavender" = amethyst light)
const THEME_LIST = () => [
  ["malachite", "Malachite", ["#030913", "#050E18", "#0B1E2C", "#3FE5AD", "#5E7A73"]],
  ["amethyst", L("Amethyst", "Améthyste"), ["#0B0716", "#0E0A1B", "#1B1331", "#B48CFF", "#77698F"]],
  ["amber", L("Amber", "Ambre"), ["#0F0B05", "#120D06", "#20180D", "#FFB02E", "#85755E"]],
  ["dark", L("Aquamarine", "Aigue-marine"), ["#111214", "#141517", "#1F2023", "#3CCFE0", "#6B6F75"]],
  ["malachite-light", L("Malachite light", "Malachite clair"), ["#EEF7F3", "#FBFEFD", "#E6F3EE", "#00A37C", "#BFD9CF"]],
  ["lavender", L("Amethyst light", "Améthyste clair"), ["#F5F2FB", "#FDFCFF", "#EFEAF9", "#7C4DDB", "#D5CBEA"]],
  ["amber-light", L("Amber light", "Ambre clair"), ["#FBF6EE", "#FFFDF8", "#F6EEE1", "#D97706", "#E3D3BA"]],
  ["light", L("Aquamarine light", "Aigue-marine clair"), ["#F4F5F7", "#FFFFFF", "#F0F1F4", "#0A7A8C", "#CDD2DA"]],
];
function themePickerHTML() {
  const cur = settings.theme || "malachite";
  return `<div class="s-row s-col"><div class="s-lbl"><b>${L("Theme", "Thème")}</b>${isLightTheme() ? `<span>${L("Tip: in Claude Code, type /theme and pick a light theme so its text stays readable.", "Astuce : dans Claude Code, tape /theme et choisis un thème clair pour que son texte reste lisible.")}</span>` : ""}</div>
    <div class="themes">${THEME_LIST().map(([id, name, c]) => `<button class="theme-card${cur === id ? " on" : ""}" data-theme-pick="${id}">
      <span class="theme-prev" style="--p-bg:${c[0]};--p-term:${c[1]};--p-side:${c[2]};--p-acc:${c[3]};--p-line:${c[4]}"><i></i><b></b></span><span class="theme-name">${esc(name)}</span></button>`).join("")}</div></div>`;
}
let setSection = "appearance";
function renderSettings() {
  const body = $("#setBody");
  const focused = document.activeElement?.closest?.("#setBody") ? document.activeElement.dataset.k : null;
  if (focused && document.activeElement.tagName === "INPUT") return; // don't overwrite ongoing input
  const secs = SETTINGS_UI();
  if (!secs.some((x) => x.id === setSection)) setSection = secs[0].id;
  // sidebar: one section at a time instead of one long page
  $("#setNav").innerHTML = secs.map((x) => `<button class="${x.id === setSection ? "on" : ""}" data-sec="${x.id}">${esc(x.title)}</button>`).join("");
  body.innerHTML = secs.filter((x) => x.id === setSection).map((sec) => `<section class="s-sec"><h3>${esc(sec.title)}</h3>${sec.rows.map((r) => {
    const off = r.needs && settings[r.needs] === false;
    const desc = typeof r.desc === "function" ? r.desc() : r.desc;
    if (r.type === "tags") return tagManagerHTML(r, desc);
    if (r.type === "themes") return themePickerHTML();
    return `<div class="s-row${off ? " off" : ""}"><div class="s-lbl"><b>${esc(r.label)}</b>${desc ? `<span>${esc(desc)}</span>` : ""}</div><div class="s-ctl">${control(r)}</div></div>`;
  }).join("")}</section>`).join("");
}

let savedTimer;
function saveSetting(patch) {
  Object.assign(settings, patch); // show immediately; the server sends back the validated value
  send({ t: "settings", patch });
  renderSettings(); applySettings();
  const f = $("#setSaved"); f.classList.add("show"); clearTimeout(savedTimer); savedTimer = setTimeout(() => f.classList.remove("show"), 1400);
}
$("#setNav").addEventListener("click", (e) => { const b = e.target.closest("[data-sec]"); if (b) { setSection = b.dataset.sec; renderSettings(); $("#setBody").scrollTop = 0; } });
$("#setBody").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-theme-pick]");
  if (pick) { saveSetting({ theme: pick.dataset.themePick }); return; }
  const run = e.target.closest("[data-run]");
  if (run?.dataset.run === "importNow") { send({ t: "importHistory" }); run.textContent = "…"; return; }
  if (run?.dataset.run === "tour") { startTour(); return; }
  const ed = e.target.closest("[data-tagedit]") || (e.target.closest(".tg-row[data-id] .tagpill") && e.target.closest(".tg-row"));
  if (ed) { e.stopPropagation(); openTagEditor(ed, ed.dataset.tagedit || ed.dataset.id); return; }
  const b = e.target.closest("button[data-k]"); if (!b) return;
  const k = b.dataset.k;
  if (b.classList.contains("switch")) saveSetting({ [k]: settings[k] === false });
  else if (k === "workdays") {
    const d = Number(b.dataset.d), cur = new Set(settings.workdays || []);
    cur.has(d) ? cur.delete(d) : cur.add(d);
    if (cur.size) saveSetting({ workdays: [...cur] });
  } else {
    const r = SETTINGS_UI().flatMap((x) => x.rows).find((x) => x.key === k);
    const val = r.options.find(([v]) => String(v) === b.dataset.v)[0];
    saveSetting({ [k]: val });
  }
});
$("#setBody").addEventListener("change", (e) => {
  const el = e.target;
  const k = el.dataset.k; if (!k) return;
  if (el.type === "number") saveSetting({ [k]: el.value === "" ? "" : Number(el.value) });
  else if (k === "defaultCwd") saveSetting({ [k]: el.value.trim().replace(/^~(?=\/|$)/, homeDir || "~") });
  else saveSetting({ [k]: el.value });
  el.blur();
});
$("#setBody").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "tagNew" && e.target.value.trim()) {
    e.target.blur(); createTag(e.target.value); setTimeout(() => $("#tagNew")?.focus(), 30);
    return;
  }
  if (e.key === "Enter" && e.target.tagName === "INPUT") e.target.blur();
});

function openSettings(open = true, section) {
  if (section) setSection = section;
  $("#setBack").hidden = !open;
  if (open) { renderSettings(); send({ t: "stats" }); $("#setClose").focus(); }
  else terms.get(active)?.term.focus();
}
function renderStats(m) {
  const mb = (b) => Math.round(b / 1048576);
  $("#setStats").title = `Shoal ${appVersion}`;
  $("#setStats").textContent = L(`Server: ${mb(m.rss)} MB · terminal buffers: ${mb(m.buffers)} MB · ${m.haiku} Haiku call${m.haiku > 1 ? "s" : ""} in ${Math.round(m.uptime / 3600)} h`,
    `Serveur : ${mb(m.rss)} Mo · tampons des terminaux : ${mb(m.buffers)} Mo · ${m.haiku} appel${m.haiku > 1 ? "s" : ""} Haiku depuis ${Math.round(m.uptime / 3600)} h`);
}
window.shoal?.onOpenSettings?.(() => openSettings(true)); // app menu → Settings…
$("#setBtn").addEventListener("click", (e) => { e.stopPropagation(); openSettings(true); });
$("#setClose").addEventListener("click", () => openSettings(false));
$("#setBack").addEventListener("mousedown", (e) => { if (e.target.id === "setBack") openSettings(false); });
document.addEventListener("keydown", (e) => {
  if (isShortcut(e) && (e.key === "," || e.key === "<")) { e.preventDefault(); openSettings($("#setBack").hidden); }
  else if (e.key === "Escape" && !$("#setBack").hidden && tagEdit.hidden && tagMenu.hidden) { e.stopPropagation(); openSettings(false); }
}, true);


// ---------------------------------------------------------------- first-launch tour: each panel highlighted in turn, the rest dimmed
const TOUR = () => [
  { sel: ".term-card", title: L("Your conversation", "Ta conversation"),
    text: L("The conversation you're working on, in large. It's the real Claude Code: type, paste or drop images here.", "La conversation sur laquelle tu travailles, en grand. C'est le vrai Claude Code : tape, colle ou dépose des images ici.") },
  { sel: ".new-row", title: L("New conversation", "Nouvelle conversation"),
    text: L(`Start as many as you need (${kbd("k")}). The folder button lets you pick where it starts.`, `Lance-en autant que tu veux (${kbd("k")}). Le bouton dossier permet de choisir où elle démarre.`) },
  { sel: "#convs", title: L("All your conversations", "Toutes tes conversations"),
    text: L("Each one gets an emoji and a title. You see at a glance which is working, done, or waiting for you. Hover a card to tag or close it.", "Chacune reçoit un emoji et un titre. Tu vois d'un coup d'œil laquelle travaille, a fini ou t'attend. Survole une carte pour la taguer ou la fermer.") },
  { sel: ".tabs", alsoSel: "#tagBar", title: L("History and tags", "Historique et tags"),
    text: L("Find and resume past conversations, including those made in the terminal. Filter both lists by tag.", "Retrouve et reprends les conversations passées, même celles faites dans le terminal. Filtre les deux listes par tag.") },
  { sel: "#usageCard", title: L("Weekly limit", "Limite de la semaine"),
    text: L("How much of your weekly Claude limit is used, when it resets, and today's pace against your daily goal.", "La part de ta limite Claude utilisée cette semaine, la date du reset, et ton rythme du jour par rapport à ton objectif.") },
  { sel: "#prodCard", title: L("Hours saved", "Heures économisées"),
    text: L("An estimate of the work Claude did for you this week, task by task. Click the hours of a task to correct them.", "Une estimation du travail que Claude a fait pour toi cette semaine, tâche par tâche. Clique sur les heures d'une tâche pour les corriger.") },
  { sel: "#setBtn", title: L("Settings", "Réglages"),
    text: L(`Themes, tags, notifications, goals… everything is here (${kbd(",")}). You can replay this tour from there.`, `Thèmes, tags, notifications, objectifs… tout est ici (${kbd(",")}). Tu peux relancer ce parcours depuis là.`) },
];
let tourStep = -1, tourSteps = [];
const tourEl = document.createElement("div");
tourEl.className = "tour"; tourEl.hidden = true;
tourEl.innerHTML = `<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-live="polite"></div>`;
document.body.appendChild(tourEl);
function startTour() {
  if (!$("#setBack").hidden) openSettings(false);
  if (tab !== "convs") { tab = "convs"; render(); } // the conversation list must be visible
  tourSteps = TOUR().filter((st) => { const el = $(st.sel); return el && !el.hidden && el.offsetParent !== null; });
  tourStep = 0; tourEl.hidden = false; showTourStep();
}
function endTour() {
  tourEl.hidden = true; tourStep = -1;
  try { localStorage.setItem("shoal.toured", "1"); } catch {}
  terms.get(active)?.term.focus();
}
function showTourStep() {
  const st = tourSteps[tourStep]; if (!st) return endTour();
  const r = $(st.sel).getBoundingClientRect();
  const extra = st.alsoSel && $(st.alsoSel) && !$(st.alsoSel).hidden ? $(st.alsoSel).getBoundingClientRect() : null;
  const box = extra ? { left: Math.min(r.left, extra.left), top: Math.min(r.top, extra.top), right: Math.max(r.right, extra.right), bottom: Math.max(r.bottom, extra.bottom) } : r;
  const pad = 6, hole = tourEl.querySelector(".tour-hole");
  Object.assign(hole.style, { left: box.left - pad + "px", top: box.top - pad + "px", width: box.right - box.left + 2 * pad + "px", height: box.bottom - box.top + 2 * pad + "px" });
  const card = tourEl.querySelector(".tour-card"), last = tourStep === tourSteps.length - 1;
  card.innerHTML = `<div class="tour-step">${tourStep + 1} / ${tourSteps.length}</div><b>${esc(st.title)}</b><p>${esc(st.text)}</p>
    <div class="tour-actions"><button class="tour-skip" data-tour="skip">${last ? "" : L("Skip", "Passer")}</button>
    ${tourStep ? `<button class="btn btn-ghost btn-sm" data-tour="prev">${L("Back", "Retour")}</button>` : ""}
    <button class="btn btn-primary btn-sm" data-tour="next">${last ? L("Let's go", "C'est parti") : L("Next", "Suivant")}</button></div>`;
  // the card goes next to the highlighted area: left of the sidebar, under/over the main panel
  const cw = 300, ch = card.offsetHeight || 170, m = 14;
  let x, y;
  if (box.left > innerWidth * 0.6) { x = box.left - pad - cw - m; y = Math.min(Math.max(12, box.top), innerHeight - ch - 12); }
  else if (box.right < innerWidth * 0.4) { x = box.right + pad + m; y = Math.min(Math.max(12, box.top), innerHeight - ch - 12); } // sidebar on the left
  else if (box.bottom - box.top > innerHeight * 0.6) { x = box.left + (box.right - box.left - cw) / 2; y = box.top + (box.bottom - box.top - ch) / 2; }
  else { x = box.left; y = box.bottom + pad + m; }
  card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, x)) + "px";
  card.style.top = Math.max(12, Math.min(innerHeight - ch - 12, y)) + "px";
  card.querySelector('[data-tour="next"]').focus();
}
tourEl.addEventListener("click", (e) => {
  const a = e.target.closest("[data-tour]")?.dataset.tour;
  if (a === "skip") endTour();
  else if (a === "prev") { tourStep = Math.max(0, tourStep - 1); showTourStep(); }
  else if (a === "next") { tourStep++; tourStep >= tourSteps.length ? endTour() : showTourStep(); }
});
document.addEventListener("keydown", (e) => {
  if (tourEl.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endTour(); }
  else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); tourStep++; tourStep >= tourSteps.length ? endTour() : showTourStep(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); tourStep = Math.max(0, tourStep - 1); showTourStep(); }
}, true);
addEventListener("resize", () => { if (!tourEl.hidden) showTourStep(); });
window.shoal?.onTour?.(startTour); // Help menu → "Show the tour"
// first launch: once the interface has its data (cards rendered)
let tourChecked = false;
function maybeStartTour() {
  if (tourChecked || !settings.lang) return;
  tourChecked = true;
  let seen = false; try { seen = !!localStorage.getItem("shoal.toured"); } catch {}
  if (!seen) setTimeout(startTour, 900);
}

setInterval(render, 30000);
connect();
