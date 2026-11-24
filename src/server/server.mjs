// Shoal server: runs Claude Code conversations in pseudo-terminals, tracks their state through
// Claude Code hooks, names each conversation (emoji + title, via Haiku), estimates the hours saved,
// and serves the web UI shown in the Shoal window. Everything stays on 127.0.0.1.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import { SIZE_GUIDE, priceItems, typeMultipliers, dominantType } from "./estimate.mjs";

const require = createRequire(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const PORT = Number(process.env.SHOAL_PORT || 4747);
const HOST = "127.0.0.1";
const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // src/
const WEB = path.join(SRC, "web");
const HOOKS = path.join(SRC, "hooks");
const HOME = os.homedir();
const WIN = process.platform === "win32";
const DATA = process.env.SHOAL_DATA || (process.platform === "darwin" ? path.join(HOME, "Library/Application Support/Shoal")
  : WIN ? path.join(process.env.APPDATA || path.join(HOME, "AppData/Roaming"), "Shoal") : path.join(HOME, ".shoal"));
const UPLOADS = path.join(DATA, "uploads");
const CLAUDE_SETTINGS = path.join(DATA, "claude-settings.json");
// Default folder for new conversations. Claude Code never remembers folder trust for the home folder,
// so a dedicated workspace avoids the "Do you trust this folder?" question on every new conversation.
const WORKSPACE = path.join(HOME, "Shoal");
// macOS / Linux: the user's login shell. Windows: PowerShell (Windows PowerShell 5.1 is always present; pwsh 7 if installed)
const SHELL = WIN ? (whereSync("pwsh.exe") || "powershell.exe") : process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
function whereSync(exe) {
  if (!WIN) return "";
  for (const dir of String(process.env.PATH || "").split(";")) { const p = path.join(dir, exe); try { if (dir && fs.existsSync(p)) return p; } catch {} }
  return "";
}
fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA, 0o700); } catch {} // conversations titles, tasks, paths: readable by this user only
// node-pty's helper sometimes loses its executable bit when an app is packaged or unzipped
try { const h = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"); if (fs.existsSync(h)) fs.chmodSync(h, 0o755); } catch {}

// ---------- access token: only the Shoal window and the hooks of its conversations may drive the server
const TOKEN_FILE = path.join(DATA, "token");
const TOKEN = (fs.existsSync(TOKEN_FILE) && fs.readFileSync(TOKEN_FILE, "utf8").trim()) || crypto.randomBytes(24).toString("hex");
fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
fs.writeFileSync(path.join(DATA, "port"), String(PORT));

// ---------- small JSON persistence (a file is only rewritten when its content changed)
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const written = new Map();
const writeJSON = (f, v) => { const s = JSON.stringify(v, null, 1); if (written.get(f) === s) return; written.set(f, s); fs.writeFileSync(path.join(DATA, f), s, { mode: 0o600 }); };

// ---------- settings (⚙ panel in the UI): data/settings.json
const DEFAULTS = {
  lang: "en", theme: "malachite", sidebar: "right", keepRunning: false,
  notifyDone: true, notifyWaiting: true, systemNotif: true, sound: true, badge: "all",
  showLimit: true, weeklyTarget: 100, workdays: [1, 2, 3, 4, 5], dailyTarget: 0, warnAt: 80, overNotify: true,
  defaultCwd: "", defaultModel: "", autoName: true,
  fontSize: 13, scrollback: 5000, productivity: true,
  importHistory: true, tags: [], autoTag: true,
};
const TAG_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]; // Notion-like palette
const clamp = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.min(b, Math.max(a, Math.round(Number(v)))) : d);
function cleanSettings(raw = {}, base = DEFAULTS) {
  const s = { ...base };
  for (const k of ["autoTag", "importHistory", "keepRunning", "notifyDone", "notifyWaiting", "systemNotif", "sound", "showLimit", "overNotify", "autoName", "productivity"]) if (typeof raw[k] === "boolean") s[k] = raw[k];
  if (["en", "fr"].includes(raw.lang)) s.lang = raw.lang;
  if (["left", "right"].includes(raw.sidebar)) s.sidebar = raw.sidebar;
  if (["malachite", "amethyst", "amber", "dark", "light", "malachite-light", "lavender", "amber-light"].includes(raw.theme)) s.theme = raw.theme;
  if (["all", "waiting", "none"].includes(raw.badge)) s.badge = raw.badge;
  if (raw.weeklyTarget != null) s.weeklyTarget = clamp(raw.weeklyTarget, 5, 100, s.weeklyTarget);
  if (Array.isArray(raw.workdays)) s.workdays = [...new Set(raw.workdays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  if (raw.dailyTarget != null) s.dailyTarget = raw.dailyTarget === "" ? 0 : clamp(raw.dailyTarget, 0, 100, s.dailyTarget);
  if (raw.warnAt != null) s.warnAt = clamp(raw.warnAt, 30, 100, s.warnAt);
  if (typeof raw.defaultCwd === "string") {
    const d = raw.defaultCwd.trim().replace(/^~(?=\/|$)/, HOME);
    if (!d) s.defaultCwd = ""; else if (fs.existsSync(d) && fs.statSync(d).isDirectory()) s.defaultCwd = path.resolve(d);
  }
  if (typeof raw.defaultModel === "string" && /^[a-z0-9.\-[\]]{0,40}$/i.test(raw.defaultModel)) s.defaultModel = raw.defaultModel;
  if (raw.fontSize != null) s.fontSize = clamp(raw.fontSize, 10, 20, s.fontSize);
  if ([2000, 5000, 10000, 20000].includes(Number(raw.scrollback))) s.scrollback = Number(raw.scrollback);
  // user-defined tags: { id, name, color }
  if (Array.isArray(raw.tags)) s.tags = raw.tags.slice(0, 24).map((t) => ({
    id: /^[a-z0-9]{4,12}$/.test(t?.id) ? t.id : crypto.randomBytes(4).toString("hex"),
    name: String(t?.name || "").trim().slice(0, 24), color: TAG_COLORS.includes(t?.color) ? t.color : "default",
  })).filter((t) => t.name);
  return s;
}
let settings = cleanSettings(readJSON("settings.json", {}));
// language of the texts Haiku writes (titles, tasks, status lines): the UI language
const outLang = () => (settings.lang === "fr" ? "French" : "English");

let usage = readJSON("usage.json", null);                 // weekly / 5-hour limits (reliable value = highest of the window)
let taskStore = readJSON("tasks.json", { tasks: [] });    // tasks of the week (goals that may span several conversations)
let usageDays = readJSON("usage-days.json", { window: 0, days: {} }); // usage at the start of each day, for the daily goal
let history = readJSON("history.json", { items: [] });    // past conversations that mattered
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let recents = (readJSON("recents.json", null) || []).filter((d, i, a) => typeof d === "string" && fs.existsSync(d) && a.indexOf(d) === i);

// ---------- environment: Claude Code and Python, found through the user's login shell
// (an app started from the Dock gets a minimal PATH, while the terminal sees the user's real one)
const env = { claude: "", python: "", checked: false };
function checkPython(py, args, done) {
  if (!py) return done("");
  // macOS ships a /usr/bin/python3 stub (offers to install the Command Line Tools) and Windows a python.exe stub (opens the Store): check it really runs
  execFile(py, [...args, "-c", "import sys; print(sys.version_info[0])"], { timeout: 10000, windowsHide: true }, (e, v = "") => done(!e && String(v).trim() === "3" ? py : ""));
}
function findTools() {
  return new Promise((resolve) => {
    if (WIN) {
      // Windows: PATH of the user (the app inherits it), plus the default install places
      const local = process.env.LOCALAPPDATA || path.join(HOME, "AppData/Local");
      env.claude = whereSync("claude.exe") || whereSync("claude.cmd") || [path.join(HOME, ".local/bin/claude.exe"), path.join(local, "Programs/claude/claude.exe")].find(fs.existsSync) || "";
      const pyDirs = (() => { try { return fs.readdirSync(path.join(local, "Programs/Python")).map((d) => path.join(local, "Programs/Python", d, "python.exe")); } catch { return []; } })();
      const candidates = [whereSync("py.exe") && [whereSync("py.exe"), ["-3"]], whereSync("python.exe") && [whereSync("python.exe"), []], ...pyDirs.filter(fs.existsSync).map((p) => [p, []])].filter(Boolean);
      const next = () => {
        const c = candidates.shift();
        if (!c) { env.python = ""; env.pyArgs = []; env.checked = true; return resolve(); }
        checkPython(c[0], c[1], (ok) => { if (ok) { env.python = ok; env.pyArgs = c[1]; env.checked = true; resolve(); } else next(); });
      };
      return next();
    }
    execFile(SHELL, ["-lic", 'echo "SHOAL_CLAUDE=$(command -v claude)"; echo "SHOAL_PY=$(command -v python3)"'], { timeout: 15000, env: { ...process.env, SHOAL_INTERNAL: "1" } }, (_e, out = "") => {
      const pick = (k) => (String(out).match(new RegExp(`^${k}=(/.*)$`, "m")) || [])[1]?.trim() || "";
      const claudeGuess = [path.join(HOME, ".local/bin/claude"), path.join(HOME, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(fs.existsSync);
      env.claude = pick("SHOAL_CLAUDE") || claudeGuess || "";
      const py = pick("SHOAL_PY") || ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].find(fs.existsSync) || "";
      checkPython(py, [], (ok) => { env.python = ok; env.pyArgs = []; env.checked = true; resolve(); });
    });
  });
}

// Claude Code settings used only by conversations started in Shoal (passed with --settings).
// The user's own ~/.claude/settings.json is never modified.
function writeClaudeSettings() {
  // without Python the hooks would fail on every tool call: write no hooks at all (the UI asks to install Python)
  if (env.checked && !env.python) { fs.writeFileSync(CLAUDE_SETTINGS, "{}\n"); return; }
  const py = env.python || (WIN ? "python" : "python3");
  // POSIX: single quotes. Windows: double quotes and forward slashes (understood by cmd, PowerShell and Git Bash alike)
  const q = WIN ? (p) => `"${p.replace(/\\/g, "/")}"` : (p) => `'${p.replace(/'/g, "'\\''")}'`;
  const run = `${q(py)}${(env.pyArgs || []).map((a) => " " + a).join("")} -S`;
  const hook = (ev) => [{ hooks: [{ type: "command", command: `${run} ${q(path.join(HOOKS, "hook.py"))} ${ev}`, timeout: 5 }] }];
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({
    statusLine: { type: "command", command: `${run} ${q(path.join(HOOKS, "statusline.py"))}`, padding: 0, refreshInterval: 60 },
    hooks: { SessionStart: hook("start"), UserPromptSubmit: hook("prompt"), PreToolUse: hook("pretool"), PostToolUse: hook("tool"), Stop: hook("stop"), Notification: hook("notify") },
  }, null, 2));
}
writeClaudeSettings();

// ---------- conversations
const sessions = new Map(); // id -> session
let counter = 0;
const norm = (e) => (e || "").replace(/️/g, "").trim();
const SPARE = "📊 🧾 🎬 🎙️ 🛠️ 🐛 🚀 📈 💼 🏗️ 📚 🧪 🔐 🗂️ ✉️ 📣 🎯 🧭 💡 🧩 🌐 📱 💳 🏦 🤝 📝 🔎 🎨 📦 🧮 🏠 🎓 🧲 🛰️ 🌱 🔥 🧠 🪄 📌 🧱 🧹 🦉 🐙 🦊 🐝 🌵 🍋 🎲".split(" ");

// only the fields the UI needs go over the wire
function publicSession(s) {
  const { id, num, cwd, emoji, title, named, state, unread, ctx, model, note, waitKind, permission, lastActivity, tag } = s;
  return { id, num, cwd, emoji, title, named, state, unread, ctx, model, note, waitKind, permission, lastActivity, tag };
}

function cleanEnv(extra) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("ELECTRON_") || k === "TMUX" || k === "TMUX_PANE") delete e[k];
  return { ...e, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: e.LANG || "en_US.UTF-8", ...extra };
}
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function defaultFolder() {
  if (settings.defaultCwd && fs.existsSync(settings.defaultCwd)) return settings.defaultCwd;
  if (recents[0]) return recents[0];
  try { fs.mkdirSync(WORKSPACE, { recursive: true }); return WORKSPACE; } catch { return HOME; }
}

