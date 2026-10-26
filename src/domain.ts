// Shared shapes for a scouting run.

export type Intent = "scout_builder" | "record_result" | "forbidden";
export type Verdict = "START" | "BENCH" | "OUT";

export interface Request {
  text: string;
  intent: Intent;
  login?: string;
  hours: number;           // build hours the builder has for this plan
  country?: string;        // where the builder can attend in person (optional)
  onlineOnly: boolean;
  result?: { hackathon: string; outcome: "won" | "placed" | "lost" };
  route: "act" | "clarify" | "decline";
  notes: string[];
}

export interface Hackathon {
  key: string;             // stable merged id
  sources: { source: string; id: string; url: string }[];
  name: string;
  organizer: string;
  online: boolean;
  location: string;
  closes: string | null;   // ISO date the submission period ends
  daysLeft: number | null;
  prizeText: string;
  prizeUsd: number;
  registrations: number;
  themes: string[];
  inviteOnly: boolean;
  state: "open" | "upcoming";
  tags: string[];          // scout skill tags (see skills.ts)
  needs: string[];         // hardware or access the theme implies
  evidence: string[];      // Zetaris query ids
}

export interface Repo {
  name: string;
  language: string;
  description: string;
  topics: string[];
  stars: number;
  pushedAt: string;
  homepage: string;
  tags: string[];
}

export interface Win {
  hackathon: string;
  project: string;
  tags: string[];
}

export interface Profile {
  login: string;
  repos: Repo[];
  languages: [string, number][];
  skills: [string, number][];      // tag, 0-100
  wins: Win[];
  summary: string;
  evidence: string[];
}

export interface Fixture {
  hackathon: Hackathon;
  fit: number;               // 0-100
  verdict: Verdict;
  repo: string | null;       // the builder's repo that gives a head start
  why: string;
  hours: number;
  pWin: number;
  evPerHour: number;
  by: "model" | "playbook";
  model?: string;
  coach: string[];           // Coach's objections / overrules
  memory: string[];          // H-MEM recalls that moved the score
}

export interface Plan {
  hours: number;
  used: number;
  picks: string[];           // hackathon keys, START
  expectedUsd: number;
}
