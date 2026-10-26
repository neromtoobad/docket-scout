// Intake agent, implemented on the Meterless Scout Intent spec:
//   Sense -> Interpret -> Guard -> Route -> signed ExecutionContract
// Nothing downstream acts on the raw request. Every agent that touches
// Zetaris, H-MEM, the World Model or the docket verifies the contract
// (signature, expiry, capability) first. The contract also carries the
// scout's *authority*: it may shortlist and write the docket and a calendar,
// and it never registers, submits or messages anyone on the builder's behalf,
// whatever the request says.

import { createHmac, randomUUID } from "node:crypto";
import type { Request } from "../domain.ts";
import type { Brain } from "../brain.ts";
import type { Trace } from "../trace.ts";

// ------------------------------------------------------------ registry

export interface IntentDef {
  id: Request["intent"];
  description: string;
  capabilities: string[];
  riskClass: "low" | "medium" | "high";
  triggers: [string, number][];
  examples: string[];
}

export const REGISTRY_VERSION = 1;
export const POLICY_PACK_VERSION = "docket-scout-2026.10";

const READ = ["data.sql", "source.register", "memory.recall", "world.case"];

export const REGISTRY: IntentDef[] = [
  {
    id: "scout_builder", riskClass: "low", description: "Find live hackathons, match them to a builder's GitHub, and plan which to enter within their hours",
    capabilities: [...READ, "docket.write", "calendar.export", "memory.store"],
    triggers: [["scout", 4], ["github", 3], ["which hackathons", 4], ["what should i enter", 4], ["plan", 2], ["hours", 2], ["this week", 2], ["find", 2], ["enter", 1], ["fit", 2]],
    examples: ["Scout neromtoobad, 38 hours this week"],
  },
  {
    id: "record_result", riskClass: "low", description: "Record how an entry turned out, so the scout learns",
    capabilities: ["memory.store", "memory.recall", "world.case", "docket.write"],
    triggers: [["i won", 5], ["we won", 5], ["placed", 4], ["didn't place", 5], ["did not place", 5], ["lost", 3], ["result", 3], ["finalist", 4], ["no prize", 4]],
    examples: ["I won the PayPal AI Hackathon"],
  },
  {
    id: "forbidden", riskClass: "high", description: "What the scout never does: register, submit, apply, message organisers, create accounts, or get past bot checks",
    capabilities: [],
    triggers: [["register me", 5], ["sign me up", 5], ["sign up for", 4], ["submit for me", 5], ["submit my", 4], ["apply for me", 5], ["apply to all", 5], ["dm the", 4], ["message the organi", 4], ["email the organi", 4], ["spam", 5], ["create an account", 5], ["bypass", 5], ["captcha", 5], ["fake", 4]],
    examples: ["Register me for all of them"],
  },
];

const CAPABILITY_TOOLS: Record<string, string> = {
  "data.sql": "zetaris.sql",
  "source.register": "zetaris.ddl",
  "memory.recall": "hmem.query",
  "memory.store": "hmem.add",
  "world.case": "worldmodel.case",
  "docket.write": "docket.shortlist",
  "calendar.export": "docket.ics",
};

// ------------------------------------------------------------ contract

export interface Authority {
  maxPlanHours: number;
  writesDocket: true;
  exportsCalendar: true;
  registers: false;      // never signs the builder up anywhere
  submits: false;        // never submits a project
  messages: false;       // never contacts organisers or anyone else
}

export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: { primary: Request["intent"]; parameters: Request; confidence: number; alternates: { id: string; score: number }[] };
  risk: { level: "low" | "medium" | "high" | "block"; flags: string[]; redactions: string[]; reason?: string };
  toolPlan: { tool: string; capability: string }[];
  modelProfile: { fast: string; deep: string; provider: "meterless-nightshift" };
  scope: { user: string; surface: string; capabilities: string[]; authority: Authority };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

const SECRET = process.env.SCOUT_CONTRACT_SECRET || `scout-dev-${process.pid}`;
const TTL_MS = 5 * 60 * 1000;

export const AUTHORITY: Authority = { maxPlanHours: 80, writesDocket: true, exportsCalendar: true, registers: false, submits: false, messages: false };

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function sign(c: Omit<ExecutionContract, "signature">): ExecutionContract {
  return { ...c, signature: createHmac("sha256", SECRET).update(canonical(c)).digest("hex") };
}

export function verify(c: ExecutionContract, capability: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const { signature, ...rest } = c;
  const expected = createHmac("sha256", SECRET).update(canonical(rest)).digest("hex");
  if (signature !== expected) return { ok: false, reason: "contract signature invalid (tampered or unsigned)" };
  if (now > Date.parse(c.expiresAt)) return { ok: false, reason: "contract expired" };
  if (c.risk.level === "block") return { ok: false, reason: `contract blocked: ${c.risk.reason}` };
  if (!c.scope.capabilities.includes(capability)) return { ok: false, reason: `capability ${capability} is outside the contract scope` };
  return { ok: true };
}

