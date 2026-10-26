# Docket Scout: a scouting report for every builder

**Open Agent Hackathon 2026 · Wildcard [Tinkerer]: Bring Your Own Project**

**Demo video (1:44):** https://youtu.be/W6-gIdMzWU8 · **Deck:** https://scout.nerom.site/slidedeck

There are hundreds of hackathons open at any moment, spread across platforms that don't talk to each other. Each platform has its own date format, prizes come in dollars, rupees and euros, and the same event can be listed twice. Builders find them through X threads and spreadsheets, and pick by prize size, which is the wrong number.

**Docket Scout is an AI scout.** Give it any GitHub username and the hours you have this week.
1. It reads every live hackathon on **Devpost and Devfolio through Zetaris**, with today's FX rates, as one list.
2. It reads **your public GitHub through Zetaris**: your repos and the wins table on your profile README. It registers them as new Zetaris sources at run time.
3. It writes a scouting report.
   - **START / BENCH / OUT** for each hackathon, with a fit rating and the repo that gives you a head start.
   - **Expected dollars per build hour**, not the headline prize.
   - A plan that fits the hours you actually have.
4. It **learns from your results**. Tell it "I won X" or "didn't place at Y", and Meterless H-MEM weighs that skill next time.

Everything it reads is real and live. Nothing is simulated.

| | |
|---|---|
| **Fragmented sources** | Devpost (open and upcoming, public JSON), Devfolio (public search API, a POST), open.er-api.com (FX), the builder's GitHub (repos + README), all registered as Zetaris Lightning REST tables |
| **One federated query** | Every platform's hackathons joined to the FX table, so ₹500,000 is compared as $5,254 and €50,000 as $56,046 |
| **Reasoning** | NVIDIA Nemotron 3 Ultra (via Meterless Nightshift) proposes fit, verdict, head-start repo and hours. A deterministic Coach holds it to the rules: it objects once, then overrules |
| **Memory** | Meterless H-MEM stores wins, reported results and plans per skill tag, with provenance |
| **Action** | Writes the builder's docket and a deadline calendar, under a Scout Intent contract that **never registers, submits or messages anyone** |

## Wildcard: what existed, what is new

**Existing project: Hack Docket**, my hackathon tracker (built Oct 4–8, before this hackathon).
- It's a single page where I tick hackathons through "todo → building → submitted".
- Its list was **hand-curated**: I seeded it from X threads and platform pages and added events one link at a time.
- It ranked fit against a strengths list I typed in myself.
- A public friends' copy is at hackdocket.vercel.app.

**New in this hackathon window (everything in this repository):**
- **Discovery across fragmented platforms through Zetaris.** Five live REST sources and one federated `scout.hackathons` view, with FX conversion in SQL. The Surveyor also registers each new builder's GitHub at run time.
- **Reading the builder instead of asking them.** Skills come from their repos; the trophy cabinet comes from their README.
- **The agent pipeline:** Scout Intent intake, Surveyor, Profiler, Reconciler, Scout (Nemotron Ultra), Coach, Executor, Archivist, with Markovian bounded steps.
- **The odds model and the hours plan.**
- **H-MEM learning from results**, and the World Model case file.
- **The scouting-report UI, the HTTP API, SAMPLE_MODE, Docker, and the 15 feature tests.**

