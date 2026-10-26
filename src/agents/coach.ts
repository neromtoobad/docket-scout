// Coach: the rules the model never gets to bend, and the maths it never gets
// to do. Eligibility (online only, invite only, hardware the builder has
// never shown, closing too soon) is checked deterministically; the odds and
// the expected dollars per hour are computed here from the fit, the crowd and
// the builder's record in H-MEM; and the week's plan is held to the hours the
// builder has. When the Scout's proposal breaks a rule, the Coach objects
// once; if the revised proposal still breaks it, the Coach overrules.

import type { Fixture, Hackathon, Profile, Request, Verdict } from "../domain.ts";
import { TAG_LABEL, type Tag } from "../skills.ts";
import type { Priors } from "./archivist.ts";

export interface Eligibility { out: string | null; cap: Verdict | null; notes: string[] }

export function eligibility(h: Hackathon, req: Pick<Request, "onlineOnly" | "country">, p: Profile): Eligibility {
  const notes: string[] = [];
  if (h.inviteOnly) return { out: "invite only", cap: null, notes };
  if (!h.online) {
    if (req.onlineOnly) return { out: `in person (${h.location || "location not given"}); you asked for online only`, cap: null, notes };
    if (req.country && !h.location.toLowerCase().includes(req.country.toLowerCase())) return { out: `in person in ${h.location}, not in ${req.country}`, cap: null, notes };
  }
  const hw = p.skills.find(([t]) => t === "hardware")?.[1] ?? 0;
  if (h.needs.length && hw < 50) return { out: `needs ${h.needs.join(" and ")}, and nothing on the profile shows it`, cap: null, notes };
  if (h.daysLeft !== null && h.daysLeft < 1) return { out: "closes in under a day", cap: null, notes };
  let cap: Verdict | null = null;
  if (!h.prizeUsd) { cap = "BENCH"; notes.push("no cash prize listed"); }
  if (h.state === "upcoming") notes.push("not open for submissions yet");
  return { out: null, cap, notes };
}

// The builder's repo with the most overlap with what the hackathon wants.
// Generic tags (ml, fullstack, dataviz) count for little: nearly every AI
// repo and every AI hackathon carries them. Shared words in the name and
// description count too ("agentic" brief, "agent" repo).
const GENERIC = new Set(["ml", "fullstack", "dataviz"]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).map((w) => w.replace(/(ic|s|ing)$/, "")).filter((w) => w.length > 3));
const STOPWORDS = new Set(["hackathon", "hack", "build", "with", "your", "that", "this", "from", "2026", "challenge", "powered", "global", "open", "ended", "beginner", "friendly", "machine", "learn"]);

export function bestRepo(h: Hackathon, p: Profile): string | null {
  const hw = new Set([...words(`${h.name} ${h.themes.join(" ")}`)].filter((w) => !STOPWORDS.has(w)));
  let best: { name: string; score: number } | null = null;
  for (const r of p.repos.slice(0, 80)) {
    const overlap = r.tags.filter((t) => h.tags.includes(t)).reduce((a, t) => a + (GENERIC.has(t) ? 0.25 : 1), 0);
    const shared = [...words(`${r.name} ${r.description} ${r.topics.join(" ")}`)].filter((w) => hw.has(w)).length;
    const score = overlap + shared * 0.75;
    if (score < 1) continue;
    const bonus = (Date.now() - Date.parse(r.pushedAt || "2000-01-01") < 120 * 86_400_000 ? 0.3 : 0) + Math.min(0.4, r.stars / 20);
    if (!best || score + bonus > best.score) best = { name: r.name, score: score + bonus };
  }
  return best?.name ?? null;
}

export function playbookFit(h: Hackathon, p: Profile): number {
  const skill = new Map(p.skills);
  const specific = h.tags.filter((t) => !GENERIC.has(t));
  const scores = (specific.length ? specific : h.tags.filter((t) => t !== "fullstack")).map((t) => skill.get(t) ?? 10).sort((a, b) => b - a);
  const base = scores.length ? (scores[0] * 0.65 + (scores[1] ?? scores[0]) * 0.35) - (specific.length ? 0 : 12) : 45; // generic or open-ended briefs: middling
  return Math.max(5, Math.min(97, Math.round(base + (bestRepo(h, p) ? 4 : -6))));
}

