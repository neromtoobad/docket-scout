// Is Meterless Nightshift reachable, and which models does it route? (dev helper)
//   npx tsx --env-file=.env scripts/provider-status.ts
import { MeterlessProvider } from "../src/adapters/meterless.ts";
const s = await new MeterlessProvider().status();
console.log(s.status, s.detail ?? "", s.models.filter((m) => /nemotron|meterless\//.test(m)).slice(0, 12).join(", "));
