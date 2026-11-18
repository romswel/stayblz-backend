const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");

const VIEWER = "00000000-0000-4000-8000-000000000001";
const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
// 40 real members with placeholder accounts mixed in between them.
const PLACEHOLDERS = ["Super Admin", "test user", "Admin Admin", "admin", "TEST", "User", "  user  "];
const ROWS = [];
for (let i = 0; i < 40; i++) {
  ROWS.push({ id: uuid(100 + i), name: "Owner " + i });
  if (i % 6 === 0 && PLACEHOLDERS.length) ROWS.push({ id: uuid(500 + i), name: PLACEHOLDERS.pop() });
}
// Names that only contain the letters, not the word, stay listed.
ROWS.push({ id: uuid(900), name: "Testa Stables" }, { id: uuid(901), name: "Adminton Farm" });

let server, origin, token, originalRpc;

before(async () => {
  originalRpc = supabase.rpc;
  supabase.rpc = async (name, args) => {
    assert.equal(name, "community_people");
    return { data: ROWS.slice(args.p_offset, args.p_offset + Math.min(args.p_limit, 61)), error: null };
  };
  token = auth.createSession({ id: VIEWER, username: "m1", displayName: "Member", role: "member" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  supabase.rpc = originalRpc;
  auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
});

async function people(query) {
  const response = await fetch(origin + "/api/community/people" + query, { headers: { Authorization: "Bearer " + token } });
  return { status: response.status, data: await response.json() };
}

test("members directory hides admin/test/user accounts and pages by 15", async () => {
  const seen = [];
  for (let page = 1; ; page++) {
    const r = await people("?page=" + page);
    assert.equal(r.status, 200);
    assert.equal(r.data.page, page);
    if (r.data.hasNext) assert.equal(r.data.people.length, 15);
    seen.push(...r.data.people.map((p) => p.name));
    if (!r.data.hasNext) break;
  }
  assert.equal(seen.length, 42);
  assert.equal(new Set(seen).size, 42);
  for (const name of seen) assert.doesNotMatch(name, /\b(admin|test|user)\b/i);
  assert.ok(seen.includes("Testa Stables") && seen.includes("Adminton Farm"));
});

test("members directory rejects bad page numbers", async () => {
  for (const page of ["0", "-1", "1.5", "abc", "501"]) assert.equal((await people("?page=" + page)).status, 400);
});
