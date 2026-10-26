// The scout's shared vocabulary: 16 skill tags (the same tags Hack Docket
// uses), keyword rules that map repo text and hackathon themes onto them, and
// the hardware/access a theme implies. Deterministic, so a fit score can
// always be explained; Nemotron refines on top of it.

export const TAGS = [
  "agents", "trading", "payments", "onchain", "consumer", "games", "fullstack", "dataviz",
  "devtools", "privacy", "bio", "education", "impact", "writing", "ml", "hardware",
] as const;
export type Tag = (typeof TAGS)[number];

export const TAG_LABEL: Record<Tag, string> = {
  agents: "Agents", trading: "Trading", payments: "Payments", onchain: "Onchain", consumer: "Consumer", games: "Games",
  fullstack: "Full-stack", dataviz: "Data viz", devtools: "Dev tools", privacy: "Privacy", bio: "Health & bio",
  education: "Education", impact: "Social impact", writing: "Writing", ml: "ML", hardware: "Hardware",
};

const RULES: [Tag, RegExp][] = [
  ["agents", /\bagent(s|ic)?\b|agentic|\bmcp\b|multi-agent|autonomous|copilot|assistant|llm|gpt|claude|nemotron|langchain|rag\b/i],
  ["trading", /\btrad(e|ing|er)\b|perps?\b|futures|dex\b|market[- ]?mak|prediction market|order ?book|portfolio|alpha|signal/i],
  ["payments", /payment|\bpay\b|paypal|stripe|venmo|visa\b|mastercard|circle\b|x402|escrow|usdc|stablecoin|wallet|checkout|invoice|billing|fintech|remittance|naira|off-?ramp|credit/i],
  ["onchain", /blockchain|web3|solidity|onchain|on-chain|smart contract|evm|solana|ethereum|starknet|sui\b|cairo|nft|defi|token|crypto|chain\b/i],
  ["consumer", /consumer|social|community|marketplace|shop|retail|e-?commerce|lifestyle|creator|music|fashion|travel/i],
  ["games", /\bgames?\b|gaming|arcade|unity|godot|three\.js|phaser|play(er|able)?\b|tournament|battle/i],
  ["fullstack", /\bweb\b|next\.?js|react|full[- ]?stack|saas|api\b|backend|frontend|pwa|dashboard|app\b/i],
  ["dataviz", /visuali[sz]|dashboard|chart|analytics|\bdata\b|insight|report|bi\b|map\b/i],
  ["devtools", /dev ?tools?|developer|sdk|cli\b|devops|testing|ci\/cd|productivity|code review|lint|tooling|skill\b/i],
  ["privacy", /privacy|zero[- ]?knowledge|\bzk|fhe|mpc|encrypt|confidential|security|cryptograph/i],
  ["bio", /health|medical|bio|clinic|patient|wellness|mental|fitness|care\b/i],
  ["education", /educat|learn|student|school|course|tutor|e-?note|teach/i],
  ["impact", /impact|climate|sustainab|social good|accessib|nonprofit|agri|disaster|civic|government/i],
  ["writing", /writ(e|ing)|content|blog|docs|documentation|story|chapter|copy/i],
  ["ml", /machine learning|\bml\b|\bai\b|vision|opencv|model|neural|deep learning|nlp|speech|voice/i],
  ["hardware", /hardware|iot|robot|arduino|raspberry|embedded|drone|nas\b|micro ?mouse|sensor|ar\/vr|\bvr\b|headset|quest/i],
];

export function tagsOf(text: string): Tag[] {
  return RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
}

// What a hackathon implies the builder must own or access.
const NEEDS: [string, RegExp][] = [
  ["a VR headset", /\bvr\b|virtual reality|quest|ar\/vr|xr\b|mixed reality/i],
  ["NAS hardware", /\bnas\b/i],
  ["robot or IoT hardware", /robot|micro ?mouse|iot|arduino|raspberry|drone|embedded/i],
];

export function needsOf(text: string): string[] {
  return NEEDS.filter(([, re]) => re.test(text)).map(([n]) => n);
}
