# Automatic daily data updates

This repo updates itself once a day via GitHub Actions.

## How it works
`.github/workflows/update-data.yml` runs daily at 09:17 UTC (and on demand via
**Actions → Daily data update → Run workflow**). It:

1. Clones https://github.com/Reymdusk/GSReact — the open-source repo behind
   grandsummoners.info, the site all our data comes from.
2. Runs `scripts/update-data.mjs`, which auto-discovers the unit / tier /
   equipment data files in that clone (it matches them against the names already
   in our `index.html`, so it survives file renames), then:
   - **appends** any new units (with auto-derived role + traits from their skill
     text), their equip slots and thumbnail ids;
   - **appends** any new equipment (type, rarity, stats, effect, derived trait
     tags, source/location, thumbnail);
   - **rebuilds** the tier list so tier shifts show up automatically;
   - bumps the `DATA_UPDATED` stamp shown in the header.
3. Commits `index.html` only if something actually changed. GitHub Pages then
   redeploys automatically.

## Safety rails
- Append-only: existing units/equips are never removed or overwritten, so
  hand-made ✎ fixes to the shipped data stay intact.
- The tier rebuild is skipped (old tiers kept) if the fresh tier data covers
  less than 80% of the current list.
- Hard abort (no write, red ✗ on the run) if data files can't be found/parsed
  or if an implausible number of "new" entries appears — the live site is never
  degraded by a bad source day.

## First run
Trigger it manually once from the Actions tab and read the log — it prints
which files and fields it identified (e.g. `unit source: src/json/units.json,
nameKey='unitName'`). If it aborts with "could not identify…", the source repo's
layout changed; the log lists every file it parsed, which makes adjusting
`scripts/update-data.mjs` straightforward.

## Notes
- New units arrive untier'd until the source tier list ranks them, and their
  roles/traits are heuristic — one-click fixable in the app via ✎.
- Local testing: `git clone --depth 1 https://github.com/Reymdusk/GSReact /tmp/GSReact`
  then `node scripts/update-data.mjs /tmp/GSReact --dry-run`.
