#!/usr/bin/env node
/**
 * GS-Helper daily data updater (v2).
 *
 * Usage:  node scripts/update-data.mjs <path-to-GSReact-clone> [--index index.html] [--dry-run]
 *
 * Pulls fresh unit / tier / equipment data from a local clone of
 * https://github.com/Reymdusk/GSReact (the source of grandsummoners.info)
 * and rewrites the embedded <script type="text/plain"> data blocks in index.html.
 *
 * v2: GSReact stores data as JavaScript modules (unquoted keys, single quotes,
 * `export const X = [...]`), not JSON. Data files are now evaluated inside a
 * bare `node:vm` sandbox — no require/import, no fs, no network, no process,
 * 2s timeout — so pure data literals parse and anything else is skipped.
 *
 * Safety model — the script NEVER makes the site worse:
 *   • Append-only for units, kits, slots, equips, images (nothing is ever removed).
 *   • Tiers are fully rebuilt (that's the point of daily updates), but ONLY if the
 *     fresh tier data still covers >= 80% of the previous tier list; otherwise the
 *     old tiers are kept and a warning is printed.
 *   • Hard validation gates before writing. Any failure => exit 1, file untouched.
 *   • If nothing changed, the file is not rewritten (so the workflow makes no commit).
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const args = process.argv.slice(2);
const SRC_DIR = args.find(a => !a.startsWith("--"));
const INDEX = (args.includes("--index") ? args[args.indexOf("--index") + 1] : null) || "index.html";
const DRY = args.includes("--dry-run");
if (!SRC_DIR || !fs.existsSync(SRC_DIR)) {
  console.error("Usage: node scripts/update-data.mjs <path-to-GSReact-clone> [--index index.html] [--dry-run]");
  process.exit(1);
}

const ELEMENTS = ["Fire", "Water", "Earth", "Light", "Dark"];
const ELSET = new Set(ELEMENTS.map(e => e.toLowerCase()));
const TIERS = ["SS","S","A+","A","A-","B+","B","B-","C+","C","C-","D","F"];
const TIERSET = new Set(TIERS);
const EQ_TYPES = { physical:"phys", phys:"phys", magic:"mag", mag:"mag", support:"supp", supp:"supp",
                   heal:"heal", healing:"heal", defense:"def", defence:"def", def:"def" };

const log  = (...a) => console.log("[update]", ...a);
const warn = (...a) => console.warn("[update][WARN]", ...a);
const fail = (msg) => { console.error("[update][FAIL]", msg, "— index.html NOT modified."); process.exit(1); };

/* ---------------- 1. read current blocks from index.html ---------------- */

let html = fs.readFileSync(INDEX, "utf8");
function getBlock(id) {
  const re = new RegExp(`(<script type="text/plain" id="${id}">)([\\s\\S]*?)(</script>)`);
  const m = html.match(re);
  if (!m) fail(`data block #${id} not found in ${INDEX}`);
  return m[2].replace(/^\n|\n$/g, "");
}
function setBlock(id, text) {
  const re = new RegExp(`(<script type="text/plain" id="${id}">)[\\s\\S]*?(</script>)`);
  html = html.replace(re, `$1\n${text}\n$2`);
}

const cur = {
  units: getBlock("unitData").split("\n").filter(Boolean).map(l => {
    const sp = l.indexOf(" "); return { el: l.slice(0, sp), name: l.slice(sp + 1).trim() };
  }),
  tierLines: getBlock("tierData").split("\n").filter(Boolean),
  kits: getBlock("kitData").split("\n").filter(Boolean),
  slots: getBlock("slotData").split("\n").filter(Boolean),
  eq: getBlock("eqData").split("\n").filter(Boolean),
  eqLoc: getBlock("eqLocData").split("\n").filter(Boolean),
  uImg: getBlock("uImgData").split("\n").filter(Boolean),
  eImg: getBlock("eImgData").split("\n").filter(Boolean),
};
const knownUnitNames  = new Set(cur.units.map(u => u.name.toLowerCase()));
const knownEquipNames = new Set(cur.eq.map(l => l.split("|")[0].toLowerCase()));
const knownUnitImgIds = new Set(cur.uImg.map(l => String(l.split("|")[1] || "").trim()));
log(`current snapshot: ${cur.units.length} units, ${cur.eq.length} equips, ${cur.tierLines.filter(l=>!l.startsWith("#")).length} tier entries`);

