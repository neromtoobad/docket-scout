// Budget: every job gets a quote, and model calls, Zetaris queries, Markovian
// steps and wall-clock time are metered against it. When a line runs out,
// further spend is refused and the run finishes with what it has.

import { config } from "../config.ts";
import type { Request } from "../domain.ts";
import type { Trace } from "../trace.ts";

export type Line = "modelCalls" | "queries" | "rounds";

export interface Quote {
  maxRounds: number;
  maxQueries: number;
  maxModelCalls: number;
  maxSeconds: number;
  rationale: string;
}

export class Budget {
  quote: Quote;
  readonly spent: Record<Line, number> = { modelCalls: 0, queries: 0, rounds: 0 };
  tokens = 0;
  readonly started = Date.now();
  escalations: string[] = [];

  constructor(private trace: Trace, private caps = config.budget) {
    // Provisional allowance for Intake, before the job is quoted.
    this.quote = { maxRounds: 0, maxQueries: 14, maxModelCalls: 6, maxSeconds: caps.maxSeconds, rationale: "intake and discovery allowance" };
  }

  // Quoted once the Reconciler knows how many hackathons are worth a look:
  // fixed discovery work (sources, builder registration, profile) plus
  // bounded Markovian steps of STEP_SIZE candidates each.
  quoteJob(req: Request, candidates: number, stepSize: number): Quote {
    const caps = this.caps;
    const steps = Math.max(1, Math.ceil(candidates / stepSize));
    this.quote = {
      maxRounds: Math.min(caps.maxRounds, steps + 1),
      maxQueries: Math.min(caps.maxQueries, 14 + steps * 2),
      maxModelCalls: Math.min(caps.maxModelCalls, 6 + steps * 3),
      maxSeconds: caps.maxSeconds,
      rationale: `${req.login}: ${candidates} candidate hackathon${candidates === 1 ? "" : "s"} in ${steps} bounded step${steps === 1 ? "" : "s"}`,
    };
    this.trace.log({
      agent_name: "Budget", action: "quote_job", status: "success",
      input_summary: `builder=${req.login} hours=${req.hours} candidates=${candidates}`,
      output_summary: `${this.quote.maxRounds} steps, ${this.quote.maxQueries} queries, ${this.quote.maxModelCalls} model calls, ${this.quote.maxSeconds}s (${this.quote.rationale})`,
      data: { quote: this.quote },
    });
    return this.quote;
  }

  private cap(line: Line): number {
    return line === "modelCalls" ? this.quote.maxModelCalls : line === "queries" ? this.quote.maxQueries : this.quote.maxRounds;
  }

  get elapsedSeconds(): number {
    return (Date.now() - this.started) / 1000;
  }

  canSpend(line: Line, n = 1): boolean {
    return this.spent[line] + n <= this.cap(line) && this.elapsedSeconds < this.quote.maxSeconds;
  }

  // Approve and record spend; returns false (and escalates once per line) when over budget.
  approve(line: Line, by: string, n = 1): boolean {
    if (this.canSpend(line, n)) {
      this.spent[line] += n;
      return true;
    }
    const reason = this.elapsedSeconds >= this.quote.maxSeconds ? `time cap ${this.quote.maxSeconds}s` : `${line} cap ${this.cap(line)}`;
    const key = `${line}:${reason}`;
    if (!this.escalations.includes(key)) {
      this.escalations.push(key);
      this.trace.log({
        agent_name: "Budget", action: "deny_spend", target_agent: by, status: "needs_revision",
        input_summary: `${by} asked for ${n} more ${line}`,
        output_summary: `denied: ${reason} reached; finish with the evidence already gathered`,
      });
    }
    return false;
  }

  statement(): Record<string, unknown> {
    return {
      quote: this.quote,
      spent: { ...this.spent, estTokens: this.tokens, seconds: Math.round(this.elapsedSeconds) },
      escalations: this.escalations,
    };
  }
}
