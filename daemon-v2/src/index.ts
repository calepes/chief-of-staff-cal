import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });

const env = {
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID ?? "",
  COS_TELEGRAM_BOT_TOKEN: process.env.COS_TELEGRAM_BOT_TOKEN ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
};

delete process.env.ANTHROPIC_API_KEY;

console.log(JSON.stringify({
  level: "info",
  msg: "cos-daemon-v2 boot stub",
  hasToken: env.COS_TELEGRAM_BOT_TOKEN.length > 0,
  hasCfApi: env.CF_ACCOUNT_ID.length > 0,
  ts: Date.now(),
}));

console.log(JSON.stringify({ level: "info", msg: "stub ready, awaiting Phase 3", ts: Date.now() }));
