// Reconciler: one clean list from fragmented platforms. A single federated
// query joins every platform's hackathons to today's FX rates, so a ₹ or €
// prize is compared in dollars. Then it parses each platform's own date
// format into a closing date, merges the same event listed twice, tags it,
// and compares with what the scout saw last time (new events, moved
// deadlines, changed prizes), which it keeps in data/<runtime>/seen.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { DataDesk, rowsOf, num, str } from "../data.ts";
import type { Hackathon } from "../domain.ts";
import { needsOf, tagsOf } from "../skills.ts";
import { CONTAINER } from "../sources.ts";
import type { Trace } from "../trace.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "Aug 26 - Oct 30, 2026" | "Oct 24 - 31, 2026" | "Dec 01, 2026 - Jan 15, 2027" -> "2026-10-30"
export function closingDate(text: string): string | null {
  const [left = "", right = ""] = text.split(/\s[-–]\s/);
  const parse = (s: string) => {
    const m = s.trim().match(/^(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}),?(?:\s+(\d{4}))?$/);
    return m ? { mon: m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1, day: Number(m[2]), year: m[3] ? Number(m[3]) : undefined } : null;
  };
  const l = parse(left);
  const r = parse(right || left);
  if (!r) return null;
  const mon = r.mon >= 0 ? r.mon : l?.mon ?? -1;
  const year = r.year ?? l?.year;
  if (mon < 0 || !year) return null;
  return new Date(Date.UTC(year, mon, r.day)).toISOString().slice(0, 10);
}

export const mergeKey = (name: string): string =>
  name.toLowerCase().replace(/&/g, "and").replace(/\b(hackathon|hack|20\d\d|the|season|edition)\b/g, "").replace(/[^a-z0-9]/g, "");

export interface SeenChange { key: string; name: string; kind: "new" | "deadline_moved" | "prize_changed"; detail: string }

export interface Reconciled {
  hackathons: Hackathon[];
  merged: { name: string; sources: string[] }[];
  changes: SeenChange[];
  fx: { INR: number; EUR: number; GBP: number; NGN: number; updated: string };
  converted: { name: string; from: string; usd: number }[];
  evidence: string[];
}

