// proactive/journal-sweep.ts — barrido dominical de entradas `Sin revisar`.
// Tercera excepción a la arquitectura reactiva de Jano (decisión de Cal, 2026-07-27).

import { sendCronMessage } from "./rich-send.js";
import type { CfKv } from "../cf-kv.js";
import { renderSweepSelector } from "../journal-card.js";
import { nowInLaPaz } from "../journal-capture.js";
import { queryUnreviewed } from "../tools/journal.js";

const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

export function sevenDaysAgo(now: Date = new Date()): string {
  return nowInLaPaz(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
}

export function sweepDedupKey(now: Date = new Date()): string {
  return `jano:journal:sweep:${nowInLaPaz(now).slice(0, 10)}`;
}

export interface SweepOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  log: (obj: Record<string, unknown>) => void;
}

export async function checkJournalSweep(opts: SweepOpts): Promise<void> {
  const { kv, botToken, chatId, log } = opts;
  const dedupKey = sweepDedupKey();

  try {
    if (await kv.get<boolean>(dedupKey)) return;

    const pendientes = queryUnreviewed(sevenDaysAgo());
    if (pendientes.length === 0) {
      await kv.set(dedupKey, true, DEDUP_TTL_SEC);
      log({ msg: "journal_sweep_empty" });
      return;
    }

    const card = renderSweepSelector(pendientes);
    await sendCronMessage(botToken, { chatId, text: card.text, replyMarkup: card.keyboard });
    await kv.set(dedupKey, true, DEDUP_TTL_SEC);
    log({ msg: "journal_sweep_sent", pendientes: pendientes.length });
  } catch (err) {
    // Mismo criterio que health-sync-check: no dejar escapar la excepción,
    // el caller la invoca con `void` desde un callback de cron.
    log({ msg: "journal_sweep_error", err: String(err) });
  }
}
