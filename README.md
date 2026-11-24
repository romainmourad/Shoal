<p align="center">
  <img src="src/web/icon.png" width="96" alt="Shoal logo">
</p>

<h1 align="center">Shoal</h1>

<p align="center">
  <b>The desktop app for running several Claude Code sessions side by side.</b><br>
  The real Claude Code CLI, with the comfort of a desktop app: live status, notifications, auto-named conversations, tags, history, weekly-limit tracking and hours-saved stats.
</p>

<p align="center">
  <a href="https://github.com/romainmourad/Shoal/releases"><b>Download for macOS</b></a> ·
  <a href="https://github.com/romainmourad/Shoal/releases"><b>Windows (experimental)</b></a> ·
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#privacy">Privacy</a>
</p>

<p align="center">
  <img src="docs/screenshot-main.png" alt="Shoal: a Claude Code conversation on the left, all running sessions with live status and tags on the right" width="100%">
</p>

## Why Shoal?

If you use **Claude Code** seriously, you probably run several sessions in parallel: one fixing a bug, one writing tests, one drafting docs or emails. In a plain terminal that quickly becomes a wall of tabs:

- you don't know which session **finished** or is **waiting for your approval** until you check them one by one;
- you forget what each tab was about;
- you have no idea how much of your **weekly Claude limit** you are burning;
- your past sessions are buried in `claude --resume` lists.

Desktop chat apps solve the comfort part, but you lose what makes Claude Code great: your own settings, `CLAUDE.md`, permissions, hooks, MCP servers, plugins and full shell access.

**Shoal is the best of both worlds.** Every conversation *is* the real `claude` CLI running in a real terminal, with your setup untouched. Shoal adds the layer a terminal can't give you: an overview, alerts, organization and stats.

| | Claude Code in a terminal | **Shoal** |
|---|:-:|:-:|
| Real Claude Code CLI, your settings, MCP servers, hooks, plugins | ✅ | ✅ |
| Several sessions in one window, the focused one large | Tabs / splits | ✅ |
| See at a glance who is working, done, or waiting for you | ❌ | ✅ |
| Approve or deny permission requests from the list | ❌ | ✅ |
| Sound, in-app alert, system notification, Dock / taskbar badge | ❌ | ✅ |
| Emoji + title for every conversation, automatically | ❌ | ✅ |
| Tags (per client, project or personal life) with filters | ❌ | ✅ |
| Searchable history, resume in one click (terminal sessions included) | `--resume` list | ✅ |
| Weekly limit, reset date and daily pace | Not shown by default | ✅ always visible |
| Hours saved per task, per week | ❌ | ✅ |
| Paste or drop screenshots into the prompt | Depends on the terminal | ✅ |
| Themes, English / French | Terminal theme | ✅ 8 themes |

## Features

- **Focused terminal + conversation list.** The session you work on is large on one side; all the others are listed on the other, like a messaging app. Switch with ⌘1…⌘9 or jump to the next one that needs you with ⌘J.
- **Live status for every session.** *Working*, *Done · your turn*, *Waiting for your reply*, *Permission requested* (with the exact command or file, and Allow / Deny buttons right in the list).
- **Never miss a finished task.** Sound, in-app alert, macOS / Windows notification and a badge with the number of sessions waiting for you.
- **Auto-named conversations.** An emoji and a 2–4 word title chosen from the first message (unique among open sessions), plus a one-line "where we are" note after each reply.
- **Tags with automatic tagging.** Create your own tags with Notion-style colors (e.g. *Client A*, *Side project*, *Personal*). New conversations are tagged from their first message, only with your existing tags, and you can change it anytime. Filter open conversations and history by one or several tags.
- **History.** Every important conversation, including the ones you had in a plain terminal over the last 30 days, searchable and resumable in one click, in its original folder.
- **Weekly limit at a glance.** Percentage used, reset date, and a daily goal (your weekly goal spread over your working days) so you don't burn the week on Monday. Works with Claude subscription plans that have usage limits; can be hidden if yours doesn't.
- **Hours saved.** After each reply, every deliverable Claude produced (a fix, a feature, an email, a slide…) is classified by size and priced against fixed references, then summed per task and per week. You can correct any figure; corrections calibrate future estimates.
- **Comfort.** Paste or drop images, 8 themes (Malachite, Amethyst, Amber, Aquamarine, each dark and light), sidebar on the left or right, a first-launch tour, English and French.
- **Light on resources.** Background terminals don't render, only state changes are sent to the window, and the server stays around 30–50 MB.

