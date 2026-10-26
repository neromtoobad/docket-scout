// Archivist: the scout's memory and its shared case file.
//
// - Meterless H-MEM: every win found on a builder's profile, every result the
//   builder reports back ("I won X", "didn't place at Y") and every plan the
//   scout made, stored with provenance. Before scoring, the scout recalls
//   the builder's record per skill tag, so a tag they keep winning in lifts
//   the odds and a tag they keep losing in lowers them.
// - Meterless World Model: the live case file for a run. The builder, their
//   repos, the skills those show, each hackathon, and every fixture the scout
//   called, each `evidenced_by` the Zetaris queries behind it, written by
//   several agents through the single-writer queue.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HMEM } from "../../engines/hmem/src/index.ts";
import { WorldModel, type WorldEvent } from "../../engines/world-model/src/index.ts";
import { config } from "../config.ts";
import type { Fixture, Hackathon, Profile, Win } from "../domain.ts";
import type { Trace } from "../trace.ts";

let hmemSingleton: HMEM | null = null;
let worldSingleton: WorldModel | null = null;

export function scoutMemory(dir = join(config.dataDir, "hmem")): HMEM {
  if (!hmemSingleton) {
    mkdirSync(dir, { recursive: true });
    hmemSingleton = new HMEM({ persistDir: dir, actor: "scout-archivist" });
  }
  return hmemSingleton;
}

export function caseFile(dir = config.dataDir): WorldModel {
  if (!worldSingleton) {
    mkdirSync(dir, { recursive: true });
    worldSingleton = new WorldModel({ namespace: "scout", storage: "local", directory: dir, conflictPolicy: "most-recent-wins" });
  }
  return worldSingleton;
}

export function wipeArchives(dir = config.dataDir): void {
  rmSync(join(dir, "hmem"), { recursive: true, force: true });
  rmSync(join(dir, ".world"), { recursive: true, force: true });
  hmemSingleton = null;
  worldSingleton = null;
}

export function resetArchives(): void {
  hmemSingleton = new HMEM({ actor: "scout-archivist" });
  worldSingleton = new WorldModel({ namespace: "scout", storage: "memory", conflictPolicy: "most-recent-wins" });
}

export interface TagRecord { tag: string; won: number; placed: number; lost: number }
export interface Priors { byTag: Map<string, TagRecord>; memories: { id: string; content: string; tags: string[] }[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export class Archivist {
  readonly hmem = scoutMemory();
  readonly world = caseFile();

  constructor(private trace: Trace, private runId: string) {}

  private src(by: string) {
    return { kind: "agent", by, at: new Date(), runId: this.runId };
  }

  private builderMemories(login: string) {
    return this.hmem.query(`${login} hackathon win result plan`, { topN: 200, threshold: 0 }).memories.filter((m) => m.memory.tags?.includes(`builder:${login}`));
  }

  // Wins on the profile README become long-term memories once (idempotent by hackathon).
  rememberWins(login: string, wins: Win[], refs: string[]): number {
    const known = new Set(this.builderMemories(login).filter((m) => m.memory.tags?.includes("won")).map((m) => (m.memory.tags ?? []).find((t) => t.startsWith("h:")) ?? ""));
    let added = 0;
    for (const w of wins) {
      const h = `h:${slug(w.hackathon)}`;
      if (known.has(h)) continue;
      this.hmem.add({
        content: `WIN ${login}: ${w.hackathon} with ${w.project} [${w.tags.join(", ")}]`,
        type: "factual", layer: "long_term", tags: [`builder:${login}`, "won", h, ...w.tags.map((t) => `tag:${t}`)],
        confidence: 0.95, source: `github:${login}/README`,
        provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `profile README of ${login}`, refs },
        missionId: this.runId,
      });
      added++;
    }
    this.trace.log({
      agent_name: "Archivist", action: "store_wins", status: "success",
      input_summary: `${wins.length} wins on ${login}'s profile`,
      output_summary: added ? `${added} new wins written to H-MEM (${wins.length - added} already known)` : `all ${wins.length} wins already in H-MEM`,
      data: { engine: "H-MEM", added },
    });
    return added;
  }

  rememberResult(login: string, hackathon: string, outcome: "won" | "placed" | "lost", tags: string[], refs: string[]): string {
    const rec = this.hmem.add({
      content: `RESULT ${login}: ${outcome.toUpperCase()} at ${hackathon} [${tags.join(", ")}]`,
      type: "factual", layer: "long_term", tags: [`builder:${login}`, outcome, `h:${slug(hackathon)}`, ...tags.map((t) => `tag:${t}`)],
      confidence: 1, source: `scout:${this.runId}`,
      provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `result reported by ${login}`, refs },
      missionId: this.runId,
    });
    this.trace.log({ agent_name: "Archivist", action: "store_result", status: "success", input_summary: `${login}: ${outcome} at ${hackathon}`, output_summary: `H-MEM ${rec.id.slice(0, 8)}: tags ${tags.join(", ") || "none"}; future plans weigh these tags by this result`, data: { engine: "H-MEM", memoryId: rec.id, outcome, tags } });
    return rec.id;
  }