// DEC private modes worth restoring when the output buffer is trimmed
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;
const ALT_MODES = ["47", "1047", "1049"];
const KEEP_MODES = new Set([...ALT_MODES, "1", "25", "1000", "1002", "1003", "1004", "1005", "1006", "1015", "2004"]);
function trackModes(modes, text) {
  for (const m of text.matchAll(MODE_RE)) for (const n of m[1].split(";")) if (KEEP_MODES.has(n)) modes[n] = m[2];
  return modes;
}
function modePrefix(modes) { // alternate screen first (it switches buffers), then the others
  let p = ALT_MODES.some((k) => modes[k] === "h") ? "\x1b[?1049h" : "";
  for (const [k, v] of Object.entries(modes)) if (!ALT_MODES.includes(k)) p += `\x1b[?${k}${v}`;
  return p;
}

function createSession(cwd, resume, model, { remember = true } = {}) {
  if (!model && !resume) model = settings.defaultModel;
  cwd = cwd && fs.existsSync(cwd) ? cwd : defaultFolder();
  if (!resume && path.resolve(cwd) === HOME) cwd = defaultFolder(); // a resumed conversation stays in its own folder
  const resumeArg = resume && UUID.test(resume.sid) ? ` --resume ${resume.sid}` : "";
  const id = crypto.randomBytes(6).toString("hex");
  const num = ++counter;
  const modelArg = model && /^[a-z0-9.\-[\]]+$/i.test(model) ? model : "";
  let file, args;
  if (WIN) { // PowerShell: run claude, then stay in the shell (-NoExit) like on macOS
    const ps = (x) => `'${String(x).replace(/'/g, "''")}'`;
    file = SHELL; args = ["-NoLogo", "-NoExit", "-Command", `& ${ps(env.claude || "claude")} --settings ${ps(CLAUDE_SETTINGS)}${resumeArg}${modelArg ? ` --model ${ps(modelArg)}` : ""}`];
  } else {
    const claude = env.claude ? shq(env.claude) : "claude";
    file = SHELL; args = ["-l", "-i", "-c", `${claude} --settings ${shq(CLAUDE_SETTINGS)}${resumeArg}${modelArg ? ` --model ${shq(modelArg)}` : ""}; exec ${shq(SHELL)} -l`];
  }
  const term = pty.spawn(file, args, {
    name: "xterm-256color", cols: 120, rows: 40, cwd,
    env: cleanEnv({ SHOAL_ID: id, SHOAL_PORT: String(PORT), SHOAL_TOKEN: TOKEN, SHOAL_DATA: DATA }),
  });
  const s = {
    id, num, cwd, emoji: "", title: "", named: false, gen: 0, naming: -1,
    state: "idle", unread: false, ctx: null, model: "", claudeSession: "", prompts: 0, pending: [], note: "", waitKind: "", lastTool: null, permission: null,
    taskId: "", lastPromptAt: 0, lastStopAt: 0, dUser: 0, dWork: 0, answers: [], toolsSince: 0, batchStart: 0, judgeTimer: null, stopData: null,
    historySid: resumeArg ? resume.sid : "",
    createdAt: Date.now(), lastActivity: Date.now(), pty: term, buf: [], bufLen: 0,
  };
  if (resumeArg && resume.emoji) Object.assign(s, { emoji: resume.emoji, title: resume.title || "", named: true });
  s.tag = (resume && resume.tag) || "";
  sessions.set(id, s);
  term.onData((d) => {
    s.buf.push(d); s.bufLen += d.length;
    // thousands of small chunks cost more memory than one block: merge them from time to time
    if (s.buf.length > 800) s.buf = [s.buf.join("")];
    if (s.bufLen > 1_500_000) { // keep ~1 MB, cut on a newline (never inside an escape sequence)
      const all = s.buf.join(""), from = all.length - 1_000_000;
      // full-screen apps (Claude Code) rarely print a newline: otherwise cut just before an escape sequence
      let start = all.indexOf("\n", from) + 1;
      if (start === 0) { const esc = all.indexOf("\x1b", from); start = esc < 0 ? from : esc; }
      // the modes set in the dropped part (alternate screen, mouse reporting, paste…) are put back
      // at the start, or a replay rebuilds the screen in the wrong buffer (stacked frames, broken scrollbar)
      s.modes = trackModes(s.modes || {}, all.slice(0, start));
      s.buf = [modePrefix(s.modes) + all.slice(start)]; s.bufLen = s.buf[0].length;
    }
    broadcast({ t: "out", id, data: d });
  });
  term.onExit(() => { sessions.delete(id); broadcastState(); });
  if (remember) { recents = [cwd, ...recents.filter((r) => r !== cwd)].slice(0, 6); writeJSON("recents.json", recents); }
  broadcastState();
  return s;
}