/* ---------------- 2. discover & parse candidate data files ---------------- */

const SKIP_FILES = /^(package(-lock)?\.json|manifest\.json|settings\.json|tsconfig.*\.json|.*\.config\.(js|mjs|cjs|json)|.*\.test\.(js|mjs|ts)|.*\.min\.js)$/i;

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".git") || ent.name === ".vscode") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * v2 parser. JSON files -> JSON.parse. JS/TS module files -> evaluate in a bare
 * vm sandbox (no globals, no require/import, 2s timeout). Import lines are
 * stripped; `export default X` and `export const NAME = X` are captured. Files
 * with real logic (functions, JSX, requires) simply throw inside the sandbox
 * and are skipped — only pure data literals survive, which is exactly what we want.
 */
function parseDataFile(p) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return { data: null, note: "unreadable" }; }
  if (text.length > 30_000_000) return { data: null, note: "too large" };
  if (p.endsWith(".json")) {
    try { return { data: JSON.parse(text) }; } catch { return { data: null, note: "bad JSON" }; }
  }
  if (!/[\[{]/.test(text)) return { data: null, note: "no literals" };
  const prepped = text
    .replace(/^\s*import[^;\n]*;?\s*$/gm, "")                 // strip import lines
    .replace(/^\s*export\s+default\s+/m, "__ret = ")           // capture default export
    .replace(/export\s+(const|let|var)\s+(\w+)\s*=/g, "__all.$2 =") // capture named exports
    .replace(/module\.exports\s*=\s*/g, "__ret = ")
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "");
  const sandbox = { __all: {}, __ret: undefined };
  try {
    vm.runInNewContext(prepped, sandbox, { timeout: 2000, filename: p });
  } catch (e) { return { data: null, note: "eval: " + String(e.message).slice(0, 60) }; }
  const named = Object.keys(sandbox.__all).length ? sandbox.__all : null;
  const data = sandbox.__ret !== undefined
    ? (named ? { __default: sandbox.__ret, ...named } : sandbox.__ret)
    : named;
  return data ? { data } : { data: null, note: "no exports captured" };
}

/** Collect every array-of-plain-objects (len>=25) nested anywhere in a value. */
function collectArrays(v, out = [], depth = 0) {
  if (depth > 6 || v == null) return out;
  if (Array.isArray(v)) {
    if (v.length >= 25 && v.every(x => x && typeof x === "object" && !Array.isArray(x))) out.push(v);
    else v.forEach(x => collectArrays(x, out, depth + 1));
  } else if (typeof v === "object") {
    const vals = Object.values(v);
    if (vals.length >= 25 && vals.every(x => x && typeof x === "object" && !Array.isArray(x))) out.push(vals);
    vals.forEach(x => collectArrays(x, out, depth + 1));
  }
  return out;
}

const parsedFiles = [], scanned = [];
for (const p of walk(SRC_DIR)) {
  if (!/\.(json|js|mjs|cjs|ts)$/.test(p)) continue;
  if (SKIP_FILES.test(path.basename(p))) continue;
  const size = fs.statSync(p).size;
  const { data, note } = parseDataFile(p);
  scanned.push({ p, size, ok: !!data, note: note || "ok" });
  if (data) parsedFiles.push({ p, data });
}
log(`scanned ${scanned.length} candidate files, parsed ${parsedFiles.length}`);

function discoveryReport() {
  const rows = scanned.sort((a, b) => b.size - a.size).slice(0, 25)
    .map(s => `  ${s.ok ? "✓" : "✗"} ${(s.size/1024).toFixed(0).padStart(6)} KB  ${path.relative(SRC_DIR, s.p)}  ${s.ok ? "" : "(" + s.note + ")"}`);
  return "Largest candidate files (✓ parsed / ✗ skipped):\n" + rows.join("\n");
}
if (parsedFiles.length === 0) fail("no parseable data files found in source clone.\n" + discoveryReport());

const candidates = [];
for (const f of parsedFiles) for (const arr of collectArrays(f.data)) candidates.push({ file: f.p, arr });

/* ---------------- 3. field mapping helpers ---------------- */

const strVals = (arr, k) => arr.map(o => o[k]).filter(v => typeof v === "string" || typeof v === "number").map(String);

