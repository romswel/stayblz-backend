import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads settings files into process.env before anything else runs:
 *  - `.env` in the folder the server starts from (local development), and
 *  - `/etc/secrets/.env` (a Render "Secret File" named `.env`).
 *
 * Settings already in the environment (Render's Environment tab, your shell) always win: a file
 * only fills in names that aren't set. Values are never logged; only the file and how many
 * settings it added.
 */
const FILES = [path.resolve(process.cwd(), ".env"), "/etc/secrets/.env"];

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      // Unquoted: a " #" starts a comment.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]] = value;
  }
  return out;
}

const seen = new Set<string>();
for (const file of FILES) {
  if (seen.has(file) || !existsSync(file)) continue;
  seen.add(file);
  try {
    const values = parse(readFileSync(file, "utf8"));
    let added = 0;
    for (const [name, value] of Object.entries(values)) {
      if (process.env[name] === undefined || process.env[name] === "") {
        process.env[name] = value;
        added++;
      }
    }
    console.info(`[env] loaded ${added} setting${added === 1 ? "" : "s"} from ${file}`);
  } catch {
    console.warn(`[env] couldn't read ${file}`);
  }
}