export async function reconcile(data: DataDesk, trace: Trace, today = new Date()): Promise<Reconciled> {
  const fxq = await data.query(`SELECT INR, EUR, GBP, NGN, updated FROM ${CONTAINER}.fx`, "today's USD exchange rates", "Reconciler");
  const f = rowsOf(fxq)[0] ?? {};
  const fx = { INR: num(f.INR), EUR: num(f.EUR), GBP: num(f.GBP), NGN: num(f.NGN), updated: str(f.updated) };

  const q = await data.query(
    `SELECT h.source, h.source_id, h.name, h.url, h.organizer, h.online, h.location, h.dates_text, h.ends_at, h.prize_text, h.prize_currency, ` +
      `ROUND(CASE h.prize_currency WHEN 'INR' THEN h.prize_amount / f.INR WHEN 'EUR' THEN h.prize_amount / f.EUR WHEN 'GBP' THEN h.prize_amount / f.GBP ELSE h.prize_amount END, 0) AS prize_usd, ` +
      `h.registrations, h.themes, h.invite_only, h.state FROM ${CONTAINER}.hackathons h CROSS JOIN ${CONTAINER}.fx f`,
    "every live hackathon, prizes in USD (federated join with FX)", "Reconciler"
  );
  const evidence = [fxq.queryId, q.queryId];
  const day0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const byKey = new Map<string, Hackathon>();
  const merged: Reconciled["merged"] = [];
  const converted: Reconciled["converted"] = [];
  for (const r of rowsOf(q)) {
    const name = str(r.name).trim();
    if (!name) continue;
    const closes = str(r.dates_text) ? closingDate(str(r.dates_text)) : str(r.ends_at) ? str(r.ends_at).slice(0, 10) : null;
    const daysLeft = closes ? Math.round((Date.parse(closes) - day0) / 86_400_000) : null;
    if (daysLeft !== null && daysLeft < 0) continue;
    const prizeUsd = num(r.prize_usd) || 0;
    if (str(r.prize_currency) !== "USD" && prizeUsd) converted.push({ name, from: str(r.prize_text), usd: prizeUsd });
    const themes = str(r.themes).split(",").map((t) => t.trim()).filter(Boolean);
    const key = mergeKey(name);
    const src = { source: str(r.source), id: str(r.source_id), url: str(r.url) };
    const prev = byKey.get(key);
    if (prev) {
      // Same event on two platforms: keep one record, every source, the larger prize, the earlier deadline.
      prev.sources.push(src);
      prev.prizeUsd = Math.max(prev.prizeUsd, prizeUsd);
      prev.registrations += num(r.registrations) || 0;
      if (closes && (!prev.closes || closes < prev.closes)) { prev.closes = closes; prev.daysLeft = daysLeft; }
      prev.themes = [...new Set([...prev.themes, ...themes])];
      merged.push({ name, sources: prev.sources.map((s) => s.source) });
      continue;
    }
    const text = `${name} ${themes.join(" ")}`;
    byKey.set(key, {
      key, sources: [src], name, organizer: str(r.organizer), online: num(r.online) === 1, location: str(r.location).replace(/(,\s*)+$/, "").trim() || (num(r.online) === 1 ? "Online" : "In person"),
      closes, daysLeft, prizeText: str(r.prize_text), prizeUsd, registrations: num(r.registrations) || 0, themes,
      inviteOnly: num(r.invite_only) === 1, state: str(r.state) === "upcoming" ? "upcoming" : "open",
      tags: tagsOf(text), needs: needsOf(text), evidence: [q.queryId],
    });
  }
  const hackathons = [...byKey.values()];

  // What changed since the scout last looked.
  const file = join(config.dataDir, "seen.json");
  const seen: Record<string, { name: string; closes: string | null; prizeUsd: number; first: string }> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const firstLook = Object.keys(seen).length === 0;
  const changes: SeenChange[] = [];
  for (const h of hackathons) {
    const s = seen[h.key];
    if (!s) {
      if (!firstLook) changes.push({ key: h.key, name: h.name, kind: "new", detail: `new on ${h.sources.map((x) => x.source).join(" + ")}` });
    } else {
      if (s.closes && h.closes && s.closes !== h.closes) changes.push({ key: h.key, name: h.name, kind: "deadline_moved", detail: `deadline moved ${s.closes} → ${h.closes}` });
      if (s.prizeUsd && h.prizeUsd && Math.abs(s.prizeUsd - h.prizeUsd) / s.prizeUsd > 0.05) changes.push({ key: h.key, name: h.name, kind: "prize_changed", detail: `prize $${Math.round(s.prizeUsd).toLocaleString("en-US")} → $${Math.round(h.prizeUsd).toLocaleString("en-US")}` });
    }
    seen[h.key] = { name: h.name, closes: h.closes, prizeUsd: h.prizeUsd, first: s?.first ?? today.toISOString().slice(0, 10) };
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(seen, null, 1));

  trace.log({
    agent_name: "Reconciler", action: "reconcile", target_agent: "Scout", status: "success",
    input_summary: `${rowsOf(q).length} rows from ${new Set(rowsOf(q).map((r) => str(r.source))).size} platforms; FX ${fx.updated}`,
    output_summary: `${hackathons.length} live after dropping closed; ${merged.length} merged across platforms; ${converted.length} prizes converted to USD (e.g. ${converted.slice(0, 2).map((c) => `${c.from} → $${c.usd.toLocaleString("en-US")}`).join(", ") || "none"}); ${firstLook ? "first look, baseline saved" : `${changes.length} changes since last scout`}`,
    data: { merged, converted: converted.slice(0, 12), changes, fx },
  });
  for (const c of changes.filter((c) => c.kind !== "new").slice(0, 8)) {
    trace.log({ agent_name: "Reconciler", action: c.kind, status: "info", input_summary: c.name, output_summary: c.detail });
  }
  return { hackathons, merged, changes, fx, converted, evidence };
}
