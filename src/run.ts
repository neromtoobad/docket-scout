// One job, end to end.
//
// Scout a builder:
//   Intake (Scout Intent contract with authority) -> Surveyor (live sources;
//   registers the builder's GitHub in Zetaris at run time) -> Profiler (repos
//   + README wins) -> Archivist (H-MEM: wins and results per skill tag;
//   World Model: builder graph) -> Reconciler (one federated query with FX,
//   merge, deadlines, changes since last look) -> Budget quote
//   -> Markovian steps of six hackathons each; the carryover is the week's
//      plan (hours left and picks):
//        Scout (Nemotron Ultra proposes fit, verdict, repo, hours)
//        -> Coach (rules: object once, then overrule; odds and $/hour)
//        -> PlanBook (picks within hours) -> Archivist (World Model fixture)
//   -> Executor (docket + calendar, within the contract) -> Archivist (plan)
// Record a result ("I won X"): Intake -> Archivist (H-MEM outcome) -> Executor (docket)

import { randomUUID } from "node:crypto";
import { Markovian } from "../engines/markovian/src/index.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { MeterlessProvider } from "./adapters/meterless.ts";
import { Brain } from "./brain.ts";
import { config } from "./config.ts";
import { DataDesk } from "./data.ts";
import type { Fixture, Hackathon, Plan, Profile } from "./domain.ts";
import { tagsOf, TAG_LABEL, type Tag } from "./skills.ts";
import { Archivist } from "./agents/archivist.ts";
import { Budget } from "./agents/budget.ts";
import { eligibility, memoryBoost, odds, PlanBook, playbookFit, review, type Eligibility } from "./agents/coach.ts";
import { Executor, readDocket, type Docket } from "./agents/executor.ts";
import { intake, refresh, type ExecutionContract } from "./agents/intake.ts";
import { profile } from "./agents/profiler.ts";
import { mergeKey, reconcile, type Reconciled } from "./agents/reconciler.ts";
import { playbook, propose, type Proposal } from "./agents/scout.ts";
import { survey, type Survey } from "./agents/surveyor.ts";
import { Trace } from "./trace.ts";

export interface RunInput {
  run_id?: string;
  input: { query: string; github?: string; hours?: number };
  options?: { sample_mode?: boolean };
}

export interface RunOutput {
  run_id: string;
  status: "success" | "declined" | "error";
  output: {
    summary: string;
    builder?: Profile & { record: { tag: string; won: number; placed: number; lost: number }[] };
    fixtures: Fixture[];
    plan?: Plan;
    note: string;
    log: { kind: string; text: string }[];
    sources?: Survey["sources"];
    docket?: Docket;
    recommendations: string[];
    artifacts: { type: string; path: string }[];
    clarification?: { question: string; options: string[] };
  };
  agents: { name: string; role: string }[];
  contract?: Pick<ExecutionContract, "contractId" | "intent" | "risk" | "toolPlan" | "expiresAt" | "registryVersion"> & { authority: ExecutionContract["scope"]["authority"]; lineage: string[] };
  memory: { recalled: number; stored: number };
  engines: Record<string, string>;
  cost: Record<string, unknown>;
  data_sources: Record<string, number>;
  trace_id: string;
  log_file: string;
  execution_time_seconds: number;
  error?: { type: string; message: string; recoverable: boolean };
}

export const AGENTS = [
  { name: "Intake", role: "Scout Intent: binds the builder and their hours, guards the request, signs the contract that fixes the scout's authority" },
  { name: "Surveyor", role: "Takes stock of the live sources in Zetaris and registers a new builder's GitHub as Zetaris tables at run time" },
  { name: "Profiler", role: "Builds the scouting card from the builder's repos and the wins table on their profile README" },
  { name: "Reconciler", role: "One federated query over every platform plus FX; merges duplicates, parses deadlines, spots changes" },
  { name: "Archivist", role: "H-MEM record of wins, results and plans per skill tag; World Model case file of builder, repos and fixtures" },
  { name: "Scout", role: "Proposes fit, verdict, head-start repo and hours for each hackathon on Nemotron Ultra" },
  { name: "Coach", role: "Holds every proposal to the eligibility rules, computes the odds and $/hour, keeps the plan within the hours" },
  { name: "Executor", role: "Writes the docket shortlist and a deadline calendar; never registers, submits or messages" },
];

