// Estimation of the time a deliverable would take WITHOUT AI.
//
// Why sizes instead of minutes: language models are poor at producing durations (they anchor on the
// volume of text the assistant wrote, and every turn looks like a "new feature"), but they classify
// reliably. The model picks a SIZE per item; the code turns sizes into minutes with this fixed table,
// then applies three safeguards:
//   1. an iteration on something already counted is at most S;
//   2. the lines of code written cap the size of dev items (they bound the size, never multiply time:
//      an assistant writes 3 to 5 times more lines than a developer for the same feature);
//   3. a whole batch cannot exceed RATIO x the assistant's working time for that batch (a loose bound:
//      the assistant renders, edits and batch-processes far faster than a person, so a tight ratio
//      crushed real work, e.g. 10 exported video edits counted 3 min each).
// The user's corrections then calibrate a multiplier per type of work.

export const SIZES = {
  dev:     { XS: 10, S: 30, M: 75, L: 180, XL: 420 },
  mail:    { XS: 5,  S: 10, M: 15, L: 30,  XL: 45 },
  texte:   { XS: 5,  S: 10, M: 25, L: 45,  XL: 90 },
  visuel:  { XS: 5,  S: 15, M: 25, L: 45,  XL: 90 },
  slide:   { XS: 5,  S: 15, M: 30, L: 60,  XL: 120 },
  video:   { XS: 10, S: 20, M: 45, L: 90,  XL: 180 },
  analyse: { XS: 5,  S: 15, M: 30, L: 60,  XL: 120 },
  requete: { XS: 5,  S: 10, M: 15, L: 25,  XL: 40 },
};
export const ORDER = ["XS", "S", "M", "L", "XL"];
export const RATIO = 12;         // max human time = 12 x the assistant's working time of the batch
export const MIN_TURN = 20;      // ... but never less than 20 min (quick but valuable answers)

// What each size means, with concrete reference points (shown to the model)
export const SIZE_GUIDE = `SIZES (pick one per item; the duration is computed from it, do not give minutes)
dev — XS 10 min: config change, rename, one-line fix, running a test | S 30 min: small bug fix, small UI tweak, adding an option |
  M 75 min: contained feature (one settings section, a filter, an import, a simple script of ~100 useful lines with no tricky logic) |
  L 3 h: feature touching data + server + UI (e.g. a complete tag system with picker and filters, a theme system), OR a script with real logic
    to design and tune: image / video / audio processing, computer vision (face or blur detection), parsing many files, an external API with edge cases |
  XL 7 h: a NEW application or a new module built from scratch (rare: at most once per project)
mail — XS reply of 2 lines | S recap or follow-up | M technical or sensitive email | L long important email | XL sequence of several emails
texte — XS a few lines | S short text (post, description) | M one page | L long text (article, script) | XL long document
visuel — XS photo choice or variant | S simple visual | M standard design-tool visual | L logo / complex visual | XL full visual identity
slide — S one polished slide | M 2-3 slides | L 4-6 slides | XL full deck
video — XS cut, S touch-up (music, zoom), M short edit, L subtitled short video (≤ 90 s), XL long interview edit; each distinct exported edit is its own item (use nb)
analyse — XS factual answer | S quick check or small table | M analysis of existing data | L documented research with summary | XL multi-source study
requete — XS find a link/info | S small lookup in a tool (CRM, calendar, mailbox) | M lookup across several tools
RULES
- Count what was PRODUCED in this exchange, not what was discussed. Steps (searching, reading, testing, debugging along the way) are included in the deliverable.
- "nouveau": false when the item improves, fixes, redesigns or extends something ALREADY COUNTED (even if the change is big for the assistant): it is an iteration.
- A competent professional who knows the subject and the codebase, working without AI. When in doubt between two sizes, take the smaller.`;

const cap = (size, max) => (ORDER.indexOf(size) > ORDER.indexOf(max) ? max : size);

// lines of code written by the assistant in the turn -> largest plausible dev size
export function maxDevSize(codeLines) {
  if (codeLines < 15) return "S";
  if (codeLines < 120) return "M";
  if (codeLines < 900) return "L";
  return "XL";
}

// items from the model -> items with minutes, after the safeguards
// opts: { codeLines, workMinutes, multipliers: { type: factor } }
export function priceItems(elements, { codeLines = null, workMinutes = null, multipliers = {}, limit = 12 } = {}) {
  const items = [];
  for (const e of Array.isArray(elements) ? elements.slice(0, limit) : []) {
    const type = SIZES[e?.type] ? e.type : null;
    if (!type || !e.quoi) continue;
    let size = ORDER.includes(String(e.taille || e.size || "").toUpperCase()) ? String(e.taille || e.size).toUpperCase() : "S";
    if (e.nouveau === false) size = cap(size, "S");
    if (type === "dev" && codeLines != null) size = cap(size, maxDevSize(codeLines));
    const nb = Math.max(1, Math.min(60, Number(e.nb) || 1));
    const mult = Math.min(2, Math.max(0.3, Number(multipliers[type]) || 1));
    items.push({ type, quoi: String(e.quoi).slice(0, 110), nb, size, iteration: e.nouveau === false, minutes: Math.max(2, Math.round(SIZES[type][size] * mult)) });
  }
  // whole turn: at most RATIO x the assistant's working time (scaled down proportionally)
  if (workMinutes != null && items.length) {
    const total = items.reduce((n, i) => n + i.nb * i.minutes, 0), max = Math.max(MIN_TURN, RATIO * workMinutes);
    if (total > max) for (const i of items) i.minutes = Math.max(2, Math.round(i.minutes * max / total));
  }
  return items;
}

// user's corrections -> multiplier per type (geometric mean of the recent ratios real/estimated, clamped)
export function typeMultipliers(calib = []) {
  const by = {};
  for (const c of calib.slice(-20)) if (c.type && c.from > 0 && c.to >= 0) (by[c.type] ||= []).push(Math.max(0.2, Math.min(3, c.to / c.from)));
  const out = {};
  for (const [t, r] of Object.entries(by)) out[t] = Math.min(2, Math.max(0.3, Math.exp(r.reduce((n, x) => n + Math.log(x), 0) / r.length)));
  return out;
}

// dominant type of a task-week (where most of the minutes are), to attach a correction to a type
export function dominantType(items = []) {
  const m = {};
  for (const i of items) m[i.type] = (m[i.type] || 0) + i.nb * i.minutes;
  return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
