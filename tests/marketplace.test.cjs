const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");

const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222",
  admin = "44444444-4444-4444-8444-444444444444";
const tokens = new Map();
let server, origin, database;

before(async () => {
  database = await installDatabase(supabase);
  for (const [id, name, role] of [
    [alice, "Alice Seller", "member"],
    [bob, "Bob Buyer", "member"],
    [admin, "Site Admin", "admin"],
  ]) {
    await database.db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.test"]);
    tokens.set(id, auth.createSession({ id, username: id, displayName: name, role, email: id + "@example.test" }));
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(user ? { Authorization: "Bearer " + tokens.get(user) } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

const horse = (overrides = {}) => ({
  name: "Northern Ledger",
  price: 45000,
  breed: "thoroughbred",
  discipline: "flat-racing",
  type: "racehorse",
  gender: "gelding",
  color: "bay",
  age: 4,
  heightIn: 66,
  location: "Lexington, Kentucky",
  ...overrides,
});
const names = (r) => r.data.listings.map((l) => l.name);
let aliceListing;

test("guests cannot browse or list", async () => {
  assert.equal((await call(null, "/api/marketplace/listings")).status, 401);
  assert.equal((await call(null, "/api/marketplace/listings", { body: horse() })).status, 401);
});

test("members list horses; the seller's account id is never returned", async () => {
  let r = await call(alice, "/api/marketplace/listings", { body: horse({ name: "  Northern   Ledger " }) });
  assert.equal(r.status, 201);
  aliceListing = r.data.listing;
  assert.equal(aliceListing.name, "Northern Ledger");
  assert.equal(aliceListing.sellerName, "Alice Seller");
  assert.equal(aliceListing.mine, true);
  assert.equal(aliceListing.type, "racehorse");
  assert.equal(aliceListing.heightIn, 66);
  assert.equal("seller_id" in aliceListing || "sellerId" in aliceListing, false);

  r = await call(bob, "/api/marketplace/listings", {
    body: horse({ name: "Quiet Mare", price: 8000, breed: "quarter-horse", discipline: "barrel-racing", type: "riding-horse", gender: "mare", color: "palomino", age: 9, heightIn: 60, location: "Ocala, Florida" }),
  });
  assert.equal(r.status, 201);
  r = await call(bob, "/api/marketplace/listings", {
    body: horse({ name: "Yearling Hope", price: 120000, type: "yearling", gender: "colt", color: "chestnut", age: 1, heightIn: 58 }),
  });
  assert.equal(r.status, 201);

  r = await call(bob, "/api/marketplace/listings");
  assert.equal(r.status, 200);
  assert.deepEqual(names(r), ["Yearling Hope", "Quiet Mare", "Northern Ledger"]);
  assert.equal(r.data.more, false);
  assert.equal(r.data.listings.find((l) => l.name === "Northern Ledger").mine, false);
});

test("listings are checked: choices, whole numbers, ranges and plain text", async () => {
  for (const bad of [
    horse({ breed: "unicorn" }),
    horse({ discipline: "" }),
    horse({ type: undefined }),
    horse({ gender: "Mare" }),
    horse({ color: "blue" }),
    horse({ price: 0 }),
    horse({ price: 10.5 }),
    horse({ price: "45000" }),
    horse({ age: 41 }),
    horse({ heightIn: 90 }),
    horse({ name: "  " }),
    horse({ name: "<b>Bold</b>" }),
    horse({ location: "x" }),
  ])
    assert.equal((await call(alice, "/api/marketplace/listings", { body: bad })).status, 400);
});

test("filters cover every field except the name", async () => {
  const q = async (query) => names(await call(bob, "/api/marketplace/listings?" + query));
  assert.deepEqual(await q("breed=quarter-horse"), ["Quiet Mare"]);
  assert.deepEqual(await q("discipline=barrel-racing"), ["Quiet Mare"]);
  assert.deepEqual(await q("type=yearling"), ["Yearling Hope"]);
  assert.deepEqual(await q("gender=gelding"), ["Northern Ledger"]);
  assert.deepEqual(await q("color=chestnut"), ["Yearling Hope"]);
  assert.deepEqual(await q("priceMin=10000&priceMax=50000"), ["Northern Ledger"]);
  assert.deepEqual(await q("ageMin=2&ageMax=5"), ["Northern Ledger"]);
  assert.deepEqual(await q("heightMin=60&heightMax=64"), ["Quiet Mare"]);
  assert.deepEqual(await q("location=ocala"), ["Quiet Mare"]);
  assert.deepEqual(await q("location=%25"), ["Yearling Hope", "Quiet Mare", "Northern Ledger"]);
  assert.deepEqual(await q("mine=1"), ["Yearling Hope", "Quiet Mare"]);
  assert.deepEqual(await q("sort=price-asc"), ["Quiet Mare", "Northern Ledger", "Yearling Hope"]);
  assert.deepEqual(await q("sort=price-desc"), ["Yearling Hope", "Northern Ledger", "Quiet Mare"]);
  assert.deepEqual(await q("sort=age-asc"), ["Yearling Hope", "Northern Ledger", "Quiet Mare"]);
  assert.deepEqual(await q("breed=&gender="), ["Yearling Hope", "Quiet Mare", "Northern Ledger"]);
  for (const bad of ["breed=unicorn", "priceMin=-1", "ageMax=abc", "heightMin=200", "sort=random"])
    assert.equal((await call(bob, "/api/marketplace/listings?" + bad)).status, 400);
});

test("only the seller edits; the seller or an admin removes", async () => {
  const path = "/api/marketplace/listings/" + aliceListing.id;
  assert.equal((await call(bob, path, { method: "PATCH", body: horse({ price: 1 }) })).status, 404);
  let r = await call(alice, path, { method: "PATCH", body: horse({ price: 42000 }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.listing.price, 42000);
  assert.equal(r.data.listing.sellerName, "Alice Seller");

  assert.equal((await call(bob, path + "/remove", { method: "POST" })).status, 404);
  assert.equal((await call(alice, "/api/marketplace/listings/not-a-uuid/remove", { method: "POST" })).status, 404);
  assert.equal((await call(alice, path + "/remove", { method: "POST" })).status, 200);
  assert.equal((await call(alice, path + "/remove", { method: "POST" })).status, 404);

  const bobs = (await call(bob, "/api/marketplace/listings?mine=1")).data.listings;
  assert.equal((await call(admin, "/api/marketplace/listings/" + bobs[0].id + "/remove", { method: "POST" })).status, 200);
  assert.deepEqual(names(await call(alice, "/api/marketplace/listings")), ["Quiet Mare"]);
});