<p align="center">
  <img src="docs/screenshot-tags.png" alt="Tag picker with Notion-style colors" width="32%">
  <img src="docs/screenshot-themes.png" alt="Settings: eight themes" width="66%">
</p>
<p align="center">
  <img src="docs/screenshot-light.png" alt="Amber light theme, history filtered by tag" width="100%">
</p>

> Shoal is built for **Anthropic's Claude Code**. Its terminals can run any command-line agent, but live status, naming, limits and history rely on Claude Code's hooks and status line. Support for other agents such as **OpenAI Codex CLI**, **Google Gemini CLI**, **Aider** or **opencode** is on the [roadmap](#roadmap): contributions welcome.
>
> Shoal is an independent open-source project, not affiliated with or endorsed by Anthropic.

## Requirements

- **macOS** 13 or later (Apple silicon or Intel), or **Windows 10/11** (x64, *experimental*, see below).
- **Claude Code**, installed and signed in once in a terminal:
  ```sh
  curl -fsSL https://claude.ai/install.sh | bash
  claude          # sign in, then quit with /exit
  ```
- **Python 3** (used by the small scripts that tell Shoal what each conversation is doing). Either install it from [python.org](https://www.python.org/downloads/), or run `xcode-select --install`.
- On Windows: Claude Code with its native installer (`irm https://claude.ai/install.ps1 | iex` in PowerShell, which needs [Git for Windows](https://git-scm.com/download/win)), and Python from [python.org](https://www.python.org/downloads/windows/) (tick **"Add python.exe to PATH"**).

Nothing else: Shoal ships its own runtime, no Node.js needed.

<a id="install"></a>
## Install

Paste this in Terminal (macOS, Apple silicon or Intel):

```bash
curl -fsSL https://raw.githubusercontent.com/romainmourad/Shoal/main/install.sh | bash
```

It downloads the latest release from GitHub, puts **Shoal.app** in your Applications folder and opens it. No security prompt: macOS only blocks apps downloaded with a browser. The script is short, [read it](install.sh) if you like.

<details>
<summary>Manual install</summary>

1. Download `Shoal-<version>-mac-arm64.zip` (Apple silicon) or `…-mac-x64.zip` (Intel) from the [Releases](https://github.com/romainmourad/Shoal/releases) page.
2. Unzip it and move **Shoal.app** to your **Applications** folder.
3. **First launch.** The app is not notarized by Apple (that requires a paid developer account), so macOS blocks it the first time. Either:
   - open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**; or
   - run this in a terminal: `xattr -dr com.apple.quarantine /Applications/Shoal.app`
</details>

If something is missing (Claude Code or Python), Shoal tells you what to install and lets you check again.

### Update

Run the same command again:

```bash
curl -fsSL https://raw.githubusercontent.com/romainmourad/Shoal/main/install.sh | bash
```

It quits Shoal, replaces it with the latest version and opens it again. Open conversations are resumed; your history, tasks and settings (in `~/Library/Application Support/Shoal`) are kept.

When a release brings important fixes, Shoal shows a banner with an **Update** button: it explains what will happen, then opens Terminal with this command once you confirm. Minor releases don't show the banner. On Windows, download the new zip from the [Releases](https://github.com/romainmourad/Shoal/releases) page and replace the folder.

### Windows (experimental)

1. Download `Shoal-<version>-win-x64.zip` from the [Releases](https://github.com/romainmourad/Shoal/releases) page, unzip it anywhere (e.g. `C:\Users\you\Apps\Shoal`) and run **Shoal.exe**.
2. The app is not code-signed, so Windows SmartScreen may warn on first launch: click **More info → Run anyway**.
3. Conversations run in PowerShell. Shortcuts use **Ctrl** instead of ⌘ (Ctrl+Shift+K new conversation, Ctrl+1…9, Ctrl+Shift+J, Ctrl+Shift+, settings). Ctrl+C copies when text is selected.

The Windows version is built and smoke-tested automatically on a Windows machine by GitHub Actions, but it has had little real-world use yet: please [open an issue](https://github.com/romainmourad/Shoal/issues) if something doesn't work.

## Use

| Shortcut | Action |
|---|---|
| ⌘K | New conversation |
| ⌘1 … ⌘9 | Go to conversation n |
| ⌘J | Next conversation that needs you |
| ⌘, | Settings |
| ⇧Enter | New line in the prompt |

- **New conversation**: the green button (folder button next to it: pick where it starts). New conversations open in `~/Shoal` by default (Claude Code asks once whether you trust that folder); change it in Settings.
- **Rename** a conversation: double-click its title. **Close** it: hover its card and click ×.
- **Tag** a conversation: hover its card and click the tag icon. Create tags in **Settings → Tags**; the chips above the list filter both open conversations and History.
- **Images**: paste a screenshot (⌘V) or drop an image on the terminal; it is attached to the prompt like in Claude Code.
- **Closing the window** keeps your conversations running. **⌘Q** stops them; they are resumed (`claude --resume`) the next time you open Shoal. You can choose to keep them running after quitting in Settings.

## Settings

Appearance (theme, sidebar on the left or right, text size) · language · notifications (finished, waiting, macOS, sound, Dock badge) · weekly goal, working days, daily goal and warning threshold (or no weekly limit tracking at all, for plans without one) · default folder and model for new conversations · automatic emoji and title · terminal text size and memory · tags · history import · hours-saved tracking.

<a id="privacy"></a>
## Privacy

Shoal runs entirely on your Mac. There is no Shoal server, account, analytics or telemetry.

- The app talks to a local server bound to `127.0.0.1` only. It is protected by a random access token that is given to the Shoal window and never served over HTTP; requests from web pages (other origins or hostnames) are rejected.
- Your data (settings, history, tags, tasks, pasted images) lives in `~/Library/Application Support/Shoal`, readable by your user only. Pasted images are deleted after 30 days.
- Conversations are regular Claude Code sessions: what they send to Anthropic is exactly what Claude Code sends.
- **Background model calls.** Three optional features use small, tool-less `claude -p --model haiku` calls through your own Claude Code login, which count towards your usage:
  - naming a conversation (its first message, up to 600 characters);
  - hours saved (after each reply: your recent messages, the end of Claude's answer, and the names of this week's tasks);
  - emojis and tags for imported history (titles and first messages);
  - automatic tag of a new conversation (done in the same call as its name).

  Each one can be turned off in Settings.
- History import reads your Claude Code transcripts in `~/.claude/projects` locally, to list the last 30 days of conversations. It can be turned off.
- **Update check.** At launch and twice a day, Shoal asks GitHub which release is the latest (one request to `github.com/romainmourad/Shoal/releases/latest`, nothing about you is sent).
- Shoal never modifies your `~/.claude/settings.json`: its hooks and status line are passed to the conversations it starts with `claude --settings`.

## How it works

```
Shoal.app (Electron)
 ├─ window: src/web (xterm.js terminals, list, settings)
 └─ local server: src/server/server.mjs (Electron's Node, 127.0.0.1)
     ├─ one pseudo-terminal per conversation: your shell → claude --settings <Shoal hooks>
     ├─ Claude Code hooks (src/hooks/hook.py): working / done / waiting / permission
     └─ status line (src/hooks/statusline.py): context size and weekly limits
```

Hours saved: after each reply, Haiku lists what was actually produced (a fix, an email, a slide, an analysis…) and classifies each item by **size** (XS to XL). Models are poor at producing durations but good at classifying, so the minutes come from a fixed table ([`src/server/estimate.mjs`](src/server/estimate.mjs)), with three safeguards: an improvement of something already counted is an iteration (30 min at most); the lines of code Claude wrote only cap the size (it writes 3 to 5 times more than a developer would); and a reply never counts more than 6× Claude's working time. The time you spent steering Claude is subtracted. Click the hours of a task to correct them: corrections build a multiplier per type of work (dev, email, visual…) applied to later estimates.

## Build from source

Requires Node.js 20+.

```sh
git clone https://github.com/romainmourad/Shoal.git && cd shoal
npm install
npm start            # run in development
npm run dist:mac     # build dist/Shoal-<version>-mac-{arm64,x64}.zip
npm run dist:win     # build dist/Shoal-<version>-win-x64.zip
node scripts/smoke.mjs   # start the server, open a real terminal, check it works
```

`SHOAL_DATA=/some/folder SHOAL_PORT=4800 npm start` runs a separate instance with its own data, which is handy for development.

## Troubleshooting

- **"Almost ready" banner**: Shoal could not find `claude` or `python3` through your login shell. Install the missing one, then click **Check again**.
- **Statuses don't update** (a conversation stays "Working"): check that `python3 --version` works in a terminal, then close and reopen the conversation.
- **Logs**: `~/Library/Application Support/Shoal/server.log` (Windows: `%APPDATA%\Shoal\server.log`).

## Roadmap

- Windows: real-world testing and a signed installer.
- Adapters for other terminal agents: OpenAI Codex CLI, Google Gemini CLI, Aider, opencode.
- Linux build.
- Per-item corrections in the hours-saved detail.

Ideas and pull requests are welcome: [open an issue](https://github.com/romainmourad/Shoal/issues).

## License

[MIT](LICENSE)