function bestKeyBy(arr, scoreFn) {
  const keys = new Set(); arr.slice(0, 50).forEach(o => Object.keys(o).forEach(k => keys.add(k)));
  let best = null, bestScore = 0;
  for (const k of keys) { const s = scoreFn(k); if (s > bestScore) { bestScore = s; best = k; } }
  return { key: best, score: bestScore };
}
const nameHitScore = (arr, k, known) => strVals(arr, k).filter(v => known.has(v.trim().toLowerCase())).length;
function elementKey(arr) {
  return bestKeyBy(arr, k => {
    const vals = strVals(arr, k); if (!vals.length) return 0;
    const hit = vals.filter(v => ELSET.has(v.trim().toLowerCase())).length;
    return hit / vals.length >= 0.9 ? hit : 0;
  });
}
const titleEl = v => { v = String(v).trim().toLowerCase(); return v.charAt(0).toUpperCase() + v.slice(1); };
function longTextKeys(arr) {
  const keys = new Set(); arr.slice(0, 30).forEach(o => Object.keys(o).forEach(k => keys.add(k)));
  return [...keys].filter(k => {
    const vals = strVals(arr, k).slice(0, 30);
    return vals.length && vals.reduce((a, v) => a + v.length, 0) / vals.length > 40;
  });
}
function allText(o, depth = 0) {
  if (depth > 4 || o == null) return "";
  if (typeof o === "string") return o + " ";
  if (Array.isArray(o)) return o.map(x => allText(x, depth + 1)).join("");
  if (typeof o === "object") return Object.values(o).map(x => allText(x, depth + 1)).join("");
  return "";
}

/* ---------------- 4. identify the unit / equip / tier sources ---------------- */

function pickBest(known, minHits) {
  let best = null;
  for (const c of candidates) {
    const { key, score } = bestKeyBy(c.arr, k => nameHitScore(c.arr, k, known));
    if (score >= minHits && (!best || score > best.score)) best = { ...c, nameKey: key, score };
  }
  return best;
}
const unitSrc  = pickBest(knownUnitNames, 50);
const equipSrc = pickBest(knownEquipNames, 50);
if (!unitSrc) {
  // help the next debugging round: show the best scores we DID see
  const scores = candidates.map(c => {
    const { key, score } = bestKeyBy(c.arr, k => nameHitScore(c.arr, k, knownUnitNames));
    return { f: path.relative(SRC_DIR, c.file), len: c.arr.length, key, score };
  }).sort((a, b) => b.score - a.score).slice(0, 10)
    .map(s => `  ${s.score} unit-name hits via '${s.key}' in ${s.f} (array len ${s.len})`);
  fail("could not identify the UNIT data file (no candidate matched >=50 known unit names).\nBest candidates seen:\n" + (scores.join("\n") || "  (none)") + "\n" + discoveryReport());
}
if (!equipSrc) warn("could not identify the EQUIPMENT data file — equips will not be updated this run.");
log(`unit source:  ${unitSrc.file}  (${unitSrc.score} name hits, nameKey='${unitSrc.nameKey}')`);
if (equipSrc) log(`equip source: ${equipSrc.file}  (${equipSrc.score} name hits, nameKey='${equipSrc.nameKey}')`);

/* Tier source: (a) an array of objects with a tier-valued field, or
   (b) an object keyed by tier labels whose values are arrays of names/objects. */
function findTierSource() {
  let best = null;
  for (const c of candidates) {
    const { key } = bestKeyBy(c.arr, k => {
      const vals = strVals(c.arr, k); if (!vals.length) return 0;
      const hit = vals.filter(v => TIERSET.has(v.trim().toUpperCase())).length;
      return hit / vals.length >= 0.8 ? hit : 0;
    });
    if (!key) continue;
    const { key: nk, score: ns } = bestKeyBy(c.arr, k => nameHitScore(c.arr, k, knownUnitNames));
    if (ns >= 30 && (!best || ns > best.ns)) best = { kind: "array", arr: c.arr, tierKey: key, nameKey: nk, ns, file: c.file };
  }
  for (const f of parsedFiles) {
    const scan = (v, depth = 0) => {
      if (depth > 4 || !v || typeof v !== "object" || Array.isArray(v)) return;
      const keys = Object.keys(v);
      const tierKeys = keys.filter(k => TIERSET.has(k.trim().toUpperCase()));
      if (tierKeys.length >= 5) {
        let hits = 0; const groups = {};
        for (const tk of tierKeys) {
          const list = (Array.isArray(v[tk]) ? v[tk] : []).map(x =>
            typeof x === "string" ? x : (x && typeof x === "object" ? (x.name ?? x.unitName ?? x.Name ?? "") : "")
          ).map(String).filter(Boolean);
          groups[tk.trim().toUpperCase()] = list;
          hits += list.filter(n => knownUnitNames.has(n.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase()) || knownUnitNames.has(n.toLowerCase())).length;
        }
        if (hits >= 30 && (!best || hits > (best.ns || 0))) best = { kind: "grouped", groups, ns: hits, file: f.p };
      }
      Object.values(v).forEach(x => scan(x, depth + 1));
    };
    scan(f.data);
  }
  return best;
}
const tierSrc = findTierSource();
if (tierSrc) log(`tier source:  ${tierSrc.file}  (${tierSrc.ns} name hits, kind=${tierSrc.kind})`);
else warn("could not identify a TIER source — existing tiers will be kept.");

