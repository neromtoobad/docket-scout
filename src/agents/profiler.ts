// Profiler: the builder's scouting card, from their public GitHub only.
// Repos (language, topics, description, recency, stars) map onto the scout's
// skill tags with deterministic rules; the profile README's wins table, if it
// has one, becomes the trophy cabinet. Nemotron (fast lane) tags each win and
// writes the one-line scouting summary; without it the rules do both.

import type { Brain } from "../brain.ts";
import { DataDesk, rowsOf, num, str } from "../data.ts";
import type { Profile, Repo, Win } from "../domain.ts";
import { TAGS, TAG_LABEL, tagsOf, type Tag } from "../skills.ts";
import { CONTAINER, readmeView, repoView, safeLogin } from "../sources.ts";
import type { Trace } from "../trace.ts";

const DAY = 86_400_000;

// Rows of the first markdown table under a heading that mentions wins/awards.
export function parseWins(readme: string): { hackathon: string; project: string; note: string }[] {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,4}\s.*(win|award|🏆|trophy|prize)/i.test(l));
  if (start === -1) return [];
  const out: { hackathon: string; project: string; note: string }[] = [];
  const clean = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^#{1,4}\s/.test(l) || /^---+$/.test(l)) {
      if (out.length) break;
      continue;
    }
    if (l.startsWith("|")) {
      const cells = l.split("|").slice(1, -1).map(clean);
      if (cells.length < 2 || /^:?-+:?$/.test(cells[0]) || /^hackathon$/i.test(cells[0])) continue;
      out.push({ hackathon: cells[0], project: cells[1], note: (cells[2] ?? "").slice(0, 280) });
    } else if (/^[-*]\s/.test(l)) {
      const t = clean(l.slice(2));
      const [h, p] = t.split(/\s[—–-]\s|:\s/);
      out.push({ hackathon: h, project: p ?? "", note: t.slice(0, 280) });
    }
  }
  return out.slice(0, 30);
}

