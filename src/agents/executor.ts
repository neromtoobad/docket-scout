// Executor: the only agent that changes anything, and only what the contract
// allows: it writes the builder's docket (the shortlist the Hack Docket
// tracker reads) and a calendar of deadlines. It has no code path that
// registers, submits or messages anyone; the contract says so too.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { Fixture, Plan } from "../domain.ts";
import type { Trace } from "../trace.ts";
import { verify, type ExecutionContract } from "./intake.ts";

export interface DocketEntry {
  key: string;
  name: string;
  url: string;
  closes: string | null;
  prizeUsd: number;
  status: "shortlist" | "watch";
  fit: number;
  evPerHour: number;
  hours: number;
  repo: string | null;
  addedBy: string;
  updated: string;
  result?: "won" | "placed" | "lost";
}

export interface Docket { login: string; updated: string; entries: DocketEntry[] }

const file = (login: string) => join(config.dataDir, "docket", `${login}.json`);

export function readDocket(login: string): Docket {
  return existsSync(file(login)) ? JSON.parse(readFileSync(file(login), "utf8")) : { login, updated: "", entries: [] };
}

export function writeDocket(d: Docket): void {
  mkdirSync(join(config.dataDir, "docket"), { recursive: true });
  writeFileSync(file(d.login), JSON.stringify(d, null, 1));
}

const icsDate = (d: string) => d.replace(/-/g, "");
const esc = (s: string) => s.replace(/[,;\\]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");

export function calendar(login: string, entries: DocketEntry[]): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const events = entries.filter((e) => e.closes).map((e) => [
    "BEGIN:VEVENT",
    `UID:${e.key}-${login}@docket-scout`,
    `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${icsDate(e.closes!)}`,
    `SUMMARY:${esc(`${e.status === "shortlist" ? "Submit" : "Closes"}: ${e.name}`)}`,
    `DESCRIPTION:${esc(`Prize ~$${Math.round(e.prizeUsd).toLocaleString("en-US")}. Fit ${e.fit}. About ${e.hours}h${e.repo ? `, start from ${e.repo}` : ""}. ${e.url}`)}`,
    `URL:${e.url}`,
    "END:VEVENT",
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Docket Scout//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

export class Executor {
  constructor(private trace: Trace, private contract: () => ExecutionContract) {}

  apply(login: string, plan: Plan, fixtures: Fixture[]): { docket: Docket; calendarPath: string | null } {
    const c = verify(this.contract(), "docket.write");
    if (!c.ok) {
      this.trace.log({ agent_name: "Executor", action: "contract_refused", status: "error", input_summary: "docket.write", output_summary: c.reason });
      return { docket: readDocket(login), calendarPath: null };
    }
    const today = new Date().toISOString().slice(0, 10);
    const d = readDocket(login);
    const keep = d.entries.filter((e) => e.result || e.addedBy !== "scout"); // results and the builder's own entries survive
    const byKey = new Map(keep.map((e) => [e.key, e]));
    const put = (f: Fixture, status: DocketEntry["status"]) => {
      const prev = byKey.get(f.hackathon.key);
      byKey.set(f.hackathon.key, {
        key: f.hackathon.key, name: f.hackathon.name, url: f.hackathon.sources[0]?.url ?? "", closes: f.hackathon.closes, prizeUsd: f.hackathon.prizeUsd,
        status: prev?.result ? prev.status : status, fit: f.fit, evPerHour: f.evPerHour, hours: f.hours, repo: f.repo,
        addedBy: prev?.addedBy ?? "scout", updated: today, result: prev?.result,
      });
    };
    for (const f of fixtures.filter((x) => plan.picks.includes(x.hackathon.key))) put(f, "shortlist");
    for (const f of fixtures.filter((x) => x.verdict === "BENCH").slice(0, 5)) if (!byKey.has(f.hackathon.key)) put(f, "watch");
    const docket: Docket = { login, updated: new Date().toISOString(), entries: [...byKey.values()].sort((a, b) => (a.closes ?? "9").localeCompare(b.closes ?? "9")) };
    writeDocket(docket);

    let calendarPath: string | null = null;
    if (verify(this.contract(), "calendar.export").ok) {
      calendarPath = join(config.dataDir, "docket", `${login}.ics`);
      writeFileSync(calendarPath, calendar(login, docket.entries.filter((e) => e.status === "shortlist")));
    }
    this.trace.log({
      agent_name: "Executor", action: "write_docket", status: "success",
      input_summary: `${plan.picks.length} picks within ${plan.hours}h`,
      output_summary: `docket for ${login}: ${docket.entries.filter((e) => e.status === "shortlist").length} shortlisted, ${docket.entries.filter((e) => e.status === "watch").length} on watch; calendar ${calendarPath ? "exported" : "not exported"}. Nothing registered or submitted (outside the contract).`,
      data: { picks: plan.picks, calendar: calendarPath },
    });
    return { docket, calendarPath };
  }

  recordResult(login: string, name: string, key: string | null, outcome: "won" | "placed" | "lost"): void {
    if (!verify(this.contract(), "docket.write").ok) return;
    const d = readDocket(login);
    const e = d.entries.find((x) => (key && x.key === key) || x.name.toLowerCase() === name.toLowerCase());
    if (e) e.result = outcome;
    else d.entries.push({ key: key ?? name.toLowerCase().replace(/[^a-z0-9]/g, ""), name, url: "", closes: null, prizeUsd: 0, status: "shortlist", fit: 0, evPerHour: 0, hours: 0, repo: null, addedBy: login, updated: new Date().toISOString().slice(0, 10), result: outcome });
    d.updated = new Date().toISOString();
    writeDocket(d);
  }
}