/* ---------------- 5. derivation heuristics (for NEW entries only) ---------------- */

function deriveTraits(text) {
  const t = text.toLowerCase(); const out = [];
  const add = x => { if (!out.includes(x)) out.push(x); };
  if (/parall?y[sz]/.test(t)) add("paralysis");
  if (/freez|frozen/.test(t)) add("freeze");
  if (/burn/.test(t)) add("burn");
  if (/poison/.test(t)) add("poison");
  if (/taunt/.test(t)) add("taunt");
  if (/(reduc\w+ (all )?(allies'?|target'?s?) dmg taken|dmg taken by)/.test(t)) add("mitigation");
  if (/(heals? .{0,30}(status|ailment)|removes .{0,20}(status|ailment)|cures)/.test(t)) add("cleanse");
  if (/arts gauge/.test(t) && /(allies|party)/.test(t)) add("artsBattery");
  if (/true dmg|true damage/.test(t)) add("trueDamage");
  if (/all enemies/.test(t)) add("aoe");
  if (/reviv|recover(s|y) from ko/.test(t)) add("revive");
  return out;
}
function deriveRole(text, traits) {
  const t = text.toLowerCase();
  if (traits.includes("taunt")) return "Tank";
  if (/(heals? (all )?allies'? hp|restores .{0,20}allies'? hp)/.test(t)) return "Healer";
  if (/break (power|pwr)/.test(t) && !/\d{3,}% dmg/.test(t)) return "Breaker";
  if (traits.includes("artsBattery") && !/\b[5-9]\d{2,}% dmg\b/.test(t)) return "Support";
  return "Attacker";
}
function deriveEquipTraits(effect) {
  const base = deriveTraits(effect); const t = effect.toLowerCase();
  if (/crit/.test(t)) base.push("crit");
  if (/(fire|water|earth|light|dark) dmg (\+|up|boost)/.test(t)) base.push("elementUp");
  if (/heals?/.test(t) && !base.includes("heal")) base.push("heal");
  return [...new Set(base)];
}
function deriveSrcCategory(loc) {
  const t = (loc || "").toLowerCase();
  if (/craft/.test(t)) return "craft";
  if (/arena/.test(t)) return "arena";
  if (/(raid|giant boss|boss)/.test(t)) return "boss";
  if (/(gacha|summon|banner)/.test(t)) return "gacha";
  if (/dungeon/.test(t)) return "dungeon";
  if (/side story/.test(t)) return "sidestory";
  if (/(chapter|main story|quest)/.test(t)) return "story";
  if (/event/.test(t)) return "event";
  return "other";
}
const clean = s => String(s ?? "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim();

/* ---------------- 6. build updates ---------------- */

const report = { newUnits: [], newEquips: [], tierRebuilt: false, tierMoved: 0, newUImg: 0, newEImg: 0 };

/* --- 6a. new units + kits + slots + images --- */
const uEl = elementKey(unitSrc.arr);
if (!uEl.key) fail("unit source found but no element field could be identified.");
const uImgKey = bestKeyBy(unitSrc.arr, k =>
  strVals(unitSrc.arr, k).filter(v => knownUnitImgIds.has(v.trim())).length).key
  || bestKeyBy(unitSrc.arr, k => (/thumb|img|icon/i.test(k) ? 1 : 0)).key;
const slotKey = bestKeyBy(unitSrc.arr, k => {
  let hit = 0;
  unitSrc.arr.slice(0, 60).forEach(o => {
    const v = o[k]; const s = Array.isArray(v) ? v.join(",") : typeof v === "string" ? v : "";
    if (/(physical|magic|support|heal|defen[cs]e)/i.test(s)) hit++;
  });
  return hit;
}).key;
log(`unit fields — element:'${uEl.key}' img:'${uImgKey || "-"}' slots:'${slotKey || "-"}'`);

const addUnitLines = [], addKitLines = [], addSlotLines = [], addUImgLines = [];
for (const o of unitSrc.arr) {
  const name = String(o[unitSrc.nameKey] ?? "").trim();
  const el = titleEl(o[uEl.key] ?? "");
  if (!name || !ELSET.has(el.toLowerCase())) continue;
  if (knownUnitNames.has(name.toLowerCase())) continue;      // append-only
  knownUnitNames.add(name.toLowerCase());
  const text = allText(o);
  const traits = deriveTraits(text);
  const role = deriveRole(text, traits);
  addUnitLines.push(`${el} ${name}`);
  addKitLines.push(`${el}|${role}|${name}|${traits.join(",")}`);
  if (slotKey) {
    const v = o[slotKey];
    const rawSlots = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,/]/) : [];
    const mapped = rawSlots.map(s => EQ_TYPES[String(s).trim().toLowerCase()] || "").filter(Boolean);
    if (mapped.length >= 3) addSlotLines.push(`${name} (${el})|${mapped.slice(0, 3).join(",")}`);
  }
  if (uImgKey && o[uImgKey] != null) { addUImgLines.push(`${name} (${el})|${String(o[uImgKey]).trim()}`); report.newUImg++; }
  report.newUnits.push(`${name} (${el}) — ${role}${traits.length ? " · " + traits.join(",") : ""}`);
}