// node-pty on Windows does not take a signal name (it throws): kill the process tree instead
const killPty = (s, sig) => { try { WIN ? s.pty.kill() : s.pty.kill(sig); } catch {} };
function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  flushJudge(s, { closing: true }); // the last exchanges are still evaluated after the conversation is closed
  killPty(s, "SIGHUP");
  setTimeout(() => { if (sessions.has(id)) { killPty(s, "SIGKILL"); sessions.delete(id); broadcastState(); } }, 1500);
}

// ---------- background Haiku calls (through the user's own Claude Code login)
let haikuRuns = 0; // shown in the settings footer
// a minimal system prompt replaces Claude Code's default one (~3,000 tokens per call, useless here: no tools, one-shot answer)
const HAIKU_ARGS = ["--no-session-persistence", "--setting-sources", "local", "--strict-mcp-config", "--tools", "", "--disable-slash-commands",
  "--system-prompt", "You are a precise classifier. Follow the instructions in the user message and output only what it asks for."];
function runHaiku(prompt, model = "haiku", effort, timeout = 90000) {
  haikuRuns++;
  return new Promise((resolve) => {
    if (!env.claude) return resolve("");
    const p = spawn(env.claude, ["-p", "--model", model, ...(effort ? ["--effort", effort] : []), ...HAIKU_ARGS],
      { cwd: os.tmpdir(), env: cleanEnv({ SHOAL_INTERNAL: "1" }), windowsHide: true });
    let out = "";
    const timer = setTimeout(() => p.kill(), timeout);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { clearTimeout(timer); resolve(out); });
    p.on("error", () => { clearTimeout(timer); resolve(""); });
    p.stdin.end(prompt);
  });
}