// Long-running work refreshes the contract per Markovian step, keeping lineage.
export function refresh(c: ExecutionContract): ExecutionContract {
  const { signature: _s, ...rest } = c;
  const now = new Date();
  return sign({ ...rest, parentId: c.contractId, contractId: randomUUID(), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS).toISOString() });
}

// ------------------------------------------------------------ stages

export function sense(text: string): { id: Request["intent"]; score: number }[] {
  const t = text.toLowerCase();
  const raw = REGISTRY.map((i) => {
    let s = 0;
    for (const [phrase, w] of i.triggers) if (t.includes(phrase)) s += w;
    return { id: i.id, raw: s };
  });
  const total = raw.reduce((a, r) => a + r.raw, 0);
  return raw.map((r) => ({ id: r.id, score: total ? +(r.raw / total).toFixed(3) : 0 })).sort((a, b) => b.score - a.score);
}

const STOP = new Set(["scout", "me", "my", "for", "this", "week", "hours", "hour", "github", "with", "the", "and", "plan", "find", "which", "hackathons", "should", "enter", "what", "in", "from", "online", "only", "please", "a", "an", "of", "to", "i", "have", "next", "days", "user", "builder", "profile"]);

export function bindLogin(text: string): string | undefined {
  const url = text.match(/github\.com\/([A-Za-z0-9-]{1,39})/i);
  if (url) return url[1];
  const at = text.match(/(?:^|\s)@([A-Za-z0-9-]{1,39})\b/);
  if (at) return at[1];
  const named = text.match(/\b(?:scout|for|builder|user|login)\s+([A-Za-z0-9][A-Za-z0-9-]{1,38})\b/i);
  if (named && !STOP.has(named[1].toLowerCase()) && !/^\d+$/.test(named[1])) return named[1];
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(words[0])) return words[0];
  return undefined;
}

export function bindHours(text: string): number | undefined {
  const m = text.match(/(\d{1,3})\s*(?:h\b|hrs?\b|hours?\b)/i);
  return m ? Math.min(200, Math.max(1, Number(m[1]))) : undefined;
}

