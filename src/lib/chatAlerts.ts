import { supabase } from "./supabase";
import { deliver, messageSummary, pushConfig, throttled, type PushPayload, type Target } from "./push";
import { bumpPeople } from "./chatLive";

/**
 * Stayblz Chat alerts (migration 202611190003_chat_alerts.sql). After something happens in a chat, the route calls
 * one of these (fire and forget). The SQL saves one alert row per person who should hear about it (respecting mute,
 * blocks and stable membership) and returns their push devices; this file turns each alert into the words, link,
 * picture and tag of the notification and sends it.
 *
 * The same rows feed the bell list and the in-page poll, so what a phone shows and what the site shows always agree.
 */
export type ChatKind = "personal" | "team";
export type AlertKind =
  | "message"
  | "request"
  | "mention"
  | "reply"
  | "reaction"
  | "group_added"
  | "friend_request"
  | "friend_accepted"
  | "request_accepted";

export interface ChatAlert {
  id: string;
  userId: string;
  kind: AlertKind;
  chatKind: ChatKind | null;
  chatId: string | null;
  messageId: string | null;
  stableId: string | null;
  actorId: string | null;
  actorName: string;
  title: string | null;
  group: boolean;
  body: string;
  emoji: string | null;
  attachment: { type?: string; name?: string } | null;
  count: number;
}
interface NotifyResult {
  alerts?: ChatAlert[];
  targets?: (Target & { alertId: string })[];
}

const clip = (text: string, max = 80) => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);

/** Where tapping the alert goes: the chat (and the exact message), or People for friend requests. */
export function alertUrl(a: Pick<ChatAlert, "kind" | "chatKind" | "chatId" | "messageId" | "stableId">) {
  if (a.kind === "friend_request" || a.kind === "friend_accepted" || !a.chatId) return "/messages?people=1";
  const params = new URLSearchParams();
  if (a.chatKind === "team" && a.stableId) params.set("stable", a.stableId);
  if (a.messageId && a.kind !== "message" && a.kind !== "request") params.set("m", a.messageId);
  const query = params.toString();
  return `${a.chatKind === "team" ? "/team-messages" : "/messages"}/${a.chatId}${query ? `?${query}` : ""}`;
}

/** The file of a photo message, for the picture in the notification (members only; the service worker sends the cookie). */
function imageUrl(a: ChatAlert) {
  if (!a.chatId || !a.messageId || !a.attachment?.type?.startsWith("image/")) return undefined;
  return `/api/${a.chatKind === "team" ? "team-messages" : "messages"}/${a.chatId}/files/${a.messageId}`;
}

/** Title and text of the notification. With previews off, nothing from the message itself is shown. */
export function alertWords(a: ChatAlert, previews: boolean): { title: string; body: string } {
  const who = a.actorName || "Stayblz member";
  const where = a.group && a.title ? ` in ${clip(a.title, 60)}` : "";
  const said = messageSummary({ body: a.body, attachment: a.attachment });
  switch (a.kind) {
    case "message":
      if (!previews) return { title: a.group && a.title ? a.title : who, body: a.count > 1 ? `${a.count} new messages` : "New message" };
      return a.group ? { title: a.title || "Group chat", body: `${who}: ${said}` } : { title: who, body: said };
    case "request":
      return { title: who, body: previews ? `Message request: ${said}` : "Wants to send you a message" };
    case "mention":
      return { title: `${who} mentioned you${where}`, body: previews ? said : "Tap to see the message" };
    case "reply":
      return { title: `${who} replied to you${where}`, body: previews ? said : "Tap to see the reply" };
    case "reaction":
      return {
        title: `${who} reacted ${a.emoji ?? ""} to your message`.replace(/\s+/g, " "),
        body: previews ? `“${clip(said, 100)}”` : "Tap to see it",
      };
    case "group_added":
      return { title: `${who} added you to ${a.title ? clip(a.title, 60) : "a group"}`, body: "Tap to open the chat." };
    case "friend_request":
      return { title: `${who} wants to be friends`, body: "Accept or decline in Stayblz Chat → People." };
    case "friend_accepted":
      return { title: `${who} accepted your friend request`, body: "You can message each other any time." };
    case "request_accepted":
      return { title: `${who} accepted your message request`, body: "Your messages now go straight to their chats." };
  }
}