// ---------- emoji + title: chosen ONCE from the first prompt, emoji unique among open conversations
function usedEmojis(exceptId) {
  return new Set([...sessions.values()].filter((x) => x.id !== exceptId && x.emoji).map((x) => norm(x.emoji)));
}
// tags Haiku may pick from (only the user's own tags; never invents one)
const tagChoices = () => (settings.autoTag ? settings.tags : []);
const tagByName = (name) => { const n = String(name || "").trim().toLowerCase().replace(/^["'\s]+|["'\s]+$/g, ""); return n && n !== "-" ? settings.tags.find((t) => t.name.toLowerCase() === n) : null; };
const TAG_RULE = (tags) => `- TAG: the ONE tag below that clearly fits this conversation, copied exactly; or - if none clearly fits (do not guess, never invent a tag)\n  Tags: ${tags.map((t) => t.name).join(" / ")}\n`;
async function askName(text, avoid, { title = true } = {}) {
  const tags = tagChoices();
  if (!title && !tags.length) return {};
  const out = await runHaiku(
    "You label a work conversation so it can be recognised at a glance.\n" +
    `Answer with ONE line, exactly in this format: ${title ? "EMOJI|Title" : "X|-"}${tags.length ? "|TAG" : ""}\n` +
    (title ? "- EMOJI: a single emoji, the most evocative of the topic\n" +
      `- Title: 2 to 4 words in ${outLang()}, no final punctuation\n` +
      (avoid.size ? `- FORBIDDEN emojis (already used by other conversations): ${[...avoid].join(" ")}\n` : "") : "") +
    (tags.length ? TAG_RULE(tags) : "") +
    "No other text.\n\nFirst message of the conversation:\n" + text, "haiku", undefined, 45000);
  const line = out.split("\n").reverse().find((l) => l.includes("|")) || "";
  const parts = line.split("|");
  const tag = tags.length ? tagByName(parts.length > 2 ? parts[parts.length - 1] : "") : null;
  return { emoji: (parts[0] || "").trim().slice(0, 8), title: (tags.length && parts.length > 2 ? parts.slice(1, -1) : parts.slice(1)).join("|").trim().replace(/^["'.\s]+|["'.\s]+$/g, "").slice(0, 34), tag: tag?.id || "" };
}
async function nameSession(s, gen, prompt) {
  const text = prompt.replace(/\s+/g, " ").trim().slice(0, 600);
  let { emoji, title, tag } = await askName(text, usedEmojis(s.id));
  if (emoji && usedEmojis(s.id).has(norm(emoji))) ({ emoji } = await askName(text, usedEmojis(s.id)));
  if (!sessions.has(s.id) || s.gen !== gen) return;
  applyAutoTag(s, tag);
  if (s.named) return broadcastState(); // renamed by hand in the meantime
  const taken = usedEmojis(s.id); // final synchronous check, so no race is possible
  if (!emoji || taken.has(norm(emoji))) emoji = SPARE.find((e) => !taken.has(norm(e))) || "💬";
  Object.assign(s, { emoji, title: title || text.slice(0, 34) || "Conversation", named: true });
  broadcastState();
}

// automatic tag: only if the user has not tagged the conversation himself (he can change it at any time)
function applyAutoTag(s, tag) {
  if (!tag || s.tag) return;
  s.tag = tag; s.tagAuto = true;
  const sid = s.historySid || s.claudeSession, it = sid && history.items.find((h) => h.sid === sid);
  if (it && !it.tag) { it.tag = tag; writeJSON("history.json", history); }
}

// ---------- Claude Code hooks -> conversation state
function onHook(s, event, data) {
  s.lastActivity = Date.now();
  if (event === "start") {
    if (data.session_id) s.claudeSession = data.session_id;
    s.ready = true; // Claude Code is up (folder trusted): a prompt can be pasted
    if (data.source === "clear") s.historySid = "";
    if (data.source !== "compact" && !(data.source === "resume" && s.historySid)) {
      flushJudge(s, { closing: true }); // /clear: the work done before is still evaluated (its batch keeps its requests)
      Object.assign(s, { gen: s.gen + 1, emoji: "", title: "", named: false, naming: -1, unread: false });
    }
    s.state = "idle";
  } else if (event === "prompt") {
    s.state = "working"; s.unread = false; s.prompts++; s.waitKind = ""; s.permission = null;
    const now = Date.now();
    s.dUser += s.lastStopAt ? Math.min(now - s.lastStopAt, 10 * 60e3) : 2 * 60e3; // reading the answer + writing the message (10 min cap)
    s.lastPromptAt = now;
    if (s.judgeTimer) { clearTimeout(s.judgeTimer); s.judgeTimer = null; } // the user is still at it: wait for the next pause
    if (!s.batchStart) s.batchStart = now;
    const p = (data.prompt || "").trim();
    if (p && !p.startsWith("/")) { s.pending.push(p.replace(/\s+/g, " ").slice(0, 400)); s.pending = s.pending.slice(-12); }
    if (!s.named && s.naming !== s.gen && p && !p.startsWith("/")) {
      s.naming = s.gen;
      if (settings.autoName && env.claude) nameSession(s, s.gen, p);
      else { // without Haiku: the first words of the message + a free emoji
        const taken = usedEmojis(s.id);
        Object.assign(s, { emoji: SPARE.find((e) => !taken.has(norm(e))) || "💬", title: p.replace(/\s+/g, " ").slice(0, 34), named: true });
        if (env.claude && tagChoices().length && !s.tag) { const gen = s.gen; askName(p.slice(0, 600), new Set(), { title: false }).then(({ tag }) => { if (sessions.has(s.id) && s.gen === gen) { applyAutoTag(s, tag); broadcastState(); } }); }
      }
    }
  } else if (event === "pretool") {
    // nothing visible changes: remember the tool (to show a possible permission request) without broadcasting
    s.lastTool = { name: data.tool_name || "", detail: data.detail || "", ts: Date.now() };
    s.toolsSince++;
    return;
  } else if (event === "tool") {
    if (s.state !== "waiting") return;
    s.state = "working"; s.waitKind = ""; s.permission = null;
  } else if (event === "stop") {
    s.state = "done"; s.unread = true; s.waitKind = ""; s.permission = null;
    if (s.lastPromptAt) s.dWork += Date.now() - s.lastPromptAt;
    s.lastStopAt = Date.now();
    if (settings.productivity && env.claude) scheduleJudge(s, data);
    else s.pending = [];
    remember(s);
    broadcast({ t: "alert", id: s.id, kind: "done" });
  } else if (event === "notify") {
    const type = data.notification_type || "";
    if (type === "auth_success" || (type === "idle_prompt" && s.state === "done")) return broadcastState();
    s.state = "waiting"; s.unread = true;
    if (type === "permission_prompt") {
      const t = s.lastTool && Date.now() - s.lastTool.ts < 120000 ? s.lastTool : null;
      s.waitKind = "permission";
      s.permission = { tool: t?.name || "", detail: t?.detail || "", message: String(data.message || "").slice(0, 160) };
    } else s.waitKind = "input";
    broadcast({ t: "alert", id: s.id, kind: "waiting" });
  }
  broadcastState();
}

// ---------- reading transcripts (often several MB: never read whole)
function readFrom(file, from) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, Math.min(from, size)), b = Buffer.alloc(size - start);
    fs.readSync(fd, b, 0, b.length, start);
    return { text: b.toString("utf8"), size };
  } finally { fs.closeSync(fd); }
}
const readTail = (file, bytes) => { const st = fs.statSync(file); return readFrom(file, st.size - bytes).text.replace(/^[^\n]*\n/, ""); };

function lastAssistantText(data) {
  if (data.last_assistant_message) return String(data.last_assistant_message);
  try {
    const lines = readTail(data.transcript_path, 1_000_000).trim().split("\n");
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
      const e = JSON.parse(lines[i]);
      if (e.type !== "assistant") continue;
      const txt = (e.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (txt) return txt;
    }
  } catch {}
  return "";
}

// ---------- productivity: tasks of the week and hours saved
// Time WITHOUT AI: the model classifies each item by size, the durations come from src/server/estimate.mjs
const weekStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
let tasksVer = 0; // bumped on every task change: the weekly ranking is only recomputed then
const saveTasks = () => { tasksVer++; writeJSON("tasks.json", taskStore); };
// Each task keeps one counter PER WEEK (Monday -> Sunday): only the work done that week counts for that week.
const weekKey = (ts = Date.now()) => { const d = new Date(weekStart(new Date(ts))); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const weekEnd = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d + 7).getTime(); };
function wk(t, key = weekKey()) { t.weeks ||= {}; return (t.weeks[key] ||= { humanH: 0, calcul: "", userMs: 0, livrables: [] }); }
// tasks shown to the judge: this week's ones + those still in progress from the last 4 weeks (to recognise them)
function weekTasks() {
  const key = weekKey(), now = Date.now();
  return taskStore.tasks.filter((t) => !t.removed && (t.weeks?.[key] || (t.status === "en_cours" && t.updatedAt >= now - 28 * 864e5)));
}

const CODE_EXT = /\.(m?[jt]sx?|py|sh|css|html?|sql|swift|kt|java|go|rb|php|rs|c|cc|cpp|h|cs|vue|svelte)$/i;
const words = (t) => (String(t || "").match(/[\p{L}\p{N}'’-]+/gu) || []).length;
// objective measures of a turn: lines of code written, words of emails and documents
function measureTurn(s, data) {
  const m = { code: 0, files: new Set(), mails: [], doc: 0, shell: 0 };
  try {
    // only what was written since the previous evaluation (or the last 400 KB the first time)
    const same = s.tPath === data.transcript_path && s.tOff;
    const { text, size } = same ? readFrom(data.transcript_path, s.tOff) : { text: readTail(data.transcript_path, 400_000), size: fs.statSync(data.transcript_path).size };
    s.tPath = data.transcript_path; s.tOff = size;
    for (const l of text.split("\n")) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== "assistant") continue;
      for (const c of e.message?.content || []) {
        if (c.type !== "tool_use") continue;
        const i = c.input || {}, f = String(i.file_path || "");
        const changed = (a, b) => { const old = new Set(String(a || "").split("\n")); return String(b || "").split("\n").filter((x) => x.trim() && !old.has(x)).length; };
        let n = 0;
        if (c.name === "Write") n = String(i.content || "").split("\n").filter((x) => x.trim()).length;
        else if (c.name === "Edit") n = changed(i.old_string, i.new_string);
        else if (c.name === "MultiEdit") n = (i.edits || []).reduce((k, ed) => k + changed(ed.old_string, ed.new_string), 0);
        if (n) { if (CODE_EXT.test(f)) { m.code += n; m.files.add(path.basename(f)); } else if (/\.(md|txt|docx?)$/i.test(f)) m.doc += words(i.content || i.new_string); }
        if (/(create_draft|send_message|send_email|reply|update_draft|forward)/i.test(c.name) && /mail/i.test(c.name)) m.mails.push(words(i.body || i.htmlBody || i.text));
        // code written through the shell (heredoc, python/sed edits) cannot be counted: the line count is then unknown
        if (c.name === "Bash" && /<<\s*'?EOF|cat\s*>|python3?\s+-|sed\s+-i|\btee\b|>\s*[\w~./-]+\.(m?[jt]sx?|py|css|html?|sh|json)/.test(String(i.command || ""))) m.shell++;
      }
    }
  } catch {}
  s.lastCodeLines = m.shell ? null : m.code; // caps the size of dev items (see estimate.mjs)
  const parts = [];
  if (m.code) parts.push(`${m.code} lines of code added or changed by the assistant in ${m.files.size} file(s) (already used by the app to cap dev sizes: classify by what the code does, not by its length)`);
  if (m.mails.length) parts.push(`${m.mails.length} email(s) written: ${m.mails.map((w) => w + " words").join(", ")}`);
  if (m.doc) parts.push(`${m.doc} words written in documents`);
  if (m.shell) parts.push(`${m.shell} file(s) or script(s) written through the terminal (line count unknown: judge by what was built)`);
  return parts.length ? parts.join("; ") : "no code, email or document written";
}

// one Haiku evaluation at a time: each call starts a `claude` process (~200 MB for a few seconds),
// so 3 conversations finishing together no longer start 3 in parallel
let judging = Promise.resolve(), judgeQueued = 0;
function queueJudge(s, data) {
  judgeQueued++; broadcastState();
  judging = judging.then(() => judgeTurn(s, data)).catch(() => {}).finally(() => { judgeQueued--; broadcastState(); });
}

// Exchanges are evaluated IN BATCHES, not after every reply: one Haiku call once the conversation has been quiet
// for JUDGE_IDLE (the user reads, tests, or moved to another conversation), or right away when the batch gets big.
// Batches with no tool use and a short answer (a quick question) never trigger a call on their own: they are merged
// into the next real batch. The "Refresh" button and closing a conversation flush the batch at once.
const JUDGE_IDLE = Number(process.env.SHOAL_JUDGE_IDLE_MS) || 4 * 60e3, JUDGE_MAX_PROMPTS = 6, JUDGE_MAX_AGE = 45 * 60e3;
function scheduleJudge(s, data) {
  s.stopData = data;
  const txt = lastAssistantText(data);
  if (txt) { s.answers.push(txt.slice(-1500)); s.answers = s.answers.slice(-8); }
  if (s.judgeTimer) clearTimeout(s.judgeTimer);
  s.judgeTimer = null;
  if (s.pending.length >= JUDGE_MAX_PROMPTS || (s.batchStart && Date.now() - s.batchStart > JUDGE_MAX_AGE)) return flushJudge(s);
  s.judgeTimer = setTimeout(() => { s.judgeTimer = null; flushJudge(s); }, JUDGE_IDLE);
}
const trivialBatch = (s) => s.toolsSince === 0 && words(s.answers.join(" ")) < 150;
function flushJudge(s, { force = false, closing = false } = {}) {
  if (s.judgeTimer) { clearTimeout(s.judgeTimer); s.judgeTimer = null; }
  if (!s.stopData || !s.answers.length || s.judging) return false;
  if (!force && trivialBatch(s)) { if (closing) Object.assign(s, { answers: [], pending: [], toolsSince: 0, batchStart: 0 }); return false; }
  s.judging = true; // one batch per conversation at a time (the next one waits for the next stop or refresh)
  queueJudge(s, s.stopData);
  return true;
}
function refreshTasks() {
  if (!settings.productivity || !env.claude) return;
  for (const s of sessions.values()) flushJudge(s, { force: true });
}

async function judgeTurn(s, data) {
  try { await judgeBatch(s, data); } finally {
    s.judging = false;
    // replies that arrived during the call: evaluated at the next pause
    if (s.answers.length && sessions.has(s.id) && !s.judgeTimer) s.judgeTimer = setTimeout(() => { s.judgeTimer = null; flushJudge(s); }, JUDGE_IDLE);
  }
}
async function judgeBatch(s, data) {
  const asked = s.pending.slice(), nAnswers = s.answers.length, tools = s.toolsSince;
  // the assistant's final answers of the batch, most recent last (bounded: ~4,000 characters in total)
  const answer = s.answers.map((a, i) => (nAnswers > 1 ? `[reply ${i + 1}/${nAnswers}] ` : "") + a).join("\n\n").slice(-4000);
  const measures = measureTurn(s, data);
  const dUser = s.dUser, dWork = s.dWork;
  if (!answer) return;
  const list = weekTasks().slice(-15);
  const prompt =
    "You keep track of the weekly TASKS of a person who has an AI assistant do work for them (code, emails, videos, documents, analyses).\n" +
    "A task = a work goal that can span several conversations and several days (e.g. \"Launch video edit\", \"2027 business plan\", " +
    "\"Billing migration\"). A simple question, an explanation or an exchange that produces nothing towards a goal is NOT a task. " +
    "Personal requests (cooking, health, general knowledge) are never tasks.\n\n" +
    "Known tasks (THIS WEEK) with the items already counted and their size:\n" + (list.length ? list.map((t) => { const w = t.weeks?.[weekKey()] || {}; return `- ${t.id} | ${t.emoji || ""} ${t.title} | ${t.status} | already counted: ${(w.items || []).slice(-12).map((i) => `${i.quoi}${i.size ? ` [${i.size}]` : ""}`).join("; ") || (w.livrables || []).slice(-5).join("; ") || "nothing"}`; }).join("\n") : "(none)") + "\n" +
    (s.taskId ? `This conversation was working on: ${s.taskId}\n` : "") +
    "\nRULES\n" +
    "1. Attach this exchange to an existing task if the topic matches (tache_id), otherwise create one (nouvelle_tache), otherwise null if it is not productive work.\n" +
    "2. \"terminee\" = true ONLY if the FINAL deliverable of the whole task exists: final video exported, business plan finalised or sent, " +
    "migration finished, feature shipped to production… An intermediate step, a pending pull request, a draft to approve = false.\n" +
    "3. \"elements\" = the list, item by item, of what was ACTUALLY produced in THIS exchange (each fix or feature, each email, " +
    "text, visual, slide, edit, analysis, small request), with its SIZE. Not what is only discussed or suggested. " +
    "If an item improves, fixes, redoes or extends something ALREADY COUNTED above, \"nouveau\" = false.\n" + SIZE_GUIDE + "\n" +
    "4. \"statut\" = ONE sentence of 90 characters max on where the conversation stands and what is expected from the user.\n" +
    `5. Write "statut", "livrable", "quoi" and the title of a new task in ${outLang()}.\n\n` +
    "Answer with ONE JSON line, nothing else:\n" +
    '{"tache_id": "existing id or null", "nouvelle_tache": {"titre": "2 to 5 words", "emoji": "1 emoji"} or null, "livrable": "what was just produced (3 to 10 words) or empty", ' +
    '"terminee": true/false, "elements": [{"type": "dev|mail|texte|visuel|slide|video|analyse|requete", "quoi": "...", "nb": 1, "taille": "XS|S|M|L|XL", "nouveau": true}], "statut": "..."}\n\n' +
    "Objective measures of this exchange: " + measures + "\n" +
    "Conversation title: " + (s.title || "?") + "\n" +
    "User requests since the last evaluation:\n- " + (asked.length ? asked.join("\n- ") : "(none)") +
    `\n\nFinal answer${nAnswers > 1 ? "s" : ""} of the assistant:\n` + answer;
  const out = await runHaiku(prompt);
  let v = null;
  try { v = JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch {}
  if (!v) return;
  // what was evaluated leaves the batch (a reply that arrived during the call stays for the next one)
  s.pending = s.pending.slice(asked.length); s.answers = s.answers.slice(nAnswers); s.toolsSince = Math.max(0, s.toolsSince - tools);
  s.batchStart = s.pending.length ? Date.now() : 0;
  s.dUser -= dUser; s.dWork -= dWork;
  if (v.statut) s.note = String(v.statut).replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 110);

  // attach to a task
  let t = v.tache_id && taskStore.tasks.find((x) => x.id === v.tache_id && !x.removed);
  if (!t && v.nouvelle_tache?.titre) {
    const titre = String(v.nouvelle_tache.titre).trim().slice(0, 48);
    t = weekTasks().find((x) => x.title.toLowerCase() === titre.toLowerCase());
    if (!t) {
      t = { id: "t_" + crypto.randomBytes(4).toString("hex"), title: titre, emoji: String(v.nouvelle_tache.emoji || s.emoji || "📌").slice(0, 8),
        status: "en_cours", userSet: false, createdAt: Date.now(), updatedAt: Date.now(), doneAt: 0, sids: [], weeks: {} };
      taskStore.tasks.push(t);
    }
  }
  if (t) {
    s.taskId = t.id;
    const sid = s.historySid || s.claudeSession || s.id;
    if (!t.sids.includes(sid)) t.sids.push(sid);
    const w = wk(t);
    const liv = String(v.livrable || "").trim().slice(0, 80);
    if (liv && !w.livrables.includes(liv)) w.livrables = [...w.livrables, liv].slice(-12);
    // size picked by the model -> fixed minutes, capped (iteration, lines of code, Claude's working time), adjusted by the user's corrections
    const priced = priceItems(v.elements, { codeLines: s.lastCodeLines ?? null, workMinutes: dWork ? dWork / 60000 : null, multipliers: typeMultipliers(taskStore.calib) });
    for (const it of priced) (w.items ||= []).push(it);
    if ((w.items || []).length) {
      w.humanH = Math.round(w.items.reduce((n, i) => n + i.nb * i.minutes, 0) / 60 * 100) / 100;
      w.calcul = `${w.items.length} items`;
    }
    w.userMs += dUser + 0.1 * dWork; // the user's real time: measured interaction + 10 % of Claude's working time (supervision)
    if (!t.userSet && v.terminee === true && t.status !== "faite") { t.status = "faite"; t.doneAt = Date.now(); }
    t.updatedAt = Date.now();
    taskStore.tasks = taskStore.tasks.filter((x) => x.updatedAt > Date.now() - 365 * 864e5);
    saveTasks();
  }
  broadcastState();
}

// ---------- history: the conversations that mattered (≥ 3 exchanges, or already in the history)
function remember(s) {
  const sid = s.historySid || s.claudeSession;
  if (!sid || !s.named) return;
  const it = history.items.find((h) => h.sid === sid);
  if (!it && s.prompts < 3) return;
  const now = new Date().toISOString();
  if (it) Object.assign(it, { emoji: s.emoji, title: s.title, end: now, prompts: Math.max(it.prompts || 0, s.prompts), hidden: false, tag: s.tag || it.tag || "" });
  else history.items.push({ sid, cwd: s.cwd, emoji: s.emoji, title: s.title, start: new Date(s.createdAt).toISOString(), end: now, prompts: s.prompts, tag: s.tag || "" });
  history.items.sort((a, b) => (b.end || "").localeCompare(a.end || ""));
  history.items = history.items.slice(0, 500);
  writeJSON("history.json", history);
}

// ---------- import of the conversations made with Claude Code outside Shoal (~/.claude/projects/*/*.jsonl)
// Only local files are read. Title = the one Claude Code gives itself ("ai-title"), or the first message.
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "projects");
let importing = null;
function importClaudeHistory(force = false) {
  if (importing) return importing;
  if (!settings.importHistory && !force) return Promise.resolve();
  importing = (async () => {
    const since = force ? 0 : history.scannedAt || 0, horizon = Date.now() - 30 * 864e5, tmp = fs.realpathSync(os.tmpdir());
    const known = new Set(history.items.map((h) => h.sid));
    const found = [];
    let dirs = [];
    try { dirs = await fs.promises.readdir(PROJECTS); } catch { return; }
    const files = [];
    for (const d of dirs) {
      let list = []; try { list = await fs.promises.readdir(path.join(PROJECTS, d)); } catch { continue; }
      for (const f of list) if (UUID.test(f.replace(/\.jsonl$/, "")) && f.endsWith(".jsonl") && !known.has(f.slice(0, 36))) {
        const p = path.join(PROJECTS, d, f);
        try { const st = await fs.promises.stat(p); if (st.mtimeMs >= horizon && st.mtimeMs > since) files.push({ p, sid: f.slice(0, 36), st }); } catch {}
      }
    }
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { p, sid, st } of files.slice(0, 300)) {
      try {
        // big transcripts: the beginning (first messages, folder) and the end (title, latest messages) are enough
        let text;
        if (st.size <= 8e6) text = await fs.promises.readFile(p, "utf8");
        else { const fd = await fs.promises.open(p, "r"); const a = Buffer.alloc(2e6), b = Buffer.alloc(1e6); await fd.read(a, 0, a.length, 0); await fd.read(b, 0, b.length, st.size - b.length); await fd.close(); text = a.toString("utf8") + "\n" + b.toString("utf8"); }
        let cwd = "", first = "", aiTitle = "", prompts = 0, start = "";
        for (const l of text.split("\n")) {
          if (l.includes('"ai-title"')) { try { aiTitle = JSON.parse(l).aiTitle || aiTitle; } catch {} continue; }
          if (!l.includes('"type":"user"') || l.includes('"toolUseResult"') || l.includes('"isSidechain":true')) continue;
          let e; try { e = JSON.parse(l); } catch { continue; }
          const c = e.message?.content;
          const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join(" ") : "";
          if (!txt || /^\s*<(command-|local-command|system-reminder)|^Caveat:/.test(txt) || e.isMeta) continue;
          prompts++;
          if (!cwd && e.cwd) cwd = e.cwd;
          if (!first) { first = txt.replace(/\s+/g, " ").trim(); start = e.timestamp || ""; }
        }
        if (prompts < 2 || !cwd || cwd.startsWith(tmp) || cwd.startsWith(os.tmpdir()) || cwd.startsWith("/tmp") || cwd.startsWith("/private/")) continue;
        found.push({ sid, cwd, emoji: "", title: (aiTitle || first).slice(0, 48), start: start || new Date(st.birthtimeMs).toISOString(), end: new Date(st.mtimeMs).toISOString(), prompts, source: "claude", first: first.slice(0, 300) });
      } catch {}
    }
    // one Haiku call picks an emoji for each imported conversation (titles already exist)
    if (found.length && settings.autoName && env.claude) {
      for (let i = 0; i < found.length; i += 40) {
        const chunk = found.slice(i, i + 40);
        const tags = tagChoices();
        const out = await runHaiku("For each numbered work conversation below, pick ONE evocative emoji" +
          (tags.length ? ` and the ONE tag that clearly fits among: ${tags.map((t) => t.name).join(" / ")} (copied exactly), or "-" if none clearly fits (never invent a tag)` : "") +
          `. Answer ONLY with a JSON array, in the same order, of ${tags.length ? '["emoji", "tag or -"] pairs' : "emojis"}, nothing else.\n\n` +
          chunk.map((f, k) => `${k + 1}. ${f.title} | ${f.first.slice(0, 160)}`).join("\n"), "haiku", undefined, 60000);
        let list = []; try { list = JSON.parse((out.match(/\[[\s\S]*\]/) || ["[]"])[0]); } catch {}
        chunk.forEach((f, k) => {
          const v = list[k], e = Array.isArray(v) ? v[0] : v;
          f.emoji = typeof e === "string" ? e.trim().slice(0, 8) : "";
          if (Array.isArray(v)) f.tag = tagByName(v[1])?.id || "";
        });
      }
    }
    for (const f of found) { delete f.first; f.emoji ||= "💬"; if (!history.items.some((h) => h.sid === f.sid)) history.items.push(f); }
    history.items.sort((a, b) => (b.end || "").localeCompare(a.end || ""));
    history.items = history.items.slice(0, 500);
    history.scannedAt = Date.now();
    writeJSON("history.json", history);
  })().finally(() => { importing = null; broadcastState(); });
  return importing;
}
setInterval(() => importClaudeHistory(), 30 * 60e3).unref(); // conversations made in a plain terminal show up too

function resumeSession(sid) {
  const open = [...sessions.values()].find((x) => x.historySid === sid || x.claudeSession === sid);
  if (open) return open;
  const it = history.items.find((h) => h.sid === sid);
  return it ? createSession(it.cwd, it) : null;
}

// ---------- weekly productivity: only the work done during that week
function weekStats(key = weekKey()) {
  const end = weekEnd(key);
  const statusIn = (t) => (t.status === "faite" && t.doneAt && t.doneAt < end ? "faite" : "en_cours");
  const rows = taskStore.tasks.filter((t) => !t.removed && t.weeks?.[key]).map((t) => {
    const w = t.weeks[key], userH = (w.userMs || 0) / 36e5, computed = Math.max(0, (w.humanH || 0) - userH);
    const savedH = w.savedOverride != null ? w.savedOverride : computed;
    return { id: t.id, title: t.title, emoji: t.emoji, status: statusIn(t), userSet: t.userSet, humanH: w.humanH || 0,
      userH: Math.round(userH * 10) / 10, savedH: Math.round(savedH * 10) / 10, livrables: (w.livrables || []).slice(-4), updatedAt: t.updatedAt,
      items: (w.items || []).slice().sort((a, b) => b.nb * b.minutes - a.nb * a.minutes).slice(0, 8).map((i) => ({ quoi: i.quoi, min: i.nb * i.minutes })),
      nItems: (w.items || []).length, adjusted: w.savedOverride != null, computedH: Math.round(computed * 10) / 10 };
  }).sort((a, b) => b.savedH - a.savedH); // ranked by time saved
  const sum = (f) => Math.round(rows.reduce((n, r) => n + f(r), 0) * 10) / 10;
  return { key, current: key === weekKey(), savedH: sum((r) => r.savedH), humanH: sum((r) => r.humanH), userH: sum((r) => r.userH),
    done: rows.filter((r) => r.status === "faite").length, tasks: rows };
}
let weeksMemo = { k: "", v: null };
function allWeeks() {
  const k = `${tasksVer}|${weekKey()}`;
  if (weeksMemo.k !== k) {
    const keys = new Set([weekKey()]);
    for (const t of taskStore.tasks) if (!t.removed) for (const kk of Object.keys(t.weeks || {})) keys.add(kk);
    weeksMemo = { k, v: [...keys].sort().reverse().slice(0, 12).map((kk) => weekStats(kk)) };
  }
  return weeksMemo.v;
}

// ---------- weekly limit: reliable value + daily goal
// Each conversation reports the limit known at ITS last exchange: an idle conversation reports a stale value.
// Within one window usage only goes up, so the highest value is kept.
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mergeWindow(cur, inc) {
  if (!inc || inc.used_percentage == null) return cur;
  if (!cur || (inc.resets_at || 0) > (cur.resets_at || 0) + 60) return { ...inc };       // new window (after a reset)
  if ((inc.resets_at || 0) < (cur.resets_at || 0) - 60) return cur;                       // value from before the reset: ignored
  return { ...cur, used_percentage: Math.max(cur.used_percentage || 0, inc.used_percentage) };
}
function mergeUsage(rl) {
  const before = usage?.seven_day;
  const seven = mergeWindow(before, rl.seven_day);
  usage = { five_hour: mergeWindow(usage?.five_hour, rl.five_hour), seven_day: seven, at: Date.now() };
  if (seven) {
    if (usageDays.window !== seven.resets_at) usageDays = { window: seven.resets_at, days: {} };
    const k = dayKey();
    // first value ever seen (fresh install): today's usage is unknown, so the baseline is the current value, not 0
    if (!usageDays.days[k]) usageDays.days[k] = { start: !before ? seven.used_percentage : before.resets_at === seven.resets_at ? before.used_percentage : 0 };
    writeJSON("usage-days.json", usageDays);
  }
  writeJSON("usage.json", usage);
}
// at startup: rebuild the current window from usage-log.csv (written by the status line)
(function bootstrapUsage() {
  try {
    const w = usage?.seven_day; if (!w?.resets_at) return;
    const startWin = (w.resets_at - 7 * 86400) * 1000;
    const rows = fs.readFileSync(path.join(DATA, "usage-log.csv"), "utf8").trim().split("\n").slice(-5000).map((l) => l.split(","))
      .map(([d, , v]) => ({ t: Date.parse(d.replace(" ", "T")), v: Number(v) })).filter((r) => r.t >= startWin && Number.isFinite(r.v) && r.v > 0);
    usage.seven_day = { ...w, used_percentage: Math.max(w.used_percentage || 0, ...rows.map((r) => r.v)) };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const before = rows.filter((r) => r.t < today.getTime());
    if (usageDays.window !== w.resets_at) usageDays = { window: w.resets_at, days: {} };
    if (!usageDays.days[dayKey()]) usageDays.days[dayKey()] = { start: before.length ? Math.max(...before.map((r) => r.v)) : 0 };
    writeJSON("usage.json", usage); writeJSON("usage-days.json", usageDays);
  } catch {}
})();
// daily goal = weekly goal / number of working days (or the value set in the settings)
const autoDaily = () => Math.max(1, Math.round(settings.weeklyTarget / Math.max(1, settings.workdays.length)));
function dailyUsage() {
  const w = usage?.seven_day; if (!w) return null;
  const weekend = !settings.workdays.includes(new Date().getDay());
  const start = usageDays.window === w.resets_at ? usageDays.days[dayKey()]?.start : undefined;
  return { today: start == null ? null : Math.max(0, Math.round(w.used_percentage - start)), target: settings.dailyTarget || autoDaily(),
    weekend, warnAt: settings.warnAt, weeklyTarget: settings.weeklyTarget };
}

// ---------- updates
// The latest release on GitHub, checked at launch, twice a day and from Settings (Check). The UI only shows a banner for an
// important release (first or second number changed, e.g. 1.0.x → 1.1.0); patches (1.0.2) stay silent.
// On macOS, "Update" opens Terminal with the install command (install.sh: download, replace, reopen).
const REPO = "romainmourad/Shoal";
const INSTALL_CMD = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`;
let update = null;
const vnum = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
function checkUpdate() {
  if (process.env.SHOAL_NO_UPDATE_CHECK) return;
  const failed = () => { update = { ...(update || {}), failed: Date.now() }; broadcastState(); };
  const req = https.get(`https://github.com/${REPO}/releases/latest`, { headers: { "user-agent": "Shoal" }, timeout: 10000 }, (res) => {
    res.resume();
    const m = String(res.headers.location || "").match(/\/tag\/v?(\d+\.\d+\.\d+)$/);
    if (!m) return failed();
    const [a, b, c] = vnum(m[1]), [x, y, z] = vnum(process.env.SHOAL_FAKE_VERSION || VERSION);
    const newer = a !== x ? a > x : b !== y ? b > y : c > z;
    update = { version: m[1], newer, major: newer && (a > x || (a === x && b > y)), cmd: INSTALL_CMD, url: `https://github.com/${REPO}/releases/latest`, checked: Date.now() };
    broadcastState();
  });
  req.on("error", failed);
  req.on("timeout", () => req.destroy());
}
function runUpdate() {
  if (process.platform !== "darwin") return;
  const f = path.join(DATA, "update.command");
  fs.writeFileSync(f, `#!/bin/bash\n# Shoal update: downloads the latest version from GitHub, replaces the app and reopens it\n${INSTALL_CMD}\n`);
  fs.chmodSync(f, 0o755);
  execFile("open", ["-a", "Terminal", f], () => {});
}