/* --- 6b. new equips + locations + images --- */
const addEqLines = [], addEqLocLines = [], addEImgLines = [];
if (equipSrc) {
  const a = equipSrc.arr;
  const typeKey = bestKeyBy(a, k => {
    const vals = strVals(a, k); if (!vals.length) return 0;
    const hit = vals.filter(v => EQ_TYPES[v.trim().toLowerCase()]).length;
    return hit / vals.length >= 0.8 ? hit : 0;
  }).key;
  const starKey = bestKeyBy(a, k => {
    const vals = a.map(o => o[k]).filter(v => typeof v === "number" || /^\d$/.test(String(v)));
    const hit = vals.filter(v => +v >= 1 && +v <= 6).length;
    return vals.length && hit / vals.length >= 0.9 ? hit : 0;
  }).key;
  const keyLike = pat => bestKeyBy(a, k => (pat.test(k) ? 1 : 0)).key;
  const atkKey = keyLike(/atk|attack/i), hpKey = keyLike(/^hp$|health/i), defKey = keyLike(/^def|defen/i);
  const effKeys = longTextKeys(a);
  const locKey = keyLike(/loc|source|obtain|drop|where/i);
  const eImgKey = bestKeyBy(a, k =>
    strVals(a, k).filter(v => cur.eImg.some(l => l.endsWith("|" + v.trim()))).length).key
    || bestKeyBy(a, k => (/thumb|img|icon/i.test(k) ? 1 : 0)).key;
  log(`equip fields — type:'${typeKey || "-"}' star:'${starKey || "-"}' atk/hp/def:'${atkKey || "-"}/${hpKey || "-"}/${defKey || "-"}' loc:'${locKey || "-"}' img:'${eImgKey || "-"}'`);
  if (typeKey && starKey) {
    for (const o of a) {
      const name = clean(o[equipSrc.nameKey]);
      if (!name || knownEquipNames.has(name.toLowerCase())) continue;
      knownEquipNames.add(name.toLowerCase());
      const type = EQ_TYPES[String(o[typeKey]).trim().toLowerCase()];
      if (!type) continue;
      const star = +o[starKey] || 1;
      const atk = +(atkKey ? o[atkKey] : 0) || 0, hp = +(hpKey ? o[hpKey] : 0) || 0, def = +(defKey ? o[defKey] : 0) || 0;
      const effect = clean(effKeys.map(k => o[k]).filter(Boolean).join(" — ")) || "—";
      const traits = deriveEquipTraits(effect);
      addEqLines.push(`${name}|${type}|${star}|${atk}|${hp}|${def}|${traits.join(",")}|${effect}`);
      const loc = clean(locKey ? o[locKey] : "") || "Unknown";
      addEqLocLines.push(`${name}|${deriveSrcCategory(loc)}|${loc}`);
      if (eImgKey && o[eImgKey] != null) { addEImgLines.push(`${name}|${String(o[eImgKey]).trim()}`); report.newEImg++; }
      report.newEquips.push(`${name} (${star}★ ${type})`);
    }
  } else warn("equip source lacked identifiable type/star fields — equips not updated this run.");
}