/** Same tag = the device replaces the earlier alert (new messages in one chat); separate tags stack. */
function alertTag(a: ChatAlert) {
  if (a.kind === "message" || a.kind === "request" || a.kind === "group_added") return `chat-${a.chatId}`;
  if (a.kind === "reaction") return `react-${a.messageId}`;
  if (a.kind.startsWith("friend")) return `friend-${a.actorId}`;
  return `${a.kind}-${a.id}`;
}

async function avatarPaths(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const { data } = await supabase.from("account_avatars").select("account_id,path").in("account_id", ids);
  return new Map<string, string>(
    (data ?? []).map((row: { account_id: string; path: string }) => [row.account_id, `/api/avatars/${row.account_id}/${row.path.slice(row.path.lastIndexOf("/") + 1)}`]),
  );
}

export function alertPayload(a: ChatAlert, previews: boolean, icon?: string): PushPayload {
  const words = alertWords(a, previews);
  return {
    kind: "chat",
    alert: a.kind,
    alertId: a.id,
    tag: alertTag(a),
    url: alertUrl(a),
    title: words.title,
    body: words.body,
    ...(icon ? { icon } : {}),
    ...(previews && imageUrl(a) ? { image: imageUrl(a) } : {}),
    ...(a.chatKind === "team" && a.stableId ? { stableId: a.stableId } : {}),
  };
}

async function send(result: NotifyResult | null) {
  const alerts = new Map((result?.alerts ?? []).map((a) => [a.id, a]));
  // A burst of messages in one chat buzzes each device once every few seconds; mentions, replies and the rest always go.
  const targets = (result?.targets ?? []).filter((t) => {
    const a = alerts.get(t.alertId);
    if (!a) return false;
    if (a.kind !== "message" && a.kind !== "request") return true;
    return !throttled(`${t.endpoint}:${a.chatId}`);
  });
  if (!targets.length) return 0;
  const icons = await avatarPaths([...new Set([...alerts.values()].map((a) => a.actorId).filter((id): id is string => !!id))]).catch(
    () => new Map<string, string>(),
  );
  return deliver(targets, (t) => {
    const a = alerts.get((t as Target & { alertId: string }).alertId)!;
    return alertPayload(a, t.previews !== false, a.actorId ? icons.get(a.actorId) : undefined);
  });
}

/** After a message, a reaction, or adding people to a group. Never throws; returns how many devices were alerted. */
export async function notifyChat(
  kind: ChatKind,
  conversationId: string,
  actorId: string,
  event: { type: "message"; messageId: string } | { type: "reaction"; messageId: string; emoji: string } | { type: "group_added"; ids: string[] },
) {
  try {
    const { data, error } = await supabase.rpc("chat_notify", {
      p_kind: kind,
      p_conversation: conversationId,
      p_actor: actorId,
      p_event: event,
    });
    if (error || !data) return 0;
    // Wake the site-wide poll of everyone who just got an alert (badge, bell, on-screen alert within a moment).
    bumpPeople(((data as NotifyResult).alerts ?? []).map((a) => a.userId));
    if (!pushConfig()) return 0;
    return await send(data as NotifyResult);
  } catch {
    return 0;
  }
}

/** Friend request, friend accepted, message request accepted. Never throws. */
export async function notifyPerson(
  actorId: string,
  targetId: string,
  type: "friend_request" | "friend_accepted" | "request_accepted",
  conversationId: string | null = null,
) {
  try {
    const { data, error } = await supabase.rpc("chat_notify_person", {
      p_actor: actorId,
      p_target: targetId,
      p_type: type,
      p_conversation: conversationId,
    });
    if (error || !data) return 0;
    // Wake the site-wide poll of everyone who just got an alert (badge, bell, on-screen alert within a moment).
    bumpPeople(((data as NotifyResult).alerts ?? []).map((a) => a.userId));
    if (!pushConfig()) return 0;
    return await send(data as NotifyResult);
  } catch {
    return 0;
  }
}