  rememberPlan(login: string, picks: Fixture[]): void {
    if (!picks.length) return;
    this.hmem.add({
      content: `PLAN ${login} ${new Date().toISOString().slice(0, 10)}: ${picks.map((f) => `${f.hackathon.name} (fit ${f.fit}, $${f.evPerHour}/h)`).join("; ")}`,
      type: "factual", layer: "long_term", tags: [`builder:${login}`, "plan", ...picks.map((f) => `h:${slug(f.hackathon.name)}`)],
      confidence: 0.8, source: `scout:${this.runId}`,
      provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `plan in ${this.runId}`, refs: picks.flatMap((f) => f.hackathon.evidence) },
      missionId: this.runId,
    });
  }

  // The builder's record per skill tag, from H-MEM.
  priors(login: string): Priors {
    const mems = this.builderMemories(login);
    const byTag = new Map<string, TagRecord>();
    for (const m of mems) {
      const tags = m.memory.tags ?? [];
      const outcome = tags.includes("won") ? "won" : tags.includes("placed") ? "placed" : tags.includes("lost") ? "lost" : null;
      if (!outcome) continue;
      for (const t of tags.filter((x) => x.startsWith("tag:")).map((x) => x.slice(4))) {
        const r = byTag.get(t) ?? { tag: t, won: 0, placed: 0, lost: 0 };
        r[outcome]++;
        byTag.set(t, r);
      }
    }
    const memories = mems.filter((m) => !(m.memory.tags ?? []).includes("plan")).sort((a, b) => b.memory.timestamp - a.memory.timestamp).map((m) => ({ id: m.memory.id, content: m.memory.content, tags: m.memory.tags ?? [] }));
    this.trace.log({
      agent_name: "Archivist", action: "recall_record", target_agent: "Scout", status: "success",
      input_summary: `H-MEM: ${login}'s wins and results`,
      output_summary: byTag.size ? [...byTag.values()].sort((a, b) => b.won + b.placed - (a.won + a.placed)).slice(0, 6).map((r) => `${r.tag} ${r.won}W/${r.placed}P/${r.lost}L`).join(", ") : "no record yet: odds come from the repos alone",
      data: { engine: "H-MEM", byTag: [...byTag.values()], recalled: memories.length },
    });
    return { byTag, memories };
  }

  // World Model case file
  async putBuilder(p: Profile): Promise<void> {
    const ctx = `scouting:scout:${this.runId}`;
    await this.world.upsertContext({ type: "scouting", externalKey: { system: "scout", id: this.runId }, attrs: { login: p.login }, source: this.src("Intake") });
    await this.world.upsertEntity({ type: "builder", externalKey: { system: "github", id: p.login }, attrs: { repos: p.repos.length, wins: p.wins.length }, source: this.src("Profiler") });
    for (const r of p.repos.slice(0, 20)) {
      await this.world.upsertEntity({ type: "repo", externalKey: { system: "github", id: `${p.login}/${r.name}` }, attrs: { language: r.language, tags: r.tags.join(",") }, source: this.src("Profiler") });
      await this.world.relate({ from: `builder:github:${p.login}`, type: "built", to: `repo:github:${p.login}/${r.name}`, context: ctx, source: this.src("Profiler") });
    }
    for (const [tag, v] of p.skills.filter(([, v]) => v > 10)) {
      await this.world.assertFact({ about: `builder:github:${p.login}`, predicate: `skill:${tag}`, value: v, confidence: 0.8, context: ctx, source: this.src("Profiler") });
    }
  }

  async putFixture(login: string, f: Fixture): Promise<void> {
    const ctx = `scouting:scout:${this.runId}`;
    const h: Hackathon = f.hackathon;
    await this.world.upsertEntity({ type: "hackathon", externalKey: { system: "scout", id: h.key }, attrs: { name: h.name, prizeUsd: h.prizeUsd, closes: h.closes ?? "", sources: h.sources.map((s) => s.source).join("+") }, source: this.src("Reconciler") });
    await this.world.relate({ from: `builder:github:${login}`, type: `fixture:${f.verdict}`, to: `hackathon:scout:${h.key}`, context: ctx, source: this.src("Coach") });
    if (f.repo) await this.world.relate({ from: `repo:github:${login}/${f.repo}`, type: "head_start_for", to: `hackathon:scout:${h.key}`, context: ctx, source: this.src("Scout") });
    for (const q of h.evidence) {
      await this.world.upsertEntity({ type: "query", externalKey: { system: "zetaris", id: q }, source: this.src("Reconciler") });
      await this.world.relate({ from: `hackathon:scout:${h.key}`, type: "evidenced_by", to: `query:zetaris:${q}`, context: ctx, source: this.src("Reconciler") });
    }
  }

  events(): number {
    return this.world.events().length;
  }

  onCaseEvent(fn: (e: WorldEvent) => void): () => void {
    return this.world.subscribeEvents(fn);
  }
}
