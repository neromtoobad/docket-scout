// Records output_examples/example_5.json (a reported result) in sample mode,
// in its own runtime, so it never writes a made-up result into real memory.
//   SAMPLE_MODE=true SCOUT_DATA=data/runtime-examples npx tsx scripts/example5.ts
import { readFileSync, writeFileSync } from "node:fs";
import { runJob } from "../src/run.ts";
await runJob({ input: { query: "scout neromtoobad, 38 hours" } }, { quiet: true });
const res = await runJob(JSON.parse(readFileSync("input_examples/example_5.json", "utf8")), { quiet: true });
writeFileSync("output_examples/example_5.json", JSON.stringify(res, null, 1));
console.log(res.status, res.output.summary);
