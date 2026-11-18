import { supabase } from "./supabase";
import type { UpdateInput } from "./updateInput";

export { UPDATE_KINDS, UPDATE_TAGS, updateInput, slugify, type UpdateKind, type UpdateInput } from "./updateInput";

export class UpdateError extends Error {
  constructor(readonly code: "not_allowed" | "unknown_update" | "unknown_reaction" | "slug_taken" | "unavailable") {
    super(code);
  }
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const message = String(error.message ?? "");
    throw new UpdateError(
      message.includes("not_allowed")
        ? "not_allowed"
        : message.includes("unknown_reaction")
          ? "unknown_reaction"
          : message.includes("unknown_update")
          ? "unknown_update"
          : message.includes("site_updates_slug_key") || String((error as { code?: string }).code) === "23505"
            ? "slug_taken"
            : "unavailable",
    );
  }
  return data as T;
}

/** Overridable in tests. Reads and writes go through checked database functions. */
export const updateStore = {
  list: (opts: { members: boolean; kind: string | null; query: string | null; before: string | null; limit: number }) =>
    rpc<{ updates: unknown[]; pinned: unknown[]; hasMore: boolean }>("list_site_updates", {
      p_members: opts.members,
      p_kind: opts.kind,
      p_query: opts.query,
      p_before: opts.before,
      p_limit: opts.limit,
    }),
  get: (slug: string, members: boolean) =>
    rpc<{ update: unknown; newer: unknown; older: unknown } | null>("get_site_update", {
      p_slug: slug,
      p_members: members,
    }),
  adminList: () => rpc<unknown[]>("admin_list_site_updates", {}),
  save: (actor: string | null, id: string | null, value: UpdateInput) =>
    rpc<Record<string, unknown>>("save_site_update", { p_actor: actor, p_id: id, p_data: value }),
  remove: (actor: string, id: string) => rpc<boolean>("delete_site_update", { p_actor: actor, p_id: id }),
  /** Reaction counts for the posts this reader may see (and this account's own picks). */
  reactions: (slugs: string[], members: boolean, account: string | null) =>
    rpc<Record<string, ReactionSummary>>("site_update_reactions_for", {
      p_slugs: slugs,
      p_members: members,
      p_account: account,
    }),
  react: (account: string, slug: string, reaction: UpdateReaction, on: boolean) =>
    rpc<ReactionSummary | null>("react_to_site_update", {
      p_account: account,
      p_slug: slug,
      p_reaction: reaction,
      p_on: on,
    }),
};

/** The fixed reactions readers can leave on a post (the database checks the same list). */
export const UPDATE_REACTIONS = ["like", "celebrate", "love", "horse"] as const;
export type UpdateReaction = (typeof UPDATE_REACTIONS)[number];
export type ReactionSummary = { counts: Partial<Record<UpdateReaction, number>>; mine: UpdateReaction[] };
