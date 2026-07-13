# GS-Helper

A team-building and roster companion for **Grand Summoners**. Mark the units and equipment you own, pick a Main Quest chapter or Giant Boss, and get a recommended 4-unit team with per-slot equipment suggestions — and the reasoning behind every pick.

**Live site:** https://quangt0213.github.io/GS-Helper/

---

## What it does

- **Roster** — ~440 units with real elements, tier ratings, roles and skill-derived traits. Click to mark ownership, sort by element / tier / name, and filter as you go.
- **Equipment** — 500+ equips with type, rarity, stats, effects and where to farm them.
- **Team Builder** — pick a fight, get a scored 4-unit team plus equipment picks per slot, with an explanation for each choice.
- **Per-unit overrides** — the ✎ button lets you correct any unit's role, traits, tier, element, True Weapon ownership and equip-slot star caps. Your edits always beat the shipped data.
- **Save / Load** — export your account to `gs-account.json` and reload it anytime.

## How the recommendation engine works

Each owned unit is scored against the selected fight:

| Factor | Weight | Notes |
| --- | --- | --- |
| Element advantage | **+4 / −3** | Fire → Earth → Water → Fire, Light ↔ Dark (+20% dealt / −20% taken) |
| Required counter mechanic | **+5** | e.g. paralysis vs Palamicia, burn vs Aerugraxes' freeze-regen |
| Breaker on a break-only boss | **+6** | e.g. Ragsherum |
| True Weapon owned | **+3** | tag it via ✎ |
| True damage | **+1** | ignores resist / defense |
| Tier | **+3 max** | *capped* — see below |

Two design decisions matter:

1. **Tier is a tiebreak, never a trump card.** Its contribution is capped at +3, below any required mechanic (+5/+6), so a correctly-tagged C-tier Breaker beats an off-kit SS nuker on a break-only boss. Tier lists are *general* ratings; Grand Summoners is *fight-specific*.
2. **Slots are filled by marginal team gain, not raw individual score.** Stacking the counter element compounds elemental buffs/debuffs; a Support whose element matches your damage dealers gets a bonus (element-locked buffs actually land); stacking multiple units weak to the boss is penalized. Arts battery and healer are **soft coverage preferences**, not forced slots — because auto-derived trait tags are imperfect, forcing a "battery" could displace a stronger unit.

Equipment suggestions respect each unit's **per-slot star cap**, so you're never told to slot gear the unit can't hold.

## Stack

Deliberately minimal — no build step, no framework, no backend.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | **Single-file `index.html`** — vanilla HTML/CSS/JS, no dependencies | Loads instantly, trivially forkable, nothing to compile |
| Data | Plain-text blocks embedded in `index.html` as `<script type="text/plain">` | Human-readable, diff-friendly, no fetch/CORS at runtime |
| Persistence | `localStorage` + JSON import/export | No accounts, no server, no tracking |
| Automation | **Node.js** (`scripts/update-data.mjs`) | Zero npm dependencies — stdlib only (`fs`, `path`, `vm`) |
| CI/CD | **GitHub Actions** (`.github/workflows/update-data.yml`) | Daily cron; commits only when data actually changes |
| Hosting | **GitHub Pages** | Static, free, redeploys on push |

### Repo layout

```
GS-Helper/
├── index.html                        # the entire app + embedded data blocks
├── scripts/update-data.mjs           # daily data updater (Node, no deps)
├── .github/workflows/update-data.yml # daily schedule + auto-commit
├── UPDATING.md                       # how the auto-update pipeline works
└── README.md
```

### Embedded data blocks

`index.html` contains eight pipe-delimited data blocks, all editable by hand:

| Block | Format |
| --- | --- |
| `unitData` | `Element Name` |
| `kitData` | `Element\|Role\|Name\|traits,…` |
| `tierData` | `#TIER` headers followed by unit names |
| `slotData` | `Name (Element)\|type[:starCap],…` (e.g. `phys,supp:4,def:3`) |
| `eqData` | `Name\|type\|★\|ATK\|HP\|DEF\|traits\|effect` |
| `eqLocData` | `Name\|source\|where to farm` |
| `uImgData` / `eImgData` | `Name\|imageId` |

## Auto-updating

A GitHub Action runs **daily at 09:17 UTC** (and on demand from the Actions tab). It:

1. Clones the [GSReact](https://github.com/Reymdusk/GSReact) source repo.
2. Auto-discovers the unit / equipment / tier data files by matching them against names already in `index.html` — so it survives file renames and refactors.
3. **Appends** new units (with element, thumbnail, equip slots + star caps, and role/traits derived from skill text) and new equipment; **rebuilds** the tier list.
4. Commits only if something changed. GitHub Pages then redeploys automatically.

**Safety rails:** append-only (existing data and manual fixes are never overwritten); the tier rebuild is skipped if fresh data covers <80% of the current list; and the run hard-aborts without touching `index.html` if data can't be parsed or an implausible number of "new" entries appears. A bad source day can't degrade the live site.

New units arrive **untiered** until the source ranks them, and their roles/traits are **heuristic** — both are one-click fixable via ✎. See [UPDATING.md](UPDATING.md) for details.

### Local development

Open `index.html` in a browser. That's it.

To test the updater against live data:

```bash
git clone --depth 1 https://github.com/Reymdusk/GSReact /tmp/GSReact
node scripts/update-data.mjs /tmp/GSReact --dry-run
```

---

## Credits & sources

This project is a thin, opinionated layer on top of work done by others. It would not exist without them.

- **[grandsummoners.info](https://www.grandsummoners.info/)** — the community database this tool's unit, equipment, tier and image data all originates from. If you find GS-Helper useful, go use their site; it is far more comprehensive.
- **[Reymdusk/GSReact](https://github.com/Reymdusk/GSReact)** — the open-source repository behind grandsummoners.info. Because it's public, this project can sync from it directly and stay current instead of scraping. Thank you for keeping it open.
- **Community Giant Boss guides** — the example comps shown in the Team Builder are proven community line-ups, not generated by this tool.
- Unit and equipment artwork is served from grandsummoners.info's image hosting.

Tier ratings reflect that community tier list; they are opinions, not gospel, and the ✎ button exists precisely so you can disagree.

## Disclaimer

**Grand Summoners** is developed and published by **Good Smile Company** and **NextNinja**. This is an unofficial, non-commercial fan project with no affiliation with, endorsement by, or connection to them, or to grandsummoners.info. All game names, assets, characters and imagery are the property of their respective owners and are used here for informational and identification purposes only.

No ads, no tracking, no accounts, no data leaves your browser.

## Contributing

Data corrections are welcome — the data blocks in `index.html` are plain text and easy to edit. Bear in mind that the daily updater is append-only: it won't overwrite fixes to existing entries, but changes to *derivation logic* (roles, traits, equip star caps) belong in `scripts/update-data.mjs` so they persist for future units too.