export async function profile(login0: string, data: DataDesk, brain: Brain, trace: Trace): Promise<Profile> {
  const login = safeLogin(login0);
  const evidence: string[] = [];
  const rq = await data.query(
    `SELECT name, language, description, topics, stars, pushed_at, homepage FROM ${CONTAINER}.${repoView(login)} WHERE is_fork = 0 ORDER BY pushed_at DESC`,
    `${login}'s original repos`, "Profiler"
  );
  evidence.push(rq.queryId);
  const lq = await data.query(
    `SELECT language, COUNT(*) AS repos FROM ${CONTAINER}.${repoView(login)} WHERE is_fork = 0 AND language IS NOT NULL GROUP BY language ORDER BY repos DESC`,
    `${login}'s languages`, "Profiler"
  );
  evidence.push(lq.queryId);

  const now = Date.now();
  const repos: Repo[] = rowsOf(rq).map((r) => {
    const topics = str(r.topics).split(",").map((t) => t.trim()).filter(Boolean);
    const text = `${str(r.name)} ${str(r.description)} ${topics.join(" ")} ${str(r.language)}`;
    return { name: str(r.name), language: str(r.language), description: str(r.description), topics, stars: num(r.stars) || 0, pushedAt: str(r.pushed_at), homepage: str(r.homepage), tags: tagsOf(text) };
  });

  // README wins table -> trophy cabinet.
  let raw: { hackathon: string; project: string; note: string }[] = [];
  try {
    const rm = await data.query(`SELECT content FROM ${CONTAINER}.${readmeView(login)}`, `${login}'s profile README`, "Profiler");
    evidence.push(rm.queryId);
    const b64 = str(rm.rows[0]?.[0]).replace(/\s/g, "");
    if (b64) raw = parseWins(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    /* no profile README */
  }
  let wins: Win[] = raw.map((w) => ({ hackathon: w.hackathon, project: w.project, tags: tagsOf(`${w.hackathon} ${w.project} ${w.note}`).slice(0, 4) }));
  if (raw.length && brain.online) {
    const tagged = await brain.think<{ wins?: { i: number; tags: string[] }[] }>(
      "Profiler", "fast",
      `You tag hackathon wins with skill tags. Allowed tags: ${TAGS.join(", ")}. Pick the 1-3 tags that best describe what the winning project needed.`,
      raw.map((w, i) => `${i}. ${w.hackathon} — ${w.project}: ${w.note}`).join("\n") + `\nReturn {"wins":[{"i":0,"tags":["agents","payments"]}]}`,
      { maxTokens: 900 }
    );
    for (const t of tagged?.wins ?? []) {
      const ok = (t.tags ?? []).filter((x): x is Tag => (TAGS as readonly string[]).includes(x));
      if (wins[t.i] && ok.length) wins[t.i] = { ...wins[t.i], tags: ok.slice(0, 3) };
    }
  }
  wins = wins.filter((w) => w.hackathon);

  // Skill scores: recency-weighted repo evidence, plus wins, relative to the strongest tag.
  const weight = new Map<Tag, number>();
  for (const r of repos) {
    const age = (now - Date.parse(r.pushedAt || "2000-01-01")) / DAY;
    const w = (age < 90 ? 1 : age < 365 ? 0.6 : 0.3) + Math.min(1, r.stars / 10);
    for (const t of r.tags as Tag[]) weight.set(t, (weight.get(t) ?? 0) + w);
  }
  for (const w of wins) for (const t of w.tags as Tag[]) weight.set(t, (weight.get(t) ?? 0) + 3);
  const max = Math.max(1, ...weight.values());
  const skills = TAGS.map((t) => [t, weight.get(t) ? Math.round(35 + 60 * (weight.get(t)! / max)) : 10] as [string, number]).sort((a, b) => b[1] - a[1]);
  const languages = rowsOf(lq).map((r) => [str(r.language), num(r.repos)] as [string, number]);

  const top = skills.slice(0, 3).map(([t]) => TAG_LABEL[t as Tag]);
  let summary = `Strongest in ${top.join(", ")}${wins.length ? `, with ${wins.length} hackathon win${wins.length === 1 ? "" : "s"} on the profile` : ""}. ${repos.length} original repos, mostly ${languages.slice(0, 2).map(([l]) => l).join(" and ") || "unknown languages"}.`;
  if (brain.online) {
    const s = await brain.think<{ summary?: string }>(
      "Profiler", "fast",
      "You are a hackathon scout writing one or two plain sentences about a builder, like a football scouting note: where they are strongest, what they ship, what to avoid. Only the listed wins are wins; never describe a repo as a win. No hype, no emojis.",
      `GitHub: ${login} (exactly ${wins.length} wins and ${repos.length} original repos; use no other counts)\nSkills: ${skills.slice(0, 6).map(([t, v]) => `${t} ${v}`).join(", ")}\nLanguages: ${languages.slice(0, 5).map(([l, n]) => `${l} ${n}`).join(", ")}\nRecent repos: ${repos.slice(0, 12).map((r) => `${r.name} (${r.description.slice(0, 80)})`).join("; ")}\nWins: ${wins.map((w) => `${w.hackathon} with ${w.project}`).join("; ") || "none listed"}\nReturn {"summary":"..."}`,
      { maxTokens: 300 }
    );
    // Only numbers the scout can back: a summary that miscounts wins or repos is dropped.
    const nums = [...(s?.summary ?? "").matchAll(/(\d+)\s+(?:hackathon\s+)?(wins?|repos?|repositories)/gi)];
    const honest = nums.every((m) => Number(m[1]) === (/win/i.test(m[2]) ? wins.length : repos.length));
    if (s?.summary && s.summary.length > 20 && honest) summary = s.summary.trim();
    else if (s?.summary) trace.log({ agent_name: "Profiler", action: "summary_rejected", status: "retry", input_summary: "model summary", output_summary: `rejected: numbers don't match the profile (${wins.length} wins, ${repos.length} repos); using the rules' summary` });
  }

  trace.log({
    agent_name: "Profiler", action: "build_profile", target_agent: "Archivist", status: "success", model: brain.online ? brain.lastModel : undefined,
    input_summary: `${repos.length} repos, README wins table`,
    output_summary: `${skills.slice(0, 4).map(([t, v]) => `${TAG_LABEL[t as Tag]} ${v}`).join(", ")}; ${wins.length} wins: ${wins.slice(0, 4).map((w) => `${w.hackathon} [${w.tags.join("/")}]`).join("; ")}`,
    data: { skills, languages, wins, summary },
  });
  return { login, repos, languages, skills, wins, summary, evidence };
}
