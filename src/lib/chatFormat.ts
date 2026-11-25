/**
 * Stayblz Chat formatting as plain data (no React): **bold**, _italic_ or *italic*, ***bold italic***, ~~strike~~,
 * `code`, ```code blocks```, ||spoilers||, > quotes, - bullets, 1. numbered lists, and the message-level marks
 * "@highlight" and "/me". The app draws messages from this (chatMarkdown.tsx); plainText() is the wording for the chat
 * list, banners, quotes and alerts.
 *
 * ONE FILE, TWO COPIES, word for word: stayblz-frontend/src/components/messenger/chatFormat.ts and
 * stayblz-backend/src/lib/chatFormat.ts (push notifications). Change both together; each repo's tests check the same
 * examples, and `diff --strip-trailing-cr` of the two files must be empty.
 *
 * Ordinary symbols stay safe:
 *  - A mark needs words inside it. "****", "***", "~~~~", "||||", "` `" or a lone "```" or ">" stay exactly as typed.
 *  - The opening mark must touch a word ("** hi**" stays as typed). A space before the closing mark is fine
 *    ("**hi **" is bold): phone keyboards add one after a suggested word.
 *  - Underscores inside words (snake_case), "2*3*4" and anything inside a web link are left alone.
 *  - Nothing ever comes out blank: if the formatting would leave nothing to read, the message is shown as typed.
 */

export type InlineKind = "code" | "spoiler" | "bolditalic" | "bold" | "strike" | "italic";
export type InlineNode = string | { kind: "code"; text: string } | { kind: Exclude<InlineKind, "code">; children: InlineNode[] };

export type Block =
  | { type: "text"; lines: string[] }
  | { type: "code"; text: string }
  | { type: "quote"; lines: string[]; raw: string[] }
  | { type: "list"; ordered: boolean; start: number; items: string[] };

/** A web link (it never ends in punctuation). */
const URLS = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const HOLD = /\u0001(\d+)\u0002/g;
/** A formatting mark that can sit right before a link and close right after it. */
const MARK_BEFORE = /(\*{1,3}|_{1,2}|~~|\|\||`)$/;

/**
 * Web links are set aside (as \u0001n\u0002) so the marks inside them (snake_case_paths, *s) are never read. A mark that
 * opens right before a link and repeats at its end belongs to the formatting ("**https://x.com**" = a bold link); a link
 * that simply ends in "_" or "*" keeps it.
 */
export function holdUrls(text: string, urls: string[]) {
  return text.replace(URLS, (url: string, at: number) => {
    const mark = MARK_BEFORE.exec(text.slice(Math.max(0, at - 3), at))?.[1];
    const closes = !!mark && url.length > mark.length && url.endsWith(mark);
    const link = closes ? url.slice(0, -mark!.length) : url;
    return `\u0001${urls.push(link) - 1}\u0002${closes ? mark : ""}`;
  });
}
export function restoreUrls(text: string, urls: string[]) {
  return text.replace(HOLD, (_, i) => urls[Number(i)] ?? "");
}

/** Message-level marks: highlighted? an action line? and the text left to show. */
export function chatMarks(body: string) {
  let text = body;
  const highlight = /(^|\s)@highlight\b/i.test(text);
  if (highlight) text = text.replace(/(^|\s)@highlight\b[ \t]*/gi, "$1").replace(/^\s+/, "");
  const me = /^\/me\s+\S/i.test(text);
  if (me) text = text.replace(/^\/me\s+/i, "");
  return { highlight, me, text };
}

/** The GIF picture for a message that is only a GIF link, or null. GIPHY page links become their media link. */
export function gifUrl(body: string): string | null {
  const t = body.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/[\w./?=&%-]+$/i.test(t)) return t;
  // Only hosts the site's Content-Security-Policy allows (vercel.json img-src).
  if (/^https:\/\/media\.tenor\.com\/[\w./-]+\.(?:gif|webp)$/i.test(t)) return t;
  const page = /^https:\/\/giphy\.com\/gifs\/(?:[\w-]+-)?([A-Za-z0-9]{6,40})\/?$/i.exec(t);
  return page ? `https://media.giphy.com/media/${page[1]}/giphy.gif` : null;
}