// ---------- broadcasting to the UI
// The state is split into parts; each broadcast only sends the parts that changed since the previous one.
const clients = new Set();
function broadcast(msg) { const m = JSON.stringify(msg); for (const c of clients) if (c.readyState === 1) c.send(m); }
function stateParts() {
  const openSids = new Set([...sessions.values()].flatMap((x) => [x.historySid, x.claudeSession]).filter(Boolean));
  const p = {
    sessions: [...sessions.values()].sort((a, b) => a.num - b.num).map(publicSession),
    usage, daily: dailyUsage(), recents, settings, autoDaily: autoDaily(), home: HOME, version: VERSION, update,
    env: { checked: env.checked, claude: !!env.claude, python: !!env.python },
    history: history.items.filter((h) => !h.hidden).map(({ sid, cwd, emoji, title, end, prompts, tag, source }) => ({ sid, cwd, emoji, title, end, prompts, tag, source, open: openSids.has(sid) })),
    weeks: settings.productivity ? allWeeks() : [],
    judging: judgeQueued,
  };
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k] = JSON.stringify(v);
  return out;
}
const joinParts = (parts) => `{"t":"state"${Object.entries(parts).map(([k, v]) => `,"${k}":${v}`).join("")}}`;
let lastParts = {};
let pendingBroadcast = null;
function broadcastState() {
  if (pendingBroadcast) return;
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    const cur = stateParts(), diff = {};
    for (const k in cur) if (cur[k] !== lastParts[k]) diff[k] = cur[k];
    lastParts = cur;
    if (!Object.keys(diff).length) return;
    const m = joinParts(diff);
    for (const c of clients) if (c.readyState === 1) c.send(m);
  }, 40);
}

