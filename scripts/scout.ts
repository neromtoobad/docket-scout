// Run one job from the command line and print the plan.
//   npx tsx --env-file=.env scripts/scout.ts "scout neromtoobad, 38 hours"
import { runJob } from "../src/run.ts";
const res = await runJob({ input: { query: process.argv.slice(2).join(" ") || "scout neromtoobad, 38 hours" } }, { quiet: process.env.QUIET === "1" });
console.log("\n" + res.status, res.output.summary);
for (const f of res.output.fixtures.slice(0, 12)) console.log(`${f.verdict.padEnd(5)} ${String(f.fit).padStart(3)}  $${String(f.evPerHour).padStart(5)}/h  ${f.hours}h  ${f.hackathon.name.slice(0, 44).padEnd(44)} ${f.repo ?? "-"}  | ${f.why.slice(0, 90)}`);
console.log("note:", res.output.note);
console.log("log:", res.output.log.map((l) => `[${l.kind}] ${l.text}`).join("\n     "));
console.log("engines:", res.engines, "cost:", JSON.stringify(res.cost), "sources:", res.data_sources, res.execution_time_seconds + "s");