export const STEP_SIZE = 6;
export const MAX_SCORED = 24;
export const MIN_EV_PER_HOUR = 25;

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString("en-US")}`);
const ORDER = { START: 0, BENCH: 1, OUT: 2 } as const;

export async function runJob(req: RunInput, hooks: { onTrace?: (t: Trace) => void; quiet?: boolean } = {}): Promise<RunOutput> {
  const runId = (req.run_id || `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`).replace(/[^A-Za-z0-9_-]/g, "");
  const started = Date.now();
  const trace = new Trace(runId, "logs", hooks.quiet);
  hooks.onTrace?.(trace);
  const sample = req.options?.sample_mode ?? config.sampleMode;
  const budget = new Budget(trace);
  const brain = new Brain(trace, budget, sample ? new MeterlessProvider({ token: "" }) : undefined);
  const zetaris = new ZetarisClient(undefined, sample);

  const base = (status: RunOutput["status"], extra: Omit<Partial<RunOutput>, "output"> & { output?: Partial<RunOutput["output"]> }): RunOutput => ({
    run_id: runId, status, agents: AGENTS, memory: { recalled: 0, stored: 0 },
    engines: { scout_intent: "contract issued", hmem: "-", world_model: "-", markovian: "-" },
    cost: budget.statement(), data_sources: {}, trace_id: runId, log_file: trace.file,
    execution_time_seconds: +((Date.now() - started) / 1000).toFixed(1),
    ...extra,
    output: { summary: "", fixtures: [], note: "", log: [], recommendations: [], artifacts: [{ type: "trace", path: trace.file }], ...extra.output },
  });

  trace.log({
    agent_name: "System", action: "start_run", status: "info", input_summary: req.input.query.slice(0, 200),
    output_summary: `provider ${brain.online ? `Meterless Nightshift (${brain.provider.baseUrl})` : "none: scout playbook"}; data ${zetaris.mode === "live" ? "Zetaris live (Devpost, Devfolio, FX, GitHub)" : "recorded Zetaris results + local mirror"}`,
  });

  try {
    const { contract: issued, clarification } = await intake(req.input.query, trace, brain, runId, { login: req.input.github, hours: req.input.hours });
    let contract = issued;
    const lineage = [contract.contractId];
    const r = contract.intent.parameters;
    const contractView = () => ({ contractId: contract.contractId, intent: contract.intent, risk: contract.risk, toolPlan: contract.toolPlan, expiresAt: contract.expiresAt, registryVersion: contract.registryVersion, authority: contract.scope.authority, lineage });
    if (r.route === "decline") return base("declined", { output: { summary: `Declined at intake: ${contract.risk.reason}.` }, contract: contractView() });
    if (r.route === "clarify") return base("declined", { output: { summary: clarification?.question ?? "Need more detail.", clarification }, contract: contractView() });

    const archivist = new Archivist(trace, runId);
    const executor = new Executor(trace, () => contract);

    // ------------------------------------------------ record a result
    if (r.intent === "record_result" && r.result) {
      const login = (r.login ?? req.input.github ?? "").toLowerCase();
      if (!login) return base("declined", { output: { summary: "Whose result is this? Add the GitHub username.", clarification: { question: "Whose result?", options: ["@<username> I won <hackathon>"] } }, contract: contractView() });
      const d = readDocket(login);
      const entry = d.entries.find((e) => mergeKey(e.name) === mergeKey(r.result!.hackathon) || e.name.toLowerCase().includes(r.result!.hackathon.toLowerCase()));
      const tags = tagsOf(entry?.name ?? r.result.hackathon).filter((t) => t !== "fullstack");
      archivist.rememberResult(login, entry?.name ?? r.result.hackathon, r.result.outcome, tags, [entry?.key ?? "reported"]);
      executor.recordResult(login, entry?.name ?? r.result.hackathon, entry?.key ?? null, r.result.outcome);
      const priors = archivist.priors(login);
      return base("success", {
        output: { summary: `Recorded: ${r.result.outcome} at ${entry?.name ?? r.result.hackathon}. ${tags.length ? `The scout now weighs ${tags.map((t) => TAG_LABEL[t as Tag]).join(", ")} briefs by it.` : "No skill tags matched; stored for the record."}`, docket: readDocket(login), log: [{ kind: "memory", text: `H-MEM record: ${[...priors.byTag.values()].map((x) => `${x.tag} ${x.won}W/${x.placed}P/${x.lost}L`).join(", ")}` }] },
        contract: contractView(), memory: { recalled: priors.memories.length, stored: 1 },
        engines: { scout_intent: `contract ${lineage[0].slice(0, 8)}`, hmem: "1 result stored", world_model: "-", markovian: "-" },
      });
    }

    // ------------------------------------------------ scout a builder
    const login = r.login!;
    const data = new DataDesk(zetaris, trace, budget, () => contract);
    const sv = await survey(login, data, zetaris, trace, () => contract);
    if (sv.builder.status === "missing") {
      return base("error", { output: { summary: `Could not read GitHub user ${login}${zetaris.mode === "live" ? "" : " (SAMPLE_MODE knows only the snapshotted builders in data/sources/github)"}.` }, contract: contractView(), error: { type: "BuilderNotFound", message: `no public repos for ${login}`, recoverable: true } });
    }
    const prof = await profile(login, data, brain, trace);
    const storedWins = archivist.rememberWins(prof.login, prof.wins, prof.evidence);
    await archivist.putBuilder(prof);
    const priors = archivist.priors(prof.login);
    const rec: Reconciled = await reconcile(data, trace);

    // Eligibility first (cheap, deterministic); the model only sees hackathons that could be entered.
    const els = new Map<string, Eligibility>(rec.hackathons.map((h) => [h.key, eligibility(h, r, prof)]));
    const scoreFirst = (h: Hackathon) => playbook(h, prof, els.get(h.key)!).fit * Math.log10(10 + h.prizeUsd);
    const eligible = rec.hackathons.filter((h) => !els.get(h.key)!.out).sort((a, b) => scoreFirst(b) - scoreFirst(a));
    const scored = eligible.slice(0, MAX_SCORED);
    budget.quoteJob(r, scored.length, STEP_SIZE);

    const fixtures: Fixture[] = [];
    const plan = new PlanBook(r.hours);
    const finish = (h: Hackathon, p: Proposal, coach: string[]): Fixture => {
      const el = els.get(h.key)!;
      const mem = memoryBoost(h, priors);
      let verdict = el.out ? "OUT" : p.verdict === "START" && el.cap === "BENCH" ? "BENCH" : p.verdict;
      // Model fit, steadied by the rules-based fit (and explained when they disagree).
      const ruleFit = playbookFit(h, prof);
      const fit = p.by === "model" ? Math.round(p.fit * 0.65 + ruleFit * 0.35) : p.fit;
      if (p.by === "model" && Math.abs(p.fit - ruleFit) >= 25) coach = [...coach, `Model fit ${p.fit} vs rules ${ruleFit}: blended to ${fit}.`];
      if (verdict === "OUT" && !el.out && fit >= 50) {
        verdict = "BENCH";
        coach = [...coach, "Kept on the bench: no rule rules it out."];
      }
      const { pWin, evPerHour } = odds(h, fit, p.hours, mem.boost);
      if (verdict === "START" && evPerHour < MIN_EV_PER_HOUR) {
        verdict = "BENCH";
        coach = [...coach, `Benched: about $${evPerHour}/h expected, under the $${MIN_EV_PER_HOUR}/h floor.`];
      }
      return { hackathon: h, fit, verdict, repo: p.repo, why: p.why, hours: p.hours, pWin, evPerHour, by: p.by, model: p.model, coach, memory: mem.notes };
    };

    const chunks: Hackathon[][] = [];
    for (let i = 0; i < scored.length; i += STEP_SIZE) chunks.push(scored.slice(i, i + STEP_SIZE));
    let disputes = 0;
    let overrules = 0;
    const markov = new Markovian({ chunkConfig: { chunkSize: 2000, maxChunks: Math.max(1, chunks.length), carryoverTokens: 256 } });
    const run = await markov.run({
      goal: r.text, mode: "ARCHITECT", reflect: false,
      stepFn: async ({ step, carryover }) => {
        const batch = chunks[step];
        if (!batch) return { content: "[TASK_COMPLETE]" };
        contract = refresh(contract);
        lineage.push(contract.contractId);
        if (!budget.approve("rounds", "System")) return { content: "Budget exhausted.\n[TASK_COMPLETE]" };
        trace.log({
          agent_name: "System", action: "step_start", status: "info", target_agent: "Scout",
          input_summary: `Markovian step ${step + 1}/${chunks.length}; carryover ${carryover.length} chars`,
          output_summary: `${batch.map((h) => h.name).join(", ")}${carryover ? `; carried: ${carryover.slice(0, 200)}` : ""}`,
          data: { engine: "Markovian", step: step + 1, keys: batch.map((h) => h.key), carryover },
        });
        const items = batch.map((h) => ({ h, el: els.get(h.key)! }));
        let props = await propose(items, prof, priors, brain, plan.carryover());
        // Coach: object once, then overrule.
        const objections = new Map<string, string>();
        for (const p of props) {
          const h = batch.find((x) => x.key === p.key)!;
          const o = review(p, h, els.get(h.key)!, prof);
          if (o.length) objections.set(p.key, o.join(" "));
        }
        const coachNotes = new Map<string, string[]>();
        if (objections.size && props.some((p) => p.by === "model")) {
          disputes += objections.size;
          trace.log({ agent_name: "Coach", action: "object", target_agent: "Scout", status: "needs_revision", input_summary: `${objections.size} proposal(s) break a rule`, output_summary: [...objections.values()].join(" ").slice(0, 300) });
          const again = await propose(items.filter((i) => objections.has(i.h.key)), prof, priors, brain, plan.carryover(), objections);
          for (const a of again) {
            const h = batch.find((x) => x.key === a.key)!;
            const still = review(a, h, els.get(h.key)!, prof);
            if (still.length) {
              overrules++;
              const pb = playbook(h, prof, els.get(h.key)!);
              props = props.map((p) => (p.key === a.key ? { ...pb, why: `${pb.why}`, by: a.by, model: a.model } : p));
              coachNotes.set(a.key, [`Overruled: ${still[0]}`]);
            } else {
              props = props.map((p) => (p.key === a.key ? a : p));
              coachNotes.set(a.key, [`Revised after the Coach objected: ${objections.get(a.key)}`]);
            }
          }
        } else if (objections.size) {
          for (const [k, o] of objections) coachNotes.set(k, [`Adjusted to the rules: ${o}`]);
        }
        for (const p of props) {
          const h = batch.find((x) => x.key === p.key)!;
          const f = finish(h, p, [...(coachNotes.get(p.key) ?? []), ...els.get(h.key)!.notes.map((n) => `Note: ${n}`)]);
          const { taken, bumped } = plan.consider(f);
          if (f.verdict === "START" && !taken) {
            f.verdict = "BENCH";
            f.coach.push(`Benched: not enough hours left this week (${plan.hours - plan.used}h free, needs ${f.hours}h).`);
          }
          for (const b of bumped) {
            b.verdict = "BENCH";
            b.coach.push(`Benched for ${h.name}, which pays more per hour.`);
          }
          fixtures.push(f);
          await archivist.putFixture(prof.login, f);
        }
        trace.log({
          agent_name: "Coach", action: "step_plan", status: "success", target_agent: "Scout",
          input_summary: `step ${step + 1}: ${props.length} proposals (${props.filter((p) => p.by === "model").length} from the model)`,
          output_summary: plan.carryover(),
          data: { fixtures: props.map((p) => ({ key: p.key, verdict: fixtures.find((f) => f.hackathon.key === p.key)?.verdict, fit: p.fit })) },
        });
        const last = step + 1 >= chunks.length;
        return { content: `Step ${step + 1} done.\n<CARRYOVER>${plan.carryover()}</CARRYOVER>${last ? "\n[TASK_COMPLETE]" : ""}` };
      },
    });

    // Spare hours: the Coach promotes the best bench fixtures that clear the floor.
    for (const f of [...fixtures].filter((x) => x.verdict === "BENCH" && x.fit >= 60 && x.evPerHour >= MIN_EV_PER_HOUR && !els.get(x.hackathon.key)!.cap).sort((a, b) => b.evPerHour - a.evPerHour)) {
      if (plan.used + f.hours > plan.hours) continue;
      f.verdict = "START";
      plan.consider(f);
      f.coach.push(`Promoted from the bench to use spare hours (${plan.hours - plan.used + f.hours}h were free).`);
      trace.log({ agent_name: "Coach", action: "promote", status: "success", input_summary: f.hackathon.name, output_summary: `bench → START at $${f.evPerHour}/h, ${f.hours}h; ${plan.carryover()}` });
    }

    // Everything not scored by the model: OUT by rule, or below the cut (playbook).
    for (const h of rec.hackathons.filter((x) => !scored.includes(x))) {
      const el = els.get(h.key)!;
      const p = playbook(h, prof, el);
      const f = finish(h, el.out ? p : { ...p, verdict: p.verdict === "START" ? "BENCH" : p.verdict }, el.out ? [`Out by rule: ${el.out}.`] : ["Below the cut for this week: scored by the playbook only."]);
      fixtures.push(f);
    }
    fixtures.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.evPerHour - a.evPerHour || b.fit - a.fit);

    const planOut: Plan = { hours: plan.hours, used: plan.used, picks: plan.picks.map((f) => f.hackathon.key), expectedUsd: Math.round(plan.picks.reduce((a, f) => a + f.hackathon.prizeUsd * 0.3 * f.pWin, 0)) };
    const { docket, calendarPath } = executor.apply(prof.login, planOut, fixtures);
    archivist.rememberPlan(prof.login, plan.picks);

    // Scout's note: the one thing worth saying out loud.
    const biggest = [...fixtures].sort((a, b) => b.hackathon.prizeUsd - a.hackathon.prizeUsd)[0];
    const best = plan.picks[0];
    let note = best
      ? `${best.hackathon.name} is the best use of your time at about $${best.evPerHour}/h${best.repo ? `, starting from ${best.repo}` : ""}.${biggest && biggest !== best ? ` ${biggest.hackathon.name} has the biggest prize (${usd(biggest.hackathon.prizeUsd)}) but ${biggest.verdict === "OUT" ? biggest.why.replace(/^Out: /, "").replace(/\.$/, "") : `works out at $${biggest.evPerHour}/h for you`}.` : ""}`
      : "Nothing fits this week well enough to start. The bench is worth watching.";
    if (plan.picks.length > 1) note += ` Together the plan uses ${plan.used} of your ${plan.hours} hours.`;

    const log: RunOutput["output"]["log"] = [
      ...rec.changes.filter((c) => c.kind !== "new").map((c) => ({ kind: c.kind, text: `${c.name}: ${c.detail}` })),
      ...rec.merged.slice(0, 4).map((m) => ({ kind: "merged", text: `${m.name} listed on ${[...new Set(m.sources)].join(" and ")}: merged into one fixture` })),
      ...rec.converted.slice(0, 3).map((c) => ({ kind: "fx", text: `${c.name}: ${c.from} → ${usd(c.usd)} at today's rate` })),
      ...(rec.changes.filter((c) => c.kind === "new").length ? [{ kind: "new", text: `${rec.changes.filter((c) => c.kind === "new").length} new since the last scout` }] : []),
      { kind: "source", text: `${sv.builder.status === "registered" ? "Registered" : sv.builder.status === "refreshed" ? "Re-read" : "Loaded"} ${prof.login}'s GitHub in Zetaris: ${prof.repos.length} repos, ${prof.wins.length} wins on the README` },
      ...fixtures.filter((f) => f.verdict === "OUT" && f.hackathon.prizeUsd >= 20000).slice(0, 2).map((f) => ({ kind: "skip", text: `Skipped ${f.hackathon.name} (${usd(f.hackathon.prizeUsd)}): ${f.why.replace(/^Out: /, "")}` })),
    ];

    trace.log({
      agent_name: "System", action: "finish_run", status: "success",
      input_summary: `${run.chunks.length} Markovian steps (${run.status})`,
      output_summary: `${fixtures.length} fixtures: ${fixtures.filter((f) => f.verdict === "START").length} START, ${fixtures.filter((f) => f.verdict === "BENCH").length} BENCH, ${fixtures.filter((f) => f.verdict === "OUT").length} OUT; plan ${plan.used}/${plan.hours}h; ${disputes} objections, ${overrules} overrules; World Model events ${archivist.events()}`,
    });

    const startCount = plan.picks.length;
    return base("success", {
      output: {
        summary: `${prof.login}: ${rec.hackathons.length} live hackathons across ${new Set(sv.sources.map((s) => s.source)).size} platforms. ${startCount ? `Enter ${startCount} this week (${plan.used}h of ${plan.hours}h): ${plan.picks.map((f) => `${f.hackathon.name} ($${f.evPerHour}/h)`).join(", ")}.` : "Nothing to start this week."} ${fixtures.filter((f) => f.verdict === "BENCH").length} on the bench, ${fixtures.filter((f) => f.verdict === "OUT").length} out.`,
        builder: { ...prof, record: [...priors.byTag.values()] },
        fixtures, plan: planOut, note, log, sources: sv.sources, docket,
        recommendations: plan.picks.map((f) => `Register yourself at ${f.hackathon.sources[0]?.url} before ${f.hackathon.closes ?? "the deadline"}${f.repo ? ` and start from ${f.repo}` : ""}.`),
        artifacts: [{ type: "trace", path: trace.file }, ...(calendarPath ? [{ type: "calendar", path: calendarPath }] : [])],
      },
      contract: contractView(),
      memory: { recalled: priors.memories.length, stored: storedWins + (plan.picks.length ? 1 : 0) },
      engines: {
        scout_intent: `contract ${lineage[0].slice(0, 8)} refreshed ${lineage.length - 1}x`,
        hmem: `${priors.memories.length} recalled, ${storedWins} wins stored${plan.picks.length ? ", plan stored" : ""}`,
        world_model: `${archivist.events()} case-file events`,
        markovian: `${run.chunks.length} bounded steps (${run.status})${run.totalTokensSaved > 0 ? `, ~${run.totalTokensSaved} tokens saved (estimated)` : ""}`,
      },
      cost: budget.statement(), data_sources: sourceCounts(data),
    });
  } catch (e) {
    const err = e as Error;
    trace.log({ agent_name: "System", action: "run_failed", status: "error", input_summary: req.input.query.slice(0, 120), output_summary: err.message.slice(0, 300) });
    return base("error", { output: { summary: `The scout hit an error: ${err.message.slice(0, 200)}` }, error: { type: err.name || "Error", message: err.message.slice(0, 400), recoverable: true } });
  }
}

function sourceCounts(data: DataDesk): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of data.results.values()) out[r.source] = (out[r.source] ?? 0) + 1;
  return out;
}
