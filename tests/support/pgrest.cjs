// Shared test-only PostgREST adapter: runs the application's real queries and
// database functions against an isolated in-memory PostgreSQL (PGlite).
// No provider or remote database is ever contacted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
let db;
const identifier = (v) => {
  assert.match(v, /^[a-z_]+$/);
  return '"' + v + '"';
};
// Lists of plain values become Postgres arrays; lists of objects stay JSON (like PostgREST).
const param = (v) =>
  Array.isArray(v) && v.every((item) => item === null || typeof item !== "object")
    ? "{" + v.join(",") + "}"
    : v && typeof v === "object"
      ? JSON.stringify(v)
      : v;
// A small test-only PostgREST adapter runs the application's real queries against
// an isolated PostgreSQL engine. No provider or remote database is contacted.
class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.max = null;
    this.mode = "select";
    this.one = false;
  }
  select(fields = "*", options = {}) {
    this.count = options.count;
    this.fields = fields;
    return this;
  }
  eq(k, v) {
    this.filters.push([k, "=", v]);
    return this;
  }
  neq(k, v) {
    this.filters.push([k, "<>", v]);
    return this;
  }
  gt(k, v) {
    this.filters.push([k, ">", v]);
    return this;
  }
  gte(k, v) {
    this.filters.push([k, ">=", v]);
    return this;
  }
  ilike(k, v) {
    this.filters.push([k, "ilike", v]);
    return this;
  }
  lte(k, v) {
    this.filters.push([k, "<=", v]);
    return this;
  }
  lt(k, v) {
    this.filters.push([k, "<", v]);
    return this;
  }
  is(k, v) {
    assert.equal(v, null);
    this.filters.push([k, "is", null]);
    return this;
  }
  in(k, v) {
    this.filters.push([k, "in", v]);
    return this;
  }
  contains(k, v) {
    this.filters.push([k, "@>", v]);
    return this;
  }
  order(k, o = {}) {
    this.orders.push(
      identifier(k) + (o.ascending === false ? " desc" : " asc"),
    );
    return this;
  }
  limit(n) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.one = true;
    return this;
  }
  single() {
    this.one = true;
    return this;
  }
  insert(data) {
    this.mode = "insert";
    this.input = data;
    return this;
  }
  update(data) {
    this.mode = "update";
    this.input = data;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  upsert(data, options) {
    this.mode = "upsert";
    this.input = data;
    this.conflict = options.onConflict;
    return this;
  }
  or(value) {
    const match = value.match(
      /^sent_at.lt.(.+),and\(sent_at.eq.(.+),id.lt.([0-9a-f-]+)\)$/,
    );
    assert.ok(match);
    this.cursor = [match[1], match[3]];
    return this;
  }
  async execute() {
    try {
      const values = [];
      const bind = (value) => {
        values.push(param(value));
        return "$" + values.length;
      };
      const table = "public." + identifier(this.table);
      let sql;
      if (this.mode === "insert" || this.mode === "upsert") {
        const columns = Object.keys(this.input);
        sql = `insert into ${table} (${columns.map(identifier)}) values (${columns.map((k) => bind(this.input[k]))})`;
        if (this.mode === "upsert")
          sql +=
            ` on conflict (${this.conflict.split(",").map(identifier)}) do update set ` +
            columns
              .filter((k) => !this.conflict.split(",").includes(k))
              .map((k) => `${identifier(k)}=excluded.${identifier(k)}`)
              .join(",");
      } else if (this.mode === "update")
        sql =
          `update ${table} set ` +
          Object.entries(this.input)
            .map(([k, v]) => `${identifier(k)}=${bind(v)}`)
            .join(",");
      else
        sql =
          this.mode === "delete"
            ? `delete from ${table}`
            : `select * from ${table}`;
      const where = this.filters.map(([key, op, value]) =>
        op === "in"
          ? `${identifier(key)}::text = any(${bind(value)}::text[])`
          : op === "is"
            ? `${identifier(key)} is null`
            : `${identifier(key)} ${op} ${bind(value)}`,
      );
      if (this.cursor) {
        const time = bind(this.cursor[0]),
          id = bind(this.cursor[1]);
        where.push(`(sent_at<${time} or (sent_at=${time} and id<${id}))`);
      }
      if (where.length) sql += " where " + where.join(" and ");
      if (this.mode === "select") {
        if (this.orders.length) sql += " order by " + this.orders.join(",");
        if (this.max !== null) sql += " limit " + this.max;
      } else sql += " returning *";
      let { rows } = await db.query(sql, values);
      // PostgREST returns timestamps as ISO strings rather than JS Date objects.
      rows = JSON.parse(JSON.stringify(rows));
      if (this.fields?.includes("member_stables("))
        for (const row of rows) {
          row.member_stables = (
            await db.query("select id,name from member_stables where id=$1", [
              row.stable_id,
            ])
          ).rows[0];
        }
      return {
        data: this.one ? (rows[0] ?? null) : rows,
        error: null,
        count: rows.length,
      };
    } catch (error) {
      return { data: null, error };
    }
  }
  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

const MIGRATIONS = [
  "202611010001_site_racing_records.sql",
  "202611030001_member_workspaces.sql",
  "202611030002_personal_racing.sql",
  "202611090001_account_foundation.sql",
  "202611090002_rls_guard.sql",
  "202611100001_community_profiles.sql",
  "202611100002_updates_preferences.sql",
  "202611100003_site_updates.sql",
  "202611100004_drop_bulletin_seen.sql",
  "202611100005_racing_core.sql",
  "202611110001_messenger.sql",
  "202611120001_chat_v2.sql",
  "202611140001_marketplace.sql",
  "202611140002_paddock.sql",
];

/** Creates a fresh database with every migration and points `supabase` at it. */
async function installDatabase(supabase) {
  db = new PGlite();
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}',raw_app_meta_data jsonb not null default '{}');" +
      "create role anon;create role authenticated;create role service_role bypassrls;",
  );
  for (const file of MIGRATIONS)
    await db.exec(fs.readFileSync("migrations/" + file, "utf8"));
  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  supabase.from = (table) => new Query(table);
  supabase.rpc = async (name, args) => {
    try {
      const values = Object.values(args).map(param);
      const { rows } = await db.query(
        `select * from public.${identifier(name)}(${values.map((_, i) => "$" + (i + 1))})`,
        values,
      );
      const row = rows[0];
      const data =
        row && Object.keys(row).length === 1 && name in row ? row[name] : row;
      return { data: JSON.parse(JSON.stringify(data ?? null)), error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
  return {
    db,
    async close() {
      supabase.from = originalFrom;
      supabase.rpc = originalRpc;
      await db.close();
    },
  };
}

module.exports = { installDatabase, param };