// ---------- HTTP
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const vendor = (p) => { try { return require.resolve(p); } catch { return ""; } };
const STATIC = {
  "/vendor/xterm.js": vendor("@xterm/xterm/lib/xterm.js"),
  "/vendor/xterm.css": vendor("@xterm/xterm/css/xterm.css"),
  "/vendor/addon-fit.js": vendor("@xterm/addon-fit/lib/addon-fit.js"),
  "/vendor/addon-unicode11.js": vendor("@xterm/addon-unicode11/lib/addon-unicode11.js"),
  "/vendor/addon-web-links.js": vendor("@xterm/addon-web-links/lib/addon-web-links.js"),
};
const MAX_BODY = 1e6;
function body(req) {
  return new Promise((r) => {
    let b = "", size = 0;
    req.on("data", (d) => { size += d.length; if (size <= MAX_BODY) b += d; });
    req.on("end", () => { if (size > MAX_BODY) return r({}); try { r(JSON.parse(b || "{}")); } catch { r({}); } });
  });
}
const authed = (req) => typeof req.headers["x-shoal-token"] === "string" && req.headers["x-shoal-token"].length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(req.headers["x-shoal-token"]), Buffer.from(TOKEN));
// DNS rebinding protection: a web page whose domain resolves to 127.0.0.1 still sends its own Host header
const okHost = (req) => [`${HOST}:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);

const server = http.createServer(async (req, res) => {
  if (!okHost(req)) { res.writeHead(421).end(); return; }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ app: "shoal", version: VERSION })); return; }
  if (req.method === "POST" && url.pathname === "/upload") {
    if (!authed(req)) { res.writeHead(403).end(); return; }
    const chunks = []; let size = 0;
    req.on("data", (d) => { size += d.length; if (size <= 25e6) chunks.push(d); });
    req.on("end", () => {
      if (size > 25e6) { res.writeHead(413).end(); return; }
      const name = (url.searchParams.get("name") || "image.png").normalize("NFD").replace(/[^A-Za-z0-9._-]+/g, "-").slice(-80);
      const file = path.join(UPLOADS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
      fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: file }));
    });
    return;
  }
  if (req.method === "POST") {
    if (!authed(req)) { res.writeHead(403).end(); return; }
    const b = await body(req);
    if (url.pathname === "/quit") { res.writeHead(204).end(); shutdown(); return; }
    const s = sessions.get(b.id);
    if (url.pathname === "/hook" && s) onHook(s, b.event, b.data || {});
    if (url.pathname === "/usage") {
      if (s) { s.ctx = b.ctx ?? s.ctx; s.model = b.model || s.model; }
      if (b.rate_limits && (b.rate_limits.seven_day || b.rate_limits.five_hour)) mergeUsage(b.rate_limits);
      broadcastState();
    }
    res.writeHead(204).end(); return;
  }
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  const file = STATIC[url.pathname] || path.join(WEB, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file || (!STATIC[url.pathname] && !file.startsWith(WEB + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  // static files are validated by ETag: the window keeps its copy as long as they are unchanged
  const st = fs.statSync(file), etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const head = { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", etag, "x-content-type-options": "nosniff" };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, head).end(); return; }
  let content = fs.readFileSync(file);
  res.writeHead(200, head).end(content);
});

// ---------- WebSocket: only from the local UI (protects against a malicious web page)
const wss = new WebSocketServer({ noServer: true, maxPayload: 4e6 });
server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const okOrigin = [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin);
  const tok = url.searchParams.get("token") || "";
  if (!okHost(req) || !okOrigin || tok.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(TOKEN))) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(joinParts(stateParts())); // full state for this new client
  for (const s of sessions.values()) ws.send(JSON.stringify({ t: "replay", id: s.id, data: s.buf.join("") }));
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = sessions.get(m.id);
    if (m.t === "in" && s && typeof m.data === "string") s.pty.write(m.data);
    else if (m.t === "resize" && s && m.cols > 10 && m.rows > 4) { try { s.pty.resize(Math.min(m.cols, 1000), Math.min(m.rows, 500)); } catch {} }
    else if (m.t === "new") { const n = createSession(typeof m.cwd === "string" ? m.cwd.replace(/^~(?=\/|$)/, HOME) : ""); ws.send(JSON.stringify({ t: "created", id: n.id })); }
    else if (m.t === "close") closeSession(m.id);
    else if (m.t === "resume" && UUID.test(m.sid || "")) { const n = resumeSession(m.sid); if (n) ws.send(JSON.stringify({ t: "created", id: n.id })); }
    else if (m.t === "forget") { const it = history.items.find((h) => h.sid === m.sid); if (it) { it.hidden = true; writeJSON("history.json", history); broadcastState(); } }
    else if (m.t === "answer" && s && s.state === "waiting" && s.waitKind === "permission") {
      s.pty.write(m.allow ? "\r" : "\x1b");          // Enter = "Yes" (default option), Escape = "No"
      Object.assign(s, { waitKind: "", permission: null, unread: false, state: m.allow ? "working" : "idle" });
      broadcastState();
    }
    else if (m.t === "taskHours") {
      const t = taskStore.tasks.find((x) => x.id === m.task), h = Number(m.hours);
      if (t && t.weeks?.[m.week]) {
        const w = t.weeks[m.week];
        if (m.reset || !Number.isFinite(h) || h < 0) delete w.savedOverride;
        else {
          const from = Math.round(Math.max(0, (w.humanH || 0) - (w.userMs || 0) / 36e5) * 10) / 10;
          w.savedOverride = Math.round(Math.min(h, 200) * 4) / 4;
          taskStore.calib = [...(taskStore.calib || []).filter((c) => c.title !== t.title), { title: t.title, from, to: w.savedOverride, type: dominantType(w.items) }].slice(-20);
        }
        saveTasks(); broadcastState();
      }
    }
    else if (m.t === "taskStatus") {
      const t = taskStore.tasks.find((x) => x.id === m.task);
      if (t) {
        t.status = m.status === "faite" ? "faite" : "en_cours"; t.userSet = true;
        // marked "done" while looking at a past week: dated from that week
        t.doneAt = t.status !== "faite" ? 0 : (m.week && m.week !== weekKey() && /^\d{4}-\d\d-\d\d$/.test(m.week) ? weekEnd(m.week) - 60e3 : Date.now());
        saveTasks(); broadcastState();
      }
    }
    else if (m.t === "tasksRefresh") refreshTasks();
    else if (m.t === "taskRemove") { const t = taskStore.tasks.find((x) => x.id === m.task); if (t) { t.removed = true; saveTasks(); broadcastState(); } }
    else if (m.t === "settings" && m.patch && typeof m.patch === "object") {
      settings = cleanSettings(m.patch, settings); writeJSON("settings.json", settings);
      if (!settings.productivity) for (const x of sessions.values()) x.note = "";
      broadcastState();
    }
    else if (m.t === "sync" && s) ws.send(JSON.stringify({ t: "replay", id: s.id, data: s.buf.join("") })); // terminal left in the background for too long
    else if (m.t === "update") runUpdate();
    else if (m.t === "checkUpdate") checkUpdate();
    else if (m.t === "recheck") findTools().then(() => { writeClaudeSettings(); broadcastState(); });
    else if (m.t === "stats") {
      const mem = process.memoryUsage();
      ws.send(JSON.stringify({ t: "stats", rss: mem.rss, buffers: [...sessions.values()].reduce((n, x) => n + x.bufLen, 0), uptime: process.uptime(), haiku: haikuRuns }));
    }
    else if (m.t === "tag") {
      // a tag on an open conversation and/or a history entry (kept on both, so it survives a resume)
      const tag = typeof m.tag === "string" && /^[a-z0-9]{0,12}$/.test(m.tag) ? m.tag : "";
      const sid = s ? s.historySid || s.claudeSession : String(m.sid || "");
      if (s) { s.tag = tag; s.tagAuto = false; }
      const it = sid && history.items.find((h) => h.sid === sid);
      if (it) { it.tag = tag; writeJSON("history.json", history); }
      for (const x of sessions.values()) if (!s && sid && (x.historySid === sid || x.claudeSession === sid)) x.tag = tag;
      broadcastState();
    }
    else if (m.t === "importHistory") importClaudeHistory(true).then(() => broadcastState());
    else if (m.t === "seen" && s) { if (s.unread) { s.unread = false; broadcastState(); } }
    else if (m.t === "rename" && s) { if (m.title) s.title = String(m.title).slice(0, 40); if (m.emoji) s.emoji = String(m.emoji).slice(0, 8); s.named = true; broadcastState(); }
  });
});

// ---------- stopping: open conversations are noted so the next start resumes them (claude --resume)
function saveOpen() {
  const open = [...sessions.values()].sort((a, b) => a.num - b.num)
    .map((s) => ({ sid: s.historySid || s.claudeSession, cwd: s.cwd, emoji: s.emoji, title: s.title, tag: s.tag })).filter((r) => UUID.test(r.sid || ""));
  if (open.length) writeJSON("reopen.json", open);
}
function shutdown() {
  try { saveOpen(); } catch {}
  for (const s of sessions.values()) killPty(s, "SIGHUP");
  setTimeout(() => process.exit(0), 300);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);

setInterval(() => broadcastState(), 60000); // day change, weekly reset… (sends nothing when nothing changed)
// housekeeping: pasted images older than 30 days
function cleanUploads() {
  try { for (const f of fs.readdirSync(UPLOADS)) { const p = path.join(UPLOADS, f); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 864e5) fs.unlinkSync(p); } } catch {}
}
cleanUploads(); setInterval(cleanUploads, 864e5).unref();

taskStore.tasks ||= [];
server.on("error", (e) => { console.error(`Shoal: cannot listen on ${HOST}:${PORT} (${e.code})`); process.exit(1); });
server.listen(PORT, HOST, async () => {
  console.log(`Shoal ${VERSION} on http://${HOST}:${PORT} (data: ${DATA})`);
  await findTools();
  writeClaudeSettings();
  broadcastState();
  checkUpdate(); setInterval(checkUpdate, 12 * 3600_000).unref();
  // restart: reopen the conversations that were open (see saveOpen)
  const reopen = (readJSON("reopen.json", []) || []).filter((r) => UUID.test(r.sid || ""));
  try { fs.unlinkSync(path.join(DATA, "reopen.json")); } catch {}
  if (!env.claude) return; // nothing can run yet: the UI explains what to install
  importClaudeHistory();
  if (reopen.length) { for (const r of reopen) createSession(r.cwd, r); return; }
  createSession(process.env.SHOAL_CWD);
});
