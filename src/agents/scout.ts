// Scout: reads a batch of hackathons against the builder's card and proposes
// a fit, a verdict (START / BENCH / OUT), the repo that gives a head start,
// a build-hours estimate and a one-line reason, on NVIDIA Nemotron 3 Ultra
// through Meterless Nightshift. Without the model, the playbook (the Coach's
// deterministic fit) proposes instead. Either way the Coach checks it.

import type { Brain } from "../brain.ts";
import type { Hackathon, Profile, Verdict } from "../domain.ts";
import { TAG_LABEL, type Tag } from "../skills.ts";
import type { Priors } from "./archivist.ts";
import { bestRepo, playbookFit, playbookHours, type Eligibility } from "./coach.ts";

export interface Proposal { key: string; fit: number; verdict: Verdict; repo: string | null; why: string; hours: number; by: "model" | "playbook"; model?: string }

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

export function playbook(h: Hackathon, p: Profile, el: Eligibility): Proposal {
  const fit = playbookFit(h, p);
  const repo = bestRepo(h, p);
  const hours = playbookHours(h, fit, repo);
  const verdict: Verdict = el.out ? "OUT" : fit >= 68 && h.prizeUsd > 0 && el.cap !== "BENCH" ? "START" : "BENCH";
  const strong = h.tags.filter((t) => (new Map(p.skills).get(t) ?? 0) >= 60).map((t) => TAG_LABEL[t as Tag]);
  const why = el.out ? `Out: ${el.out}.` : strong.length ? `Plays to ${strong.slice(0, 2).join(" and ")}${repo ? `; ${repo} is a head start` : ""}.` : `Little on the profile matches ${h.themes.slice(0, 2).join(", ") || "this brief"}.`;
  return { key: h.key, fit, verdict, repo, why, hours, by: "playbook" };
}

export async function propose(batch: { h: Hackathon; el: Eligibility }[], p: Profile, priors: Priors, brain: Brain, carry: string, feedback?: Map<string, string>): Promise<Proposal[]> {
  const fallback = () => batch.map(({ h, el }) => playbook(h, p, el));
  if (!brain.online) return fallback();
  const record = [...priors.byTag.values()].map((r) => `${r.tag} ${r.won}W/${r.placed}P/${r.lost}L`).join(", ") || "none";
  const repos = p.repos.slice(0, 40).map((r) => `${r.name} [${r.tags.slice(0, 3).join("/")}]: ${r.description.slice(0, 70)}`).join("\n");
  const items = batch.map(({ h, el }) =>
    `- key=${h.key} | ${h.name} | tags: ${h.tags.join(", ") || "none"} | rules-based fit ${playbookFit(h, p)} | ${h.sources.map((s) => s.source).join("+")} | prize ${usd(h.prizeUsd)}${h.prizeText && !h.prizeText.startsWith("$") ? ` (${h.prizeText})` : ""} | closes ${h.closes ?? "?"} (${h.daysLeft ?? "?"} days) | ${h.registrations} registered | ${h.online ? "online" : `in person: ${h.location}`} | themes: ${h.themes.join(", ") || "none"}${el.out ? ` | RULE: must be OUT (${el.out})` : el.cap ? ` | RULE: at most BENCH (${el.notes[0]})` : ""}${feedback?.get(h.key) ? ` | COACH OBJECTED: ${feedback.get(h.key)}` : ""}`
  ).join("\n");
  const res = await brain.think<{ fixtures?: { key: string; fit: number; verdict: string; repo?: string | null; why: string; hours: number }[] }>(
    "Scout", "deep",
    "You are a hackathon scout. For each hackathon, judge how well this builder fits it from their real repos, skills and record. fit is 0-100. verdict: START (enter this week), BENCH (worth watching or weaker fit), OUT (only for a hard blocker: a RULE, hardware or access the builder lacks, or a field the builder has never touched). Judge the sponsor too: a payments company's hackathon suits a payments builder even if its themes only say AI. The rules-based fit is a reference from tag overlap; move away from it when the repos justify it. repo: the builder's existing repo that gives the biggest head start, exactly as named, or null. hours: realistic build hours for this builder given that head start. why: one plain sentence, specific to this builder and this hackathon. Respect every RULE. Be sceptical of big prizes with huge crowds.",
    `Builder ${p.login}: ${p.summary}\nSkills: ${p.skills.slice(0, 8).map(([t, v]) => `${t} ${v}`).join(", ")}\nRecord (H-MEM): ${record}\nWins: ${p.wins.map((w) => `${w.hackathon} (${w.tags.join("/")})`).join("; ") || "none listed"}\nPlan so far: ${carry}\nRepos:\n${repos}\n\nHackathons:\n${items}\n\nReturn {"fixtures":[{"key":"...","fit":80,"verdict":"START","repo":"name or null","why":"...","hours":14}]} with one entry per key.`,
    { maxTokens: 2600 }
  );
  if (!res?.fixtures?.length) return fallback();
  const byKey = new Map(res.fixtures.map((f) => [f.key, f]));
  return batch.map(({ h, el }) => {
    const m = byKey.get(h.key);
    if (!m) return playbook(h, p, el);
    const verdict = (["START", "BENCH", "OUT"].includes(String(m.verdict).toUpperCase()) ? String(m.verdict).toUpperCase() : "BENCH") as Verdict;
    return { key: h.key, fit: Math.round(Number(m.fit) || 0), verdict, repo: m.repo && m.repo !== "null" ? String(m.repo) : null, why: String(m.why ?? "").slice(0, 240), hours: Math.max(3, Math.min(80, Math.round(Number(m.hours) || 16))), by: "model" as const, model: brain.lastModel };
  });
}