/* --- 6c. tier rebuild --- */
let newTierLines = null;
if (tierSrc) {
  const groups = {};
  if (tierSrc.kind === "grouped") Object.assign(groups, tierSrc.groups);
  else for (const o of tierSrc.arr) {
    const t = String(o[tierSrc.tierKey] ?? "").trim().toUpperCase();
    const n = String(o[tierSrc.nameKey] ?? "").trim();
    if (TIERSET.has(t) && n) (groups[t] ||= []).push(n);
  }
  const lines = [];
  for (const t of TIERS) if (groups[t]?.length) { lines.push("#" + t); groups[t].forEach(n => lines.push(n)); }
  const newCount = lines.filter(l => !l.startsWith("#")).length;
  const oldCount = cur.tierLines.filter(l => !l.startsWith("#")).length;
  if (newCount >= Math.floor(oldCount * 0.8)) {
    newTierLines = lines; report.tierRebuilt = true;
    const oldTier = {}; let ct = "";
    cur.tierLines.forEach(l => l.startsWith("#") ? ct = l.slice(1) : oldTier[l.toLowerCase()] = ct);
    let nt = ""; lines.forEach(l => { if (l.startsWith("#")) nt = l.slice(1);
      else if (oldTier[l.toLowerCase()] && oldTier[l.toLowerCase()] !== nt) report.tierMoved++; });
    log(`tier list rebuilt: ${newCount} entries (was ${oldCount}), ${report.tierMoved} units moved tier`);
  } else warn(`fresh tier data too small (${newCount} vs ${oldCount} entries) — keeping existing tiers.`);
}

/* ---------------- 7. validate + write ---------------- */

const changed = addUnitLines.length || addEqLines.length || (report.tierRebuilt && report.tierMoved > 0)
  || (newTierLines && newTierLines.join("\n") !== cur.tierLines.join("\n"));
if (!changed) { log("no data changes today — index.html left untouched."); process.exit(0); }

for (const l of addUnitLines) {
  const el = l.slice(0, l.indexOf(" "));
  if (!ELSET.has(el.toLowerCase())) fail(`invalid element in new unit line: "${l}"`);
}
if (addUnitLines.length > cur.units.length * 0.3)
  fail(`suspicious: ${addUnitLines.length} "new" units in one day (>30% of roster) — name matching probably broke; aborting.`);
if (addEqLines.length > cur.eq.length * 0.3)
  fail(`suspicious: ${addEqLines.length} "new" equips in one day — aborting.`);

setBlock("unitData", [...cur.units.map(u => `${u.el} ${u.name}`), ...addUnitLines].join("\n"));
setBlock("kitData",  [...cur.kits, ...addKitLines].join("\n"));
setBlock("slotData", [...cur.slots, ...addSlotLines].join("\n"));
setBlock("uImgData", [...cur.uImg, ...addUImgLines].join("\n"));
if (newTierLines) setBlock("tierData", newTierLines.join("\n"));
if (addEqLines.length) {
  setBlock("eqData",    [...cur.eq, ...addEqLines].join("\n"));
  setBlock("eqLocData", [...cur.eqLoc, ...addEqLocLines].join("\n"));
  setBlock("eImgData",  [...cur.eImg, ...addEImgLines].join("\n"));
}
const stamp = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
html = html.replace(/const DATA_UPDATED = "[^"]*";/, `const DATA_UPDATED = "${stamp}";`);
const total = cur.units.length + addUnitLines.length;
html = html.replace(/~\d+ units with real elements/, `~${Math.round(total / 10) * 10} units with real elements`);

if (DRY) log("[dry-run] would write", INDEX);
else fs.writeFileSync(INDEX, html);

log("=== UPDATE SUMMARY ===");
log(`new units:  ${report.newUnits.length}${report.newUnits.length ? "\n  - " + report.newUnits.join("\n  - ") : ""}`);
log(`new equips: ${report.newEquips.length}${report.newEquips.length ? "\n  - " + report.newEquips.join("\n  - ") : ""}`);
log(`tiers: ${report.tierRebuilt ? `rebuilt (${report.tierMoved} moved)` : "unchanged/kept"}`);
log(`data stamp -> ${stamp}`);
