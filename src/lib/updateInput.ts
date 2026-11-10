/** Stayblz Updates: release notes, announcements, news, maintenance and events. */
export const UPDATE_KINDS = ["update", "announcement", "news", "maintenance", "event"] as const;
export const UPDATE_TAGS = ["new", "improved", "fixed", "security", "notice"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];

export interface UpdateInput {
  slug: string;
  kind: UpdateKind;
  title: string;
  summary: string;
  body: string;
  items: { tag: (typeof UPDATE_TAGS)[number]; text: string }[];
  version: string;
  audience: "public" | "members";
  pinned: boolean;
  popup: boolean;
  status: "draft" | "published" | "archived";
  authorLabel: string;
  publishedAt?: string;
}

// Plain text only: no control characters (newlines are allowed in the post text) and no
// "<", so nothing can be read as HTML even by a careless renderer later. The post text may
// use ">" for quotes; single-line fields refuse both brackets.
const unsafeLine = /[\u0000-\u001f\u007f<>]/;
const unsafeBlock = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<]/;

const text = (value: unknown, max: number, { required = false, multiline = false } = {}) => {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const cleaned = multiline ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
  if ((required && !cleaned) || cleaned.length > max) return null;
  if ((multiline ? unsafeBlock : unsafeLine).test(cleaned)) return null;
  return cleaned;
};

/** Addresses under /updates/ that belong to app pages, not posts. */
export const RESERVED_SLUGS = ["manage"];

export const slugify =(value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

/** Validates an Update from the admin editor. Returns an error message or the clean post. */
export function updateInput(body: unknown): { error: string } | { value: UpdateInput } {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const title = text(input.title, 140, { required: true });
  if (title === null) return { error: "Give the post a title (up to 140 characters, no < or >)." };
  const summary = text(input.summary, 400);
  if (summary === null) return { error: "The summary can be up to 400 characters, without < or >." };
  const postBody = text(input.body, 20000, { multiline: true });
  if (postBody === null) return { error: "The post text can be up to 20,000 characters, without the < character." };
  const version = text(input.version, 20);
  if (version === null) return { error: "The version label can be up to 20 characters." };
  const authorLabel = text(input.authorLabel, 80);
  if (authorLabel === null) return { error: "The author name can be up to 80 characters." };
  const kind = input.kind ?? "update";
  if (!UPDATE_KINDS.includes(kind as UpdateKind)) return { error: "Choose a post type." };
  const audience = input.audience ?? "public";
  if (audience !== "public" && audience !== "members") return { error: "Choose who can read this post." };
  const status = input.status ?? "draft";
  if (status !== "draft" && status !== "published" && status !== "archived")
    return { error: "Choose draft, published or archived." };
  for (const flag of ["pinned", "popup"] as const)
    if (input[flag] !== undefined && typeof input[flag] !== "boolean") return { error: "Invalid option." };
  const rawItems = input.items ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > 40) return { error: "Use up to 40 change lines." };
  const items: UpdateInput["items"] = [];
  for (const item of rawItems) {
    const tag = (item as { tag?: unknown })?.tag;
    const line = text((item as { text?: unknown })?.text, 400);
    if (!UPDATE_TAGS.includes(tag as (typeof UPDATE_TAGS)[number]) || !line)
      return { error: "Each change line needs a label and up to 400 characters of text." };
    items.push({ tag: tag as UpdateInput["items"][number]["tag"], text: line });
  }
  if (!summary && !postBody && !items.length)
    return { error: "Add a summary, some text or at least one change line." };
  const slug = input.slug === undefined || input.slug === "" ? slugify(title) : input.slug;
  if (typeof slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80)
    return { error: "The web address can use lowercase letters, numbers and single dashes (up to 80)." };
  // "/updates/manage" is the admin page in the app, so a post can't use that address.
  if (RESERVED_SLUGS.includes(slug))
    return { error: `The web address "${slug}" is used by the site. Choose another one.` };
  let publishedAt: string | undefined;
  if (input.publishedAt !== undefined && input.publishedAt !== null && input.publishedAt !== "") {
    const when = typeof input.publishedAt === "string" ? new Date(input.publishedAt) : null;
    if (!when || Number.isNaN(when.getTime()) || when.getFullYear() < 2020 || when.getFullYear() > 2100)
      return { error: "Choose a valid publish date." };
    publishedAt = when.toISOString();
  }
  return {
    value: {
      slug,
      kind: kind as UpdateKind,
      title,
      summary,
      body: postBody,
      items,
      version,
      audience,
      pinned: input.pinned === true,
      popup: input.popup !== false,
      status,
      authorLabel: authorLabel || "Stayblz team",
      ...(publishedAt ? { publishedAt } : {}),
    },
  };
}