/**
 * Inline marks, earliest match wins (ties: in this order). Group 1 = the character before the mark (kept as text),
 * group 2 = what's inside. No lookbehind (`(?<!…)`): iPhones before iOS 16.4 can't even load a script that has one.
 */
const INLINE: { kind: InlineKind; re: RegExp }[] = [
  { kind: "code", re: /()`([^`\n]+)`/g },
  { kind: "spoiler", re: /()\|\|(?=\S)([\s\S]*?)[ \t]*\|\|/g },
  { kind: "bolditalic", re: /()\*\*\*(?=\S)([\s\S]*?)[ \t]*\*\*\*(?!\*)/g },
  { kind: "bold", re: /()\*\*(?=\S)([\s\S]*?)[ \t]*\*\*/g },
  { kind: "bold", re: /(^|[^\w])__(?=\S)([\s\S]*?)[ \t]*__(?!\w)/g },
  { kind: "strike", re: /()~~(?=\S)([\s\S]*?)[ \t]*~~/g },
  { kind: "italic", re: /(^|[^\w*])\*(?=[^\s*])([^*\n]*?)[ \t]*\*(?![\w*])/g },
  { kind: "italic", re: /(^|[^\w])_(?=[^\s_])([^_\n]*?)[ \t]*_(?!\w)/g },
];
/** Something to read inside a mark: a letter, digit, emoji, link… (not only spaces or other marks). */
const WORDS = /[^\s*_~|`]/;

/** The first inline mark in `text` that has something inside it, or null. */
export function findInline(text: string): { kind: InlineKind; start: number; end: number; inner: string } | null {
  let best: { kind: InlineKind; start: number; end: number; inner: string } | null = null;
  for (const rule of INLINE) {
    rule.re.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = rule.re.exec(text))) {
      const start = found.index + found[1].length;
      if (best && start >= best.start) break; // can't beat what we have
      const inner = found[2];
      if (rule.kind === "code" ? inner.trim() : WORDS.test(inner)) {
        best = { kind: rule.kind, start, end: found.index + found[0].length, inner };
        break;
      }
      rule.re.lastIndex = found.index + 1; // empty inside ("****"): look further along
    }
  }
  return best;
}

/** Text → plain strings and marked pieces (nested marks inside, up to a few levels). */
export function parseInline(text: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = [];
  let rest = text;
  while (rest) {
    const found = depth > 6 ? null : findInline(rest);
    if (!found) {
      out.push(rest);
      break;
    }
    if (found.start > 0) out.push(rest.slice(0, found.start));
    out.push(found.kind === "code" ? { kind: "code", text: found.inner } : { kind: found.kind, children: parseInline(found.inner, depth + 1) });
    rest = rest.slice(found.end);
  }
  return out;
}

