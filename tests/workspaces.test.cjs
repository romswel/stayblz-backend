const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222",
  carol = "33333333-3333-4333-8333-333333333333",
  admin = "44444444-4444-4444-8444-444444444444";
let db,
  server,
  origin,
  stableA,
  stableB,
  horseA,
  conversation,
  originalFrom,
  originalRpc;
const tokens = new Map();
let personalConversation;
const identifier = (v) => {
  assert.match(v, /^[a-z_]+$/);
  return '"' + v + '"';
};
const param = (v) =>
  Array.isArray(v)
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
          ? `${identifier(key)} = any(${bind(value)}::text[])`
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
before(async () => {
  db = new PGlite();
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  for (const file of [
    "202611010001_site_racing_records.sql",
    "202611030001_member_workspaces.sql",
    "202611030002_personal_racing.sql",
  ])
    await db.exec(fs.readFileSync("migrations/" + file, "utf8"));
  for (const id of [alice, bob, carol, admin]) {
    await db.query("insert into auth.users values($1)", [id]);
    tokens.set(
      id,
      auth.createSession({
        id,
        username: id,
        displayName: id === alice ? "Alice" : id === bob ? "Bob" : "Teammate",
        role: id === admin ? "superadmin" : "member",
        email: id + "@example.test",
      }),
    );
  }
  originalFrom = supabase.from;
  originalRpc = supabase.rpc;
  supabase.from = (table) => new Query(table);
  supabase.rpc = async (name, args) => {
    try {
      const values = Object.values(args).map(param);
      const { rows } = await db.query(
        `select * from public.${identifier(name)}(${values.map((_, i) => "$" + (i + 1))})`,
        values,
      );
      return { data: rows[0]?.[name] ?? rows[0], error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  supabase.from = originalFrom;
  supabase.rpc = originalRpc;
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});
async function call(user, path, { stable, body, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: "Bearer " + tokens.get(user),
      "Content-Type": "application/json",
      ...(stable ? { "X-Stayblz-Stable": stable } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

test("ordinary accounts create owned stables without gaining platform admin", async () => {
  let r = await call(alice, "/api/workspaces", {
    body: { name: "Alice stable", owner_id: bob, role: "superadmin" },
  });
  assert.equal(r.status, 201);
  stableA = r.data.stable.id;
  assert.equal(r.data.stable.role, "owner");
  r = await call(bob, "/api/workspaces", { body: { name: "Bob stable" } });
  assert.equal(r.status, 201);
  stableB = r.data.stable.id;
  r = await call(alice, "/api/workspaces");
  assert.deepEqual(
    r.data.stables.map((s) => s.id),
    [stableA],
  );
  assert.equal((await call(alice, "/api/admin/stables")).status, 403);
  assert.equal((await call(admin, "/api/admin/stables")).status, 200);
});
test("membership is required for every stable route including direct IDs and superadmins", async () => {
  const r = await call(alice, "/api/inventory", {
    stable: stableA,
    body: { horseName: "Owned Horse", stable_id: stableB, created_by: bob },
  });
  assert.equal(r.status, 201);
  horseA = r.data.item.id;
  for (const user of [bob, admin])
    for (const path of [
      "/api/inventory",
      "/api/inventory/" + horseA,
      "/api/horses/" + horseA,
      "/api/feed",
      "/api/team-messages",
      "/api/workspaces/members",
    ])
      assert.equal(
        (await call(user, path, { stable: stableA })).status,
        403,
        path,
      );
  assert.equal(
    (await call(bob, "/api/inventory/" + horseA, { stable: stableB })).status,
    404,
  );
  assert.equal(
    (
      await call(bob, "/api/horses/" + horseA, {
        stable: stableB,
        method: "PATCH",
        body: { status: "Recovering" },
      })
    ).status,
    404,
  );
  const owned = await db.query(
    "select stable_id,created_by from member_horses where id=$1",
    [horseA],
  );
  assert.equal(owned.rows[0].stable_id, stableA);
  assert.equal(owned.rows[0].created_by, alice);
});
test("invites are email-bound, one-use and never expose stored tokens; members cannot escalate roles", async () => {
  const r = await call(alice, "/api/workspaces/invitations", {
    stable: stableA,
    body: { email: bob + "@example.test", role: "member" },
  });
  assert.equal(r.status, 201);
  const token = r.data.token;
  assert.equal(
    (
      await call(carol, "/api/workspaces/accept-invitation", {
        body: { token },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(bob, "/api/workspaces/accept-invitation", { body: { token } }))
      .status,
    200,
  );
  assert.equal(
    (await call(bob, "/api/workspaces/accept-invitation", { body: { token } }))
      .status,
    400,
  );
  const saved = (
    await db.query("select token_hash from stable_invitations where id=$1", [
      r.data.invitation.id,
    ])
  ).rows[0];
  assert.notEqual(saved.token_hash, token);
  assert.equal(
    (
      await call(bob, "/api/workspaces/invitations", {
        stable: stableA,
        body: { email: carol + "@example.test", role: "manager" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(bob, "/api/workspaces/members/" + bob, {
        stable: stableA,
        method: "PATCH",
        body: { role: "manager" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(bob, "/api/inventory", {
        stable: stableA,
        body: { horseName: "No permission" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(bob, "/api/inventory", { stable: stableA })).data.items.length,
    1,
  );
});
test("authorized members can post with server-owned authorship and message only participants", async () => {
  let r = await call(bob, "/api/feed", {
    stable: stableA,
    body: {
      body: "Team update",
      author: "Alice",
      role: "owner",
      stable_id: stableB,
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.post.author, "Bob");
  assert.equal(r.data.post.role, "member");
  r = await call(alice, "/api/team-messages", {
    stable: stableA,
    body: { title: "Private notes", memberIds: [] },
  });
  assert.equal(r.status, 201);
  const privateId = r.data.conversation.id;
  await db.query(
    "insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,'Platform admin','manager')",
    [stableA, admin],
  );
  assert.equal(
    (await call(admin, "/api/team-messages/" + privateId, { stable: stableA }))
      .status,
    404,
  );
  const bobPrivate = await call(bob, "/api/team-messages", {
    stable: stableA,
    body: { title: "Bob private notes", memberIds: [] },
  });
  assert.equal(bobPrivate.status, 201);
  assert.equal(
    (
      await call(
        alice,
        "/api/team-messages/" + bobPrivate.data.conversation.id,
        {
          stable: stableA,
        },
      )
    ).status,
    404,
  );
  await db.query(
    "delete from stable_memberships where stable_id=$1 and user_id=$2",
    [stableA, admin],
  );
  assert.equal(
    (await call(bob, "/api/team-messages/" + privateId, { stable: stableA }))
      .status,
    404,
  );
  assert.equal(
    (
      await call(bob, "/api/team-messages/" + privateId + "/messages", {
        stable: stableA,
        body: { body: "Unauthorized", clientId: crypto.randomUUID() },
      })
    ).status,
    404,
  );
  r = await call(alice, "/api/team-messages", {
    stable: stableA,
    body: { title: "Team conversation", memberIds: [bob] },
  });
  assert.equal(r.status, 201);
  conversation = r.data.conversation.id;
  const clientId = crypto.randomUUID();
  r = await call(bob, "/api/team-messages/" + conversation + "/messages", {
    stable: stableA,
    body: { body: "Saved message", clientId, sender_id: alice },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.mine, true);
  assert.equal(r.data.message.from, "Bob");
  const id = r.data.message.id;
  r = await call(bob, "/api/team-messages/" + conversation + "/messages", {
    stable: stableA,
    body: { body: "Saved message", clientId },
  });
  assert.equal(r.data.message.id, id);
  r = await call(alice, "/api/team-messages/" + conversation, {
    stable: stableA,
  });
  assert.equal(r.data.conversation.messages.length, 1);
  assert.equal(r.data.conversation.messages[0].mine, false);
  assert.equal(
    (
      await call(alice, "/api/team-messages", {
        stable: stableA,
        body: { title: "Invalid recipient", memberIds: [carol] },
      })
    ).status,
    400,
  );
});
test("owners manage stable roles; removing a member ends access immediately", async () => {
  assert.equal(
    (
      await call(alice, "/api/workspaces/members/" + bob, {
        stable: stableA,
        method: "PATCH",
        body: { role: "manager" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(bob, "/api/horses/" + horseA, {
        stable: stableA,
        method: "PATCH",
        body: { status: "In training", condition: 85 },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(bob, "/api/workspaces/members/" + alice + "/remove", {
        stable: stableA,
        body: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(alice, "/api/workspaces/members/" + bob + "/remove", {
        stable: stableA,
        body: {},
      })
    ).status,
    200,
  );
  for (const path of [
    "/api/feed",
    "/api/inventory",
    "/api/team-messages/" + conversation,
  ])
    assert.equal((await call(bob, path, { stable: stableA })).status, 403);
});
test("expired, revoked and former-manager invitations cannot grant access", async () => {
  for (const mode of ["expired", "revoked", "former-manager"]) {
    let r = await call(alice, "/api/workspaces/invitations", {
      stable: stableA,
      body: { email: carol + "@example.test" },
    });
    const { token, invitation } = r.data;
    if (mode === "expired")
      await db.query(
        "update stable_invitations set expires_at=now()-interval '1 second' where id=$1",
        [invitation.id],
      );
    if (mode === "revoked")
      await call(
        alice,
        "/api/workspaces/invitations/" + invitation.id + "/revoke",
        { stable: stableA, body: {} },
      );
    if (mode === "former-manager")
      await db.query(
        "update stable_invitations set invited_by=$1 where id=$2",
        [bob, invitation.id],
      );
    assert.equal(
      (
        await call(carol, "/api/workspaces/accept-invitation", {
          body: { token },
        })
      ).status,
      400,
      mode,
    );
  }
});
test("watch preferences persist per account and cannot mutate another user’s watchlist", async () => {
  const id = crypto.randomUUID();
  await db.query(
    "insert into site_racing_records(id,kind,payload,publication_status,published_at) values($1,'horses',$2,'published',now())",
    [
      id,
      JSON.stringify({
        name: "Published Horse",
        starts: 2,
        wins: 1,
        figure: 95,
      }),
    ],
  );
  assert.equal(
    (
      await call(alice, "/api/watchlist/toggle", {
        body: { id, watched: true, user_id: bob },
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(alice, "/api/watchlist")).data.stable.find((r) => r.id === id)
      .watched,
    true,
  );
  assert.equal(
    (await call(bob, "/api/watchlist")).data.stable.find((r) => r.id === id)
      .watched,
    false,
  );
  await call(bob, "/api/watchlist/toggle", {
    body: { id, watched: false, user_id: alice },
  });
  assert.equal(
    (await call(alice, "/api/watchlist")).data.stable.find((r) => r.id === id)
      .watched,
    true,
  );
});
test("browser database roles cannot read private tables or execute service functions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      await assert.rejects(
        db.query("select * from public.member_horses"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("select public.create_member_stable($1,$2,$3)", [
          carol,
          "Forbidden",
          "Carol",
        ]),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
});

test("message pagination preserves every message when timestamps are equal", async () => {
  await db.query(
    "insert into member_messages(conversation_id,sender_id,sender,body,client_id,sent_at) select $1,$2,'Alice','History '||n,gen_random_uuid(),'2020-01-01T00:00:00Z'::timestamptz from generate_series(1,101) n",
    [conversation, alice],
  );
  const first = await call(alice, "/api/team-messages/" + conversation, {
    stable: stableA,
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.conversation.messages.length, 100);
  assert.ok(first.data.before);
  const second = await call(
    alice,
    "/api/team-messages/" +
      conversation +
      "?before=" +
      encodeURIComponent(first.data.before.replace(/Z\|/, "+00:00|")),
    { stable: stableA },
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.before, null);
  const ids = [
    ...first.data.conversation.messages,
    ...second.data.conversation.messages,
  ].map((m) => m.id);
  assert.equal(ids.length, 102);
  assert.equal(new Set(ids).size, 102);
});
test("missing stable services fail closed without falling back to legacy data", async () => {
  const original = supabase.from;
  supabase.from = () => {
    throw Error("private provider detail");
  };
  try {
    const r = await call(alice, "/api/inventory", { stable: stableA });
    assert.equal(r.status, 503);
    assert.equal(
      JSON.stringify(r.data).includes("private provider detail"),
      false,
    );
  } finally {
    supabase.from = original;
  }
});

test("personal messaging works without a stable and ignores forged participant identities", async () => {
  assert.equal(
    (
      await db.query(
        "select count(*) from stable_memberships where user_id=$1",
        [carol],
      )
    ).rows[0].count,
    0,
  );
  assert.equal((await call(carol, "/api/messages")).status, 200);
  const r = await call(carol, "/api/messages", {
    body: {
      title: "Personal racing chat",
      memberIds: [alice],
      created_by: alice,
    },
  });
  assert.equal(r.status, 201);
  personalConversation = r.data.conversation.id;
  assert.equal(r.data.conversation.canInvite, true);
  assert.equal(r.data.conversation.participants.length, 1);
  for (const id of [alice, bob, admin])
    assert.equal(
      (await call(id, "/api/messages/" + personalConversation)).status,
      404,
    );
});
test("personal invitations are recipient-bound and grant only conversation access", async () => {
  const invitation = await call(
    carol,
    `/api/messages/${personalConversation}/invitations`,
    { body: { email: bob + "@example.test" } },
  );
  assert.equal(invitation.status, 201);
  const { token } = invitation.data;
  assert.equal(
    (await call(alice, "/api/messages/accept-invitation", { body: { token } }))
      .status,
    400,
  );
  assert.equal(
    (await call(bob, "/api/messages/accept-invitation", { body: { token } }))
      .status,
    200,
  );
  assert.equal(
    (await call(bob, "/api/messages/accept-invitation", { body: { token } }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(bob, "/api/messages/" + personalConversation, {
        stable: stableA,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(bob, `/api/messages/${personalConversation}/invitations`, {
        body: { email: alice + "@example.test" },
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(carol, "/api/inventory", { stable: stableA })).status,
    403,
  );
  const request = {
    body: "Personal message",
    clientId: crypto.randomUUID(),
    sender_id: carol,
  };
  const first = await call(
    bob,
    `/api/messages/${personalConversation}/messages`,
    { body: request },
  );
  assert.equal(first.status, 201);
  assert.equal(first.data.message.from, "Bob");
  const retry = await call(
    bob,
    `/api/messages/${personalConversation}/messages`,
    { body: request },
  );
  assert.equal(retry.data.message.id, first.data.message.id);
  assert.equal(
    (
      await call(admin, `/api/messages/${personalConversation}/messages`, {
        body: request,
      })
    ).status,
    404,
  );
});
test("revoked and expired personal invitations cannot be used", async () => {
  for (const mode of ["revoked", "expired"]) {
    const r = await call(
      carol,
      `/api/messages/${personalConversation}/invitations`,
      { body: { email: alice + "@example.test" } },
    );
    assert.equal(r.status, 201);
    if (mode === "revoked")
      await call(
        carol,
        `/api/messages/${personalConversation}/invitations/${r.data.invitation.id}/revoke`,
        { body: {} },
      );
    else
      await db.query(
        "update personal_invitations set expires_at=now()-interval '1 second' where id=$1",
        [r.data.invitation.id],
      );
    assert.equal(
      (
        await call(alice, "/api/messages/accept-invitation", {
          body: { token: r.data.token },
        })
      ).status,
      400,
    );
  }
});
test("notebook and preferences belong to the verified account, without stable setup", async () => {
  const r = await call(carol, "/api/my-racing/notes", {
    body: { title: "Trip note", body: "Wait for a clear run.", user_id: alice },
  });
  assert.equal(r.status, 201);
  const note = r.data.note;
  assert.equal(
    (await call(carol, "/api/my-racing/notes")).data.notes.some(
      (n) => n.id === note.id,
    ),
    true,
  );
  assert.equal(
    (await call(alice, "/api/my-racing/notes")).data.notes.some(
      (n) => n.id === note.id,
    ),
    false,
  );
  assert.equal(
    (
      await call(alice, "/api/my-racing/notes/" + note.id, {
        method: "PATCH",
        body: { title: "Forged", body: "No" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(alice, "/api/my-racing/notes/" + note.id + "/remove", {
        body: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(carol, "/api/my-racing/notes/" + note.id, {
        method: "PATCH",
        body: { title: "Updated note", body: "Updated observation" },
      })
    ).status,
    200,
  );
  const choices = {
    entry_alerts: true,
    workout_alerts: false,
    result_alerts: true,
    email_enabled: true,
  };
  assert.equal(
    (
      await call(carol, "/api/my-racing/preferences", {
        method: "PATCH",
        body: { ...choices, user_id: alice },
      })
    ).status,
    200,
  );
  let preferences = await call(carol, "/api/my-racing/preferences");
  assert.equal(preferences.data.deliveryAvailable, false);
  assert.deepEqual(preferences.data.preferences, choices);
  preferences = await call(alice, "/api/my-racing/preferences");
  assert.equal(preferences.data.preferences.entry_alerts, false);
  const summary = await call(carol, "/api/my-racing/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.data.notes, 1);
  assert.equal(summary.data.conversations, 1);
  assert.equal(
    (
      await call(carol, "/api/my-racing/notes/" + note.id + "/remove", {
        body: {},
      })
    ).status,
    200,
  );
});
test("personal follows include jockeys and trainers and remain isolated by user", async () => {
  for (const kind of ["jockeys", "trainers"]) {
    const id = crypto.randomUUID();
    await db.query(
      "insert into site_racing_records(id,kind,payload,publication_status,published_at) values($1,$2,$3,'published',now())",
      [
        id,
        kind,
        JSON.stringify({ name: "Published " + kind, starts: 10, wins: 3 }),
      ],
    );
    assert.equal(
      (
        await call(carol, "/api/watchlist/toggle", {
          body: { id, watched: true, user_id: alice },
        })
      ).status,
      200,
    );
    const own = await call(carol, "/api/watchlist?kind=" + kind);
    assert.equal(own.status, 200);
    assert.equal(own.data.stable.find((r) => r.id === id).watched, true);
    assert.equal(
      (await call(alice, "/api/watchlist?kind=" + kind)).data.stable.find(
        (r) => r.id === id,
      ).watched,
      false,
    );
    assert.equal(
      (await call(carol, "/api/watchlist")).data.stable.some(
        (r) => r.id === id,
      ),
      false,
    );
  }
});
test("browser roles cannot directly access personal account tables or message functions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      for (const table of [
        "racing_notes",
        "racing_preferences",
        "personal_conversations",
        "personal_messages",
        "personal_invitations",
      ])
        await assert.rejects(
          db.query("select * from " + table),
          /permission denied/,
        );
      await assert.rejects(
        db.query("select send_personal_message($1,$2,$3,$4,$5)", [
          alice,
          personalConversation,
          "Forged",
          "No",
          crypto.randomUUID(),
        ]),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
});


test("message cursors accept hosted offsets and preserve microseconds without filter injection", async () => {
  const { messageCursor } = require("../dist/lib/workspace");
  const timestamp = "2026-11-03T01:02:03.123456+00:00";
  assert.deepEqual(messageCursor(timestamp + "|" + alice), { time: timestamp, id: alice });
  for (const bad of [timestamp + "|" + alice + "|extra", "2026-11-03|" + alice, timestamp + ",id.gt.0|" + alice, [], "invalid|" + alice])
    assert.equal(messageCursor(bad), null);
  for (const [path, stable] of [["/api/team-messages/" + conversation, stableA], ["/api/messages/" + personalConversation, undefined]]) {
    const r = await call(path.includes("team-messages") ? alice : carol, path + "?before=" + encodeURIComponent(timestamp + "|" + alice), { stable });
    assert.equal(r.status, 200);
    const invalid = await call(path.includes("team-messages") ? alice : carol, path + "?before=" + encodeURIComponent(timestamp + "|" + alice + "|extra"), { stable });
    assert.equal(invalid.status, 400);
  }
});
