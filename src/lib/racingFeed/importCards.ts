import { supabase } from "../supabase";
import { notifyRacing } from "../racingAlerts";
import { cardInput } from "./card";
import { cardsFromApifyEquibase, isApifyEquibase } from "./apifyEquibase";

/**
 * Racing data feed (docs/racing-data-feed.md). Every source becomes Stayblz cards (lib/racingFeed/card.ts), each
 * loaded atomically by SQL racing_feed_import; then followers are alerted exactly as for hand-entered data.
 */

/** A Stayblz feed file ({ cards: [...] }) or one of the co-dev's collected files → cards. */
export function cardsFromFile(data: any): { cards: unknown[]; format: string; unplacedHorses?: number } | { error: string } {
  if (Array.isArray(data?.cards)) return { cards: data.cards, format: "stayblz" };
  if (isApifyEquibase(data)) {
    const { cards, unplacedHorses } = cardsFromApifyEquibase(data);
    return { cards, format: "collected-equibase", unplacedHorses };
  }
  return { error: "That file isn't a racing data file Stayblz can read." };
}

const failures: Record<string, string> = {
  not_allowed: "Only admins can import racing data.",
  invalid_card: "The card is missing its source.",
};

export interface CardResult {
  ok: boolean;
  track: string;
  date: string;
  error?: string;
  skipped?: number;
  races?: number;
  runners?: number;
  officialRaces?: number;
  history?: number;
  workouts?: number;
  horsesCreated?: number;
  peopleCreated?: number;
  published?: boolean;
  dayId?: string;
  detail?: string;
}

/**
 * Imports cards one by one (a bad card never stops the others) and queues follower alerts.
 * actor: the admin importing, or null for the automatic puller.
 */
export async function importCards(actor: string | null, cards: unknown[], publish: boolean): Promise<CardResult[]> {
  const results: CardResult[] = [];
  for (const raw of cards) {
    const label = { track: String((raw as any)?.track?.code ?? "?").toUpperCase(), date: String((raw as any)?.date ?? "?") };
    const parsed = cardInput(raw);
    if ("error" in parsed) {
      results.push({ ok: false, ...label, error: parsed.error });
      continue;
    }
    const { data, error } = await supabase.rpc("racing_feed_import", { p_actor: actor, p_card: parsed.value, p_publish: publish });
    if (error || !data) {
      const message = String(error?.message ?? "");
      const known = Object.keys(failures).find((key) => message.includes(key));
      results.push({
        ok: false,
        ...label,
        error: known ? failures[known] : "This card couldn't be saved; nothing from it was changed.",
        // Offline checks (scripts/racing-feed-check.cjs) show the database's reason; the API never does.
        ...(process.env.RACING_FEED_DEBUG === "1" ? { detail: message.slice(0, 300) } : {}),
      });
      continue;
    }
    const { officialRaceIds = [], scratchedRunnerIds = [], workoutIds = [], ...summary } = data as Record<string, any>;
    results.push({ ok: true, ...label, ...summary, skipped: parsed.skipped });
    // Alerts: the SQL skips drafts, old history and anything already sent.
    if (summary.published) notifyRacing("day", summary.dayId);
    for (const id of scratchedRunnerIds) notifyRacing("scratch", id);
    for (const id of officialRaceIds) notifyRacing("race", id);
    for (const id of workoutIds) notifyRacing("workout", id);
  }
  return results;
}