const BULLET = /^[ \t]{0,3}[-*•][ \t]+(\S.*)$/;
const NUMBER = /^[ \t]{0,3}(\d{1,3})[.)][ \t]+(\S.*)$/;
const QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const FENCE = /^[ \t]*```(.*)$/;
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/;
/** A common code language name at the start of a one-line code block, followed by the code itself. */
const LANGUAGE =
  /^(?:js|jsx|ts|tsx|javascript|typescript|json|html|css|scss|sql|sh|bash|shell|ps1|powershell|py|python|rb|ruby|php|java|kotlin|swift|go|rust|c|cpp|cs|csharp|xml|yaml|yml|md|markdown|txt|text|csv|diff)[ \t]+(?=\S)/i;

/** Lines → text, code blocks, quotes and lists. Anything that would be empty is kept as typed text. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      // ```code``` on one line, or a fenced block up to the closing ``` (or the end). "```js" names a language.
      const sameLine = /^[ \t]*```([\s\S]*?)```[ \t]*$/.exec(line);
      if (sameLine && sameLine[1].trim()) {
        // "```js const a = 1```": a code block squeezed onto one line (alert texts are) keeps no language name.
        out.push({ type: "code", text: sameLine[1].replace(LANGUAGE, "") });
        continue;
      }
      const head = fence[1];
      if (!head.includes("`")) {
        const body: string[] = /^[\w+-]*[ \t]*$/.test(head) ? [] : [head];
        let j = i + 1;
        while (j < lines.length && !FENCE_CLOSE.test(lines[j])) body.push(lines[j++]);
        if (body.join("\n").trim()) {
          out.push({ type: "code", text: body.join("\n") });
          i = j;
          continue;
        }
      }
      // Nothing inside (a lone ``` or ````): shown as typed below.
    } else {
      const quote = QUOTE.exec(line);
      if (quote) {
        const last = out[out.length - 1];
        if (last?.type === "quote") {
          last.lines.push(quote[1]);
          last.raw.push(line);
        } else out.push({ type: "quote", lines: [quote[1]], raw: [line] });
        continue;
      }
      const bullet = BULLET.exec(line);
      const number = bullet ? null : NUMBER.exec(line);
      if (bullet || number) {
        const ordered = !!number;
        const item = bullet ? bullet[1] : number![2];
        const last = out[out.length - 1];
        if (last?.type === "list" && last.ordered === ordered) last.items.push(item);
        else out.push({ type: "list", ordered, start: number ? Number(number[1]) : 1, items: [item] });
        continue;
      }
    }
    const last = out[out.length - 1];
    if (last?.type === "text") last.lines.push(line);
    else out.push({ type: "text", lines: [line] });
  }
  // A quote with nothing in it (a lone ">") is just the character; neighbouring text joins up again.
  const merged: Block[] = [];
  for (const b of out) {
    const block: Block = b.type === "quote" && !b.lines.some((l) => l.trim()) ? { type: "text", lines: b.raw } : b;
    const last = merged[merged.length - 1];
    if (block.type === "text" && last?.type === "text") last.lines.push(...block.lines);
    else merged.push(block);
  }
  return merged;
}

/** Marked pieces → their words (spoilers stay hidden). */
export function inlinePlain(nodes: InlineNode[]): string {
  return nodes
    .map((n) => (typeof n === "string" ? n : n.kind === "code" ? n.text : n.kind === "spoiler" ? "(spoiler)" : inlinePlain(n.children)))
    .join("");
}
export function blocksPlain(blocks: Block[]): string {
  return blocks
    .map((b) =>
      b.type === "code"
        ? b.text
        : b.type === "list"
          ? b.items.map((item) => inlinePlain(parseInline(item))).join("\n")
          : inlinePlain(parseInline(b.lines.join("\n"))),
    )
    .join("\n");
}

/** The message as plain words (chat list, quotes, banners, alerts): formatting marks dropped, spoilers kept hidden. */
export function plainText(body: string): string {
  if (gifUrl(body)) return "GIF";
  const { text } = chatMarks(body);
  const urls: string[] = [];
  const plain = restoreUrls(blocksPlain(parseBlocks(holdUrls(text, urls))), urls).trim();
  // Never blank: a message that is only "@highlight" (or only marks) reads as typed.
  return plain || text.trim() || body.trim();
}

/** Would this text look different once sent (bold, a list, a spoiler, @highlight…)? Drives the composer's preview. */
export function hasFormatting(body: string): boolean {
  if (!body.trim() || gifUrl(body)) return false;
  const marks = chatMarks(body);
  if (marks.highlight || marks.me) return true;
  return parseBlocks(holdUrls(marks.text, [])).some((b) => b.type !== "text" || !!findInline(b.lines.join("\n")));
}