export function bindCountry(text: string): string | undefined {
  const m = text.match(/\b(?:i(?:'m| am) in|based in|from|live in|in person in)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);
  return m?.[1];
}

export function bindResult(text: string): Request["result"] | undefined {
  const outcome = /\b(i|we) won\b|\bwinner\b|first place/i.test(text) ? "won" : /\bplaced\b|finalist|runner[- ]?up|second|third|honou?rable/i.test(text) ? "placed" : /didn't place|did not place|\blost\b|no prize|didn't win|did not win/i.test(text) ? "lost" : undefined;
  if (!outcome) return undefined;
  const name = text.replace(/\b(i|we)\s+(won|placed|lost|didn't place|did not place|didn't win|did not win)\b|\b(at|in|the|my|our|entry|result|for|was|a|finalist|runner[- ]?up|first place|second|third|no prize)\b/gi, " ").replace(/[.!]/g, " ").replace(/\s+/g, " ").trim();
  return name.length > 2 ? { hackathon: name, outcome } : undefined;
}

const INJECTION = [/ignore (all |the )?(previous|prior|above) (instructions|prompts)/i, /<\/?system>/i, /\[INST\]/i, /you are now/i, /reveal (your|the) (system )?prompt/i, /api[_ ]?key|password|secret token/i];
const AUTHORITY_CLAIM = /\b(organi[sz]er|judge|admin|sponsor|devpost staff|moderator)\b[^.]{0,40}\b(said|says|approved|allowed|okayed|agreed|told)\b|\bi(?:'m| am) (an? )?(organi[sz]er|judge|admin)\b/i;

export interface IntakeResult {
  contract: ExecutionContract;
  clarification?: { question: string; options: string[] };
}

export async function intake(text0: string, trace: Trace, brain: Brain | null, runId: string, defaults: { login?: string; hours?: number } = {}): Promise<IntakeResult> {
  const text = text0.trim().slice(0, 600);

  // Sense
  const ranked = sense(text);
  let top = ranked[0];
  if (top.score === 0) top = { id: "scout_builder", score: 0.4 };
  const def = REGISTRY.find((i) => i.id === top.id)!;

  // Interpret
  const notes: string[] = [];
  let login = defaults.login ?? bindLogin(text);
  const hours = defaults.hours ?? bindHours(text) ?? 20;
  const country = bindCountry(text);
  const onlineOnly = !country && !/in[- ]person (is )?(ok|fine)/i.test(text);
  const result = def.id === "record_result" ? bindResult(text) : undefined;

  // Stage 2 (optional): ask Nemotron to bind a GitHub login the rules missed.
  if (brain?.online && def.id === "scout_builder" && !login) {
    const s2 = await brain.think<{ login?: string | null }>("Intake", "fast", "You extract a GitHub username from a request to scout hackathons for a builder.", `Request: ${text}\nReturn {"login": the GitHub username, or null}`);
    if (s2?.login && /^[A-Za-z0-9-]{1,39}$/.test(s2.login)) {
      login = s2.login;
      trace.log({ agent_name: "Intake", action: "stage2_bind", status: "success", model: brain.lastModel, input_summary: "Scout Intent Stage 2", output_summary: `bound GitHub login ${login}` });
    }
  }

  // Guard
  const flags: string[] = [];
  let level: ExecutionContract["risk"]["level"] = def.riskClass;
  let reason: string | undefined;
  if (INJECTION.some((re) => re.test(text))) {
    flags.push("injection");
    level = "block";
    reason = "the request tries to change the scout's instructions or extract secrets";
  }
  if (def.id === "forbidden") {
    flags.push("forbidden_action");
    level = "block";
    reason = reason ?? "the scout plans and shortlists; it never registers, submits, messages organisers, creates accounts or gets past bot checks for anyone";
  }
  if (AUTHORITY_CLAIM.test(text)) {
    flags.push("unverified_authority_claim");
    notes.push("The request claims an organiser or judge allowed something. Claimed authority is not accepted: the scout's authority is fixed by its contract.");
    if (level !== "block") level = "high";
  }
  if (hours > AUTHORITY.maxPlanHours) notes.push(`Plans are capped at ${AUTHORITY.maxPlanHours} hours; ${hours} was asked.`);
  const redactions: string[] = [];
  if (/\b\d{9,}\b|[a-z0-9._-]+@[a-z0-9-]+\.[a-z]/i.test(text)) redactions.push("possible personal identifier");
  let route: Request["route"] = level === "block" ? "decline" : "act";
  if (route === "act" && def.id === "scout_builder" && !login) route = "clarify";
  if (route === "act" && def.id === "record_result" && !result) route = "clarify";

  const parameters: Request = { text, intent: def.id, login, hours: Math.min(hours, AUTHORITY.maxPlanHours), country, onlineOnly, result, route, notes };
  const now = new Date();
  const contract = sign({
    contractId: randomUUID(),
    traceId: runId,
    intent: { primary: def.id, parameters, confidence: top.score, alternates: ranked.slice(1).filter((r) => r.score > 0) },
    risk: { level, flags, redactions, reason },
    toolPlan: def.capabilities.filter((c) => CAPABILITY_TOOLS[c]).map((c) => ({ capability: c, tool: CAPABILITY_TOOLS[c] })),
    modelProfile: { fast: "lane:fast (Nemotron via Nightshift)", deep: "lane:deep (Nemotron via Nightshift)", provider: "meterless-nightshift" },
    scope: { user: login ?? "anonymous", surface: "docket-scout", capabilities: level === "block" ? [] : def.capabilities, authority: AUTHORITY },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    registryVersion: REGISTRY_VERSION,
    policyPackVersion: POLICY_PACK_VERSION,
    signedBy: "scout",
  });

  trace.log({
    agent_name: "Intake", action: "issue_contract", target_agent: route === "act" ? "Surveyor" : undefined,
    status: route === "act" ? "success" : "needs_revision", confidence: top.score,
    input_summary: text.slice(0, 160),
    output_summary: route === "decline"
      ? `blocked at Guard: ${reason}`
      : `${def.id} (${top.score}); ${login ? `builder ${login}` : "no builder bound"}; ${parameters.hours}h; ${onlineOnly ? "online only" : `in person OK in ${country ?? "any country"}`}${result ? `; result ${result.outcome}: ${result.hackathon}` : ""}; risk ${level}${flags.length ? ` [${flags.join(", ")}]` : ""}; authority: shortlist + calendar only, never registers/submits/messages; signed contract ${contract.contractId.slice(0, 8)}`,
    data: { engine: "Scout Intent", contract: { ...contract, signature: contract.signature.slice(0, 12) + "…" } },
  });

  const clarification = route === "clarify"
    ? def.id === "record_result"
      ? { question: "Which hackathon, and how did it go?", options: ["I won <hackathon>", "I placed at <hackathon>", "I didn't place at <hackathon>"] }
      : { question: "Whose GitHub should the scout read?", options: ["github.com/<username>", "@<username>"] }
    : undefined;
  return { contract, clarification };
}