export function playbookHours(h: Hackathon, fit: number, repo: string | null): number {
  let hrs = 16 + (repo ? -6 : 4) + (fit < 50 ? 8 : 0);
  if (h.daysLeft !== null) hrs = Math.min(hrs, Math.max(4, h.daysLeft * 8));
  return Math.max(4, Math.round(hrs));
}

// H-MEM record -> a multiplier on the odds for this hackathon's tags.
export function memoryBoost(h: Hackathon, priors: Priors): { boost: number; notes: string[] } {
  let boost = 1;
  const notes: string[] = [];
  for (const t of h.tags) {
    const r = priors.byTag.get(t);
    if (!r) continue;
    const b = 1 + 0.2 * r.won + 0.08 * r.placed - 0.12 * r.lost;
    if (Math.abs(b - 1) > Math.abs(boost - 1)) {
      boost = b;
      notes.splice(0, notes.length, `${TAG_LABEL[t as Tag] ?? t}: ${r.won} won, ${r.placed} placed, ${r.lost} lost`);
    }
  }
  return { boost: Math.max(0.6, Math.min(2, boost)), notes };
}

// Odds and expected value. Heuristics, stated in the README:
//  - fit drives the odds quadratically (a 90 is far more than twice a 45)
//  - a bigger crowd lowers them: 1 / log10(registrations)^1.5
//  - a winning entry takes about 30% of a listed prize pool
export function odds(h: Hackathon, fit: number, hours: number, boost: number): { pWin: number; evPerHour: number } {
  const crowd = 1 / Math.pow(Math.log10(Math.max(30, h.registrations || 300)), 1.5);
  const pWin = Math.min(0.6, Math.pow(fit / 100, 2) * crowd * 0.6 * boost);
  const evPerHour = Math.round((h.prizeUsd * 0.3 * pWin) / Math.max(1, hours));
  return { pWin: +pWin.toFixed(3), evPerHour };
}

// Check a proposed verdict against the rules. Returns objections (empty = fine).
export function review(f: Pick<Fixture, "verdict" | "repo" | "fit">, h: Hackathon, el: Eligibility, p: Profile): string[] {
  const out: string[] = [];
  if (el.out && f.verdict !== "OUT") out.push(`${h.name} must be OUT: ${el.out}.`);
  if (!el.out && el.cap === "BENCH" && f.verdict === "START") out.push(`${h.name} can be BENCH at most: ${el.notes[0]}.`);
  if (f.repo && !p.repos.some((r) => r.name === f.repo)) out.push(`${f.repo} is not one of ${p.login}'s repos.`);
  if (f.fit < 0 || f.fit > 100) out.push("fit must be 0-100.");
  return out;
}

// The week's plan: START fixtures by expected $/hour, within the builder's
// hours. Carried across Markovian steps; a better fixture found later can
// bump a weaker one to the bench.
export class PlanBook {
  picks: Fixture[] = [];
  constructor(readonly hours: number) {}

  get used(): number {
    return this.picks.reduce((a, f) => a + f.hours, 0);
  }

  consider(f: Fixture): { taken: boolean; bumped: Fixture[] } {
    if (f.verdict !== "START") return { taken: false, bumped: [] };
    const bumped: Fixture[] = [];
    const sorted = () => this.picks.sort((a, b) => b.evPerHour - a.evPerHour);
    while (this.used + f.hours > this.hours && this.picks.length) {
      sorted();
      const worst = this.picks[this.picks.length - 1];
      if (worst.evPerHour >= f.evPerHour) break;
      this.picks.pop();
      bumped.push(worst);
    }
    if (this.used + f.hours <= this.hours) {
      this.picks.push(f);
      sorted();
      return { taken: true, bumped };
    }
    this.picks.push(...bumped); // could not fit even after bumping: restore
    sorted();
    return { taken: false, bumped: [] };
  }

  carryover(): string {
    return `${this.hours - this.used}h left of ${this.hours}h; picks: ${this.picks.map((f) => `${f.hackathon.name} ${f.hours}h $${f.evPerHour}/h`).join(", ") || "none yet"}`;
  }
}