Plumbing patterns (the Zetaris REST adapter, the Nightshift provider, the trace, the budget meter and the contract signing) are adapted from my Causa and Terms entries, built earlier in this same window. See [Pre-existing components](#pre-existing-components-declared).

## Quick start

### 1. No credentials at all (judges start here)

```bash
docker build -t docket-scout .
docker run --rm -p 8030:8030 -e SAMPLE_MODE=true docket-scout
# open http://localhost:8030, or:
curl -X POST http://localhost:8030/run -H "Content-Type: application/json" -d @input_examples/example_1.json
```

`SAMPLE_MODE=true` runs the **real agent logic** with no keys.
- Zetaris answers come from recorded live results (`data/cache/`), or from a local DuckDB mirror built from snapshots of the same live endpoints (`data/sources/`, built by the same view definitions).
- Scoring uses the scout's deterministic playbook instead of Nemotron.
- Sample mode knows the snapshotted builders `neromtoobad` and `karpathy`. Live mode scouts anyone.

Without Docker: `npm ci && SAMPLE_MODE=true npm start`. Tests: `npm test`.

### 2. Full stack (Zetaris + Meterless Nightshift + Nemotron)

```bash
cp .env.example .env                       # METERLESS_RUNTIME_TOKEN, ZETARIS_API_KEY
npm ci && npm run build && npm start      # http://localhost:8030
npx tsx --env-file=.env scripts/zetaris-setup.ts              # once: live sources + views in Zetaris
npx tsx --env-file=.env scripts/zetaris-setup.ts --refresh    # re-fetch the platforms (UNCACHE + CACHE)
npx tsx --env-file=.env scripts/scout.ts "scout github.com/<you>, 30 hours"
```

| Need | What | Where it goes |
|---|---|---|
| Data | Zetaris running locally in Docker (`localhost:8888`) | API key from the Zetaris UI → `ZETARIS_API_KEY` |
| Power | Meterless **Nightshift** (`127.0.0.1:8088`) | Runtime token from Nightshift → Console → `METERLESS_RUNTIME_TOKEN`. The NVIDIA key lives in Nightshift's Providers tab, never in this app |
| Models | Nemotron lanes via Nightshift | `METERLESS_MODEL_DEEP=nvidia/nemotron-3-ultra-550b-a55b`, `METERLESS_MODEL_FAST=nvidia/nemotron-3.5-lightning-30b-a3b` |

## API

| Endpoint | What it does |
|---|---|
| `POST /run` `{"input":{"query":"…","github?":"…","hours?":38}}` | Runs one job and returns JSON: profile, fixtures, plan, log, contract, engines, cost, trace file |
| `POST /api/jobs` | Starts a job; `GET /api/jobs/:id/events` streams the trace (SSE) |
| `POST /api/results` `{"github","hackathon","outcome":"won"\|"placed"\|"lost"}` | The builder reports a result; H-MEM learns |
| `GET /api/docket/:login` · `/api/docket/:login/calendar` | The builder's shortlist, and its deadlines as `.ics` |
| `GET /api/evidence/:queryId` | The exact Zetaris SQL and rows behind a number |
| `GET /api/memory/:login` · `/api/health` · `/api/latest/:login` | Memory, provider and data status, the last report |

Example requests are in `input_examples/`. Outputs 1–4 were recorded live (Zetaris + Nemotron); output 5 is a reported result in sample mode, so no made-up win is written into real memory. Every run writes `logs/trace-<run_id>.jsonl`, with one line per agent action: timestamp, agent, action, input and output summary, target agent, confidence, retry count, status and model.

## How a scouting run works

```
Intake ── Meterless Scout Intent: Sense → Interpret (GitHub login, hours, online-only) → Guard → Route → signed ExecutionContract
   │        (authority: shortlist + calendar only; registers=false, submits=false, messages=false)
   ▼
Surveyor ── inventory of scout.hackathons by platform; registers the builder's GitHub repos + README
   │         as new Zetaris REST tables (or re-fetches a known builder), CACHE TABLE, view scout.repos_<login>
   ▼
Profiler ── repos → skill tags (recency- and star-weighted); README wins table → trophy cabinet (Nemotron Lightning tags each win)
   ▼
Archivist ── H-MEM: wins stored once; the builder's record per skill tag recalled. World Model: builder → repos → skills
   ▼
Reconciler ── ONE federated query: scout.hackathons ⋈ scout.fx → prizes in USD; deadlines parsed per platform;
   │           duplicates merged; changes since last look (new, deadline moved, prize changed)
   ▼
Coach (eligibility) ── online only? invite only? hardware the profile never shows? closes today? → OUT before any model call
   ▼  ┌──────────── Meterless Markovian: six hackathons per bounded step; carryover = the week's plan (hours left, picks) ────────────┐
   │  │ Scout (Nemotron 3 Ultra) ── fit, START/BENCH/OUT, head-start repo, hours, one-line reason                                   │
   │  │ Coach ── objects once to any rule break or invented repo, then overrules; blends model fit with the rules' fit;           │
   │  │          odds = fit² × crowd × H-MEM record; $/hour; floor $25/h; PlanBook keeps START within the hours (bumps weaker)    │
   │  │ Archivist ── World Model: fixture builder → hackathon, repo head_start_for hackathon, hackathon evidenced_by query        │
   │  └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▼
Coach ── promotes the best bench fixtures into spare hours
Executor ── docket shortlist + watch list, .ics calendar (contract-checked) ── Archivist ── H-MEM: the plan
```

| Agent | Job | Engine or model |
|---|---|---|
| Intake | Binds builder and hours, guards the request, signs the contract | Scout Intent (+ Nemotron Lightning for binding) |
| Surveyor | Source inventory; registers a builder's GitHub as Zetaris tables at run time | Zetaris |
| Profiler | Skills from repos, wins from the README | Zetaris, Nemotron Lightning |
| Reconciler | One list from many platforms, in dollars, deduplicated, with changes | Zetaris |
| Scout | Fit, verdict, head-start repo, hours, reason | Nemotron 3 Ultra 550B |
| Coach | Eligibility rules, odds, $/hour, the hours plan; objects, overrules | Deterministic |
| Executor | Docket and calendar, within the contract | Scout Intent contract checks |
| Archivist | Wins, results, plans; the case file | H-MEM, World Model |

**Reliability, not vibes**
- **The model never does the maths.**
  - The Coach computes the odds and the dollars per hour.
  - It holds every proposal to the eligibility rules, and an invented repo name is an objection.
  - A proposal that still breaks a rule after one objection is overruled, and the trace says so.
- **Authority can't be talked up.** "Register me for all of them" is declined at intake with zero queries. The Executor has no code path that registers, submits or messages anyone.
- **No number without evidence.** Every fixture carries its Zetaris query ids, and the UI opens the exact SQL and rows.
- **Honest model output.** A profile summary whose numbers don't match the profile (wrong win count, wrong repo count) is rejected for the rules' summary.
- **Fallbacks, all traced.**
  - Data: live Zetaris, then recorded results, then the DuckDB mirror.
  - Models: Nemotron Ultra, then Lightning, then the playbook.

### The odds model (stated, so it can be argued with)

- `pWin = (fit/100)² × crowd × 0.6 × boost`, capped at 0.6.
  - `crowd = 1 / log10(registrations)^1.5`: a 27,000-entrant hackathon is much harder than an 80-entrant one.
  - `boost` comes from the builder's H-MEM record in the hackathon's skill tags: +0.2 per win, +0.08 per placing, −0.12 per loss, clamped to 0.6–2.
- `$/hour = prize_usd × 0.3 × pWin / build_hours`. The 0.3 is the share of a listed prize pool a winning entry typically takes.
- START needs at least $25/h and must fit within the hours.

These are heuristics, not truth. The README and the UI show every input, so the builder can disagree with a specific number.

## Sponsor technology

### Zetaris: the data layer (required)

Zetaris is the only way Docket Scout reaches data. `scripts/zetaris-setup.ts` registers the live platforms; the Surveyor registers builders at run time (`src/sources.ts` has both):
- **Live REST tables in `SCOUT_LIVE`, each `CACHE TABLE`d:**
  - `devpost_open_p1`, `devpost_open_p2` and `devpost_upcoming` (Devpost's public JSON, 40 per page);
  - `devfolio_open` (Devfolio's search API: a **POST** with a JSON body);
  - `fx_usd` (open.er-api.com).
- **SchemaStore views in the `scout` container:**
  - `hackathons`: a UNION ALL that flattens each platform with `LATERAL VIEW explode()`, strips HTML from prizes, detects the currency and parses the amount;
  - `fx`.
- **Run-time sources in `SCOUT_USERS`, per builder:**
  - `gh_<login>_repos` (GitHub REST, a top-level JSON array) and `gh_<login>_readme` (base64 README), both cached;
  - views `scout.repos_<login>` and `scout.readme_<login>`.
  - The scout extends its own data estate when someone new asks to be scouted.
- **The federated join**, `scout.hackathons ⋈ scout.fx`, converts ₹, € and £ prizes to dollars in SQL.

Code: `src/sources.ts`, `src/adapters/zetaris.ts`, `src/data.ts`, `src/agents/surveyor.ts`, `src/agents/reconciler.ts`, `scripts/zetaris-setup.ts`.

### Meterless: all four engines, plus Nightshift (required)

| Engine | Where | What it does here | Test (`npm test`) |
|---|---|---|---|
| **Scout Intent** | `src/agents/intake.ts` | Registry and lexical scoring; Guard against injection, forbidden actions (register, submit, message, bypass bot checks) and claimed organiser authority. The **HMAC-signed ExecutionContract** carries the scout's authority, is verified before every Zetaris query, every source registration and every docket write, and is refreshed per Markovian step with `parentId` lineage | Tamper/expiry/scope refused; "register me" declined with 0 queries; injection blocked |
| **H-MEM** | `src/agents/archivist.ts` | Wins from the README, reported results and plans, with provenance; the record per skill tag changes the odds | A reported win lifts that tag's record |
| **World Model** | `src/agents/archivist.ts` | Case file: builder, repos, skills, hackathons, fixtures (`fixture:START`, `head_start_for`, `evidenced_by` query), written by several agents through the single-writer queue | Case-file events in every run |
| **Markovian** | `src/run.ts` | The scouting in bounded steps of six hackathons; the carryover is the week's plan | A 24-candidate run takes exactly 4 bounded steps |

**Nightshift** is the primary AI provider, built to the Meterless Runtime 0.90.0 contract (`src/adapters/meterless.ts`). The deep lane falls back to the fast lane, and `/api/health` reports the live status. The engine reference implementations are vendored under `engines/` (Apache-2.0, unchanged), and their suites run in `npm test`: **45 tests** in all (15 Docket Scout features + 30 engine).

### NVIDIA: Nemotron through Nightshift
- **Nemotron 3 Ultra 550B** (deep lane) scouts every candidate hackathon against the builder's repos and record.
- **Nemotron 3.5 Lightning 30B** (fast lane) tags each README win, writes the profile summary, and binds a GitHub login the rules missed.

### Coding tool
Built with **Claude Code**. Cursor became optional on Oct 22.

## Layout

```
src/
  run.ts              one job end to end (Markovian loop)
  server.ts           HTTP API + UI
  sources.ts          the data estate: Zetaris DDL, run-time builder DDL, mirror views
  skills.ts           16 skill tags and the rules that map text onto them
  agents/             intake (Scout Intent) · surveyor · profiler · reconciler · scout · coach · executor · archivist · budget
  adapters/           zetaris · meterless (Nightshift) · mirror (DuckDB)
web/src/              the scouting-report UI (React)
scripts/              zetaris-setup · snapshot · scout (CLI) · zsql · provider-status · example5
data/sources/         snapshots of the live endpoints for the offline mirror
data/cache/           recorded live Zetaris results for SAMPLE_MODE
engines/              Meterless reference engines (vendored, unchanged)
```

## AI and model usage
- Nemotron runs only through Meterless Nightshift.
- Every model call is metered against the job's quote, traced with the model that answered, and replaceable by the playbook.
- Replies are JSON; malformed JSON gets one retry with the error.

## Data and licences
- **Devpost**: the public hackathon listing JSON its own site uses (devpost.com/api/hackathons), read-only.
- **Devfolio**: its public hackathon search API, read-only.
- **open.er-api.com**: free FX rates.
- **GitHub**: public user repos and profile READMEs through the REST API (unauthenticated, within its rate limits).
- DoraHacks is not included: it puts automated requests behind a human check, and the scout doesn't get past bot checks.
- **Third-party:** Hono (MIT) · @hono/node-server (MIT) · DuckDB node API (MIT) · React (MIT) · Vite (MIT) · Meterless engines (Apache-2.0) · Barlow, Barlow Condensed, IBM Plex Mono (SIL OFL).

## Limitations (honest)
- **Devfolio coverage is thin.** Its API rarely lists prize amounts, and most of its events are in person in India, so most Devfolio entries end up OUT for an online-only builder.
- **Deadlines are approximate.** Devpost gives a submission period, which the scout reads as its end date; Devfolio gives the event end.
- **The odds are heuristics** (see above), and model verdicts vary run to run. The Coach keeps what's *executed* (the plan) within the rules and the hours.
- **Sample mode knows only the snapshotted builders.** Live mode scouts anyone with public repos.

## Pre-existing components (declared)
- **Hack Docket**, the tracker this extends (Oct 4–8): its idea, its 16 skill tags and its docket statuses. Its code is not reused here.
- **Meterless engine reference implementations** (`engines/`), unchanged, Apache-2.0.
- **Plumbing patterns** (the Zetaris REST adapter, the Nightshift provider, the trace, the budget meter and contract signing), adapted from the author's Causa and Terms entries built in this same hackathon window.
