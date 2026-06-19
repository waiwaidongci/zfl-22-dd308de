import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  cleanTmpDir,
  tmpFilePath,
  deepClone,
  startServer,
  stopServer,
  request,
  hashDataFile,
  isDataFileUnchanged,
  paths
} from "../lib/test-helpers.js";

process.env.NO_LISTEN = "1";
const serverModule = await import("../server.js");
const { __test__ } = serverModule;
const { seed, DEFAULT_BRANCH_ID } = __test__;

let dataHashBeforeTests = null;

before(async () => {
  await cleanTmpDir();
  dataHashBeforeTests = await hashDataFile();
});

after(async () => {
  await cleanTmpDir();
  if (dataHashBeforeTests) {
    const unchanged = await isDataFileUnchanged(dataHashBeforeTests);
    assert.ok(unchanged, "data/fish-rubbing.json must not be modified by tests");
  }
});

test("server can start with random port and temporary DB", async () => {
  const dbPath = tmpFilePath("startup-basic");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    assert.ok(ctx.port > 1024 && ctx.port < 65536, "port should be valid");
    assert.ok(ctx.url.startsWith("http://localhost:"), "url should be http localhost");
    assert.equal(ctx.dbPath, dbPath, "dbPath should match");
  } finally {
    await stopServer(ctx);
  }
});

test("GET / returns HTML page", async () => {
  const dbPath = tmpFilePath("startup-root");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const res = await request(ctx.url, "/", { method: "GET" });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("<!doctype html>") || res.text.includes("<!DOCTYPE html>"), "should return HTML");
    assert.ok(res.text.includes("鱼拓装裱工作室"), "page title should be present");
  } finally {
    await stopServer(ctx);
  }
});

test("GET /api/orders returns order list", async () => {
  const dbPath = tmpFilePath("startup-orders");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const res = await request(ctx.url, "/api/orders", { method: "GET" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), "should return array");
    assert.ok(res.body.length >= 2, "seed data has at least 2 orders");
    for (const order of res.body) {
      assert.ok(order.id, "each order has id");
      assert.ok(order.client !== undefined || order.customerId, "order links to customer");
      assert.ok(order.status, "each order has status");
    }
  } finally {
    await stopServer(ctx);
  }
});

test("GET /api/materials returns materials with available computed", async () => {
  const dbPath = tmpFilePath("startup-materials");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const res = await request(ctx.url, "/api/materials", { method: "GET" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 5);
    for (const mat of res.body) {
      assert.ok(mat.id, "material has id");
      assert.ok(mat.name, "material has name");
      assert.equal(typeof mat.stock, "number", "stock is numeric");
      assert.equal(typeof mat.reserved, "number", "reserved is numeric");
      assert.equal(typeof mat.available, "number", "available is computed");
      assert.equal(mat.available, (mat.stock || 0) - (mat.reserved || 0), "available = stock - reserved");
    }
  } finally {
    await stopServer(ctx);
  }
});

test("GET /api/works returns works list", async () => {
  const dbPath = tmpFilePath("startup-works");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const res = await request(ctx.url, "/api/works", { method: "GET" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 2, "seed data has at least 2 works");
    for (const work of res.body) {
      assert.ok(work.id);
      assert.ok(Array.isArray(work.themeTags), "themeTags should be array");
      assert.ok(work.displayLevel, "displayLevel should exist");
      assert.ok(work.clientAuthorization, "clientAuthorization should exist");
    }
  } finally {
    await stopServer(ctx);
  }
});

test("GET /api/customers returns customers list", async () => {
  const dbPath = tmpFilePath("startup-customers");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const res = await request(ctx.url, "/api/customers", { method: "GET" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  } finally {
    await stopServer(ctx);
  }
});

test("GET /api/schedule returns schedule data", async () => {
  const dbPath = tmpFilePath("startup-schedule");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const res = await request(ctx.url, `/api/schedule?year=${y}&month=${m}`, { method: "GET" });
    assert.equal(res.status, 200);
    assert.ok(res.body.weeks !== undefined || Array.isArray(res.body), "schedule response has structure");
  } finally {
    await stopServer(ctx);
  }
});

test("POST /api/orders creates a new order and persists it", async () => {
  const dbPath = tmpFilePath("startup-create-order");
  let ctx;
  try {
    ctx = await startServer(dbPath, deepClone(seed));

    const beforeRes = await request(ctx.url, "/api/orders", { method: "GET" });
    const beforeCount = beforeRes.body.length;

    const createRes = await request(ctx.url, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        client: "新建测试客户",
        fishSpecies: "石斑鱼",
        size: "80x40cm",
        paper: "手工楮皮纸",
        inkPlan: "浓墨鱼身，朱砂题款",
        mounting: "立轴",
        inscription: "海纳百川",
        owner: "阿青",
        price: 2500,
        paid: false,
        dueDate: "2026-07-15"
      })
    });
    assert.equal(createRes.status, 201, "create should return 201");
    assert.ok(createRes.body.id, "new order has id");
    assert.equal(createRes.body.client, "新建测试客户");
    assert.equal(createRes.body.branchId, DEFAULT_BRANCH_ID);

    const afterRes = await request(ctx.url, "/api/orders", { method: "GET" });
    assert.equal(afterRes.body.length, beforeCount + 1, "order count should increase by 1");
  } finally {
    await stopServer(ctx);
  }
});

test("multiple servers can run concurrently on different ports with isolated data", async () => {
  const dbPath1 = tmpFilePath("concurrent-1");
  const dbPath2 = tmpFilePath("concurrent-2");
  let ctx1, ctx2;
  try {
    ctx1 = await startServer(dbPath1, deepClone(seed));
    ctx2 = await startServer(dbPath2, deepClone(seed));

    assert.notEqual(ctx1.port, ctx2.port, "servers should have different ports");

    const uniqueClient = `CONCURRENT-${Date.now()}`;
    const createRes = await request(ctx1.url, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        client: uniqueClient,
        fishSpecies: "真鲷",
        size: "70x35cm",
        paper: "手工楮皮纸",
        inkPlan: "淡墨鱼身",
        mounting: "立轴",
        inscription: "test",
        owner: "阿青",
        price: 1000,
        paid: false,
        dueDate: "2026-07-01"
      })
    });
    assert.equal(createRes.status, 201);

    const ctx1Orders = await request(ctx1.url, "/api/orders", { method: "GET" });
    const ctx2Orders = await request(ctx2.url, "/api/orders", { method: "GET" });

    const ctx1HasIt = ctx1Orders.body.some(o => o.client === uniqueClient);
    const ctx2HasIt = ctx2Orders.body.some(o => o.client === uniqueClient);
    assert.ok(ctx1HasIt, "server1 should have the new order");
    assert.ok(!ctx2HasIt, "server2 data should be isolated - should not have order from server1");
  } finally {
    await stopServer(ctx1);
    await stopServer(ctx2);
  }
});

test("all tests leave the original data/fish-rubbing.json untouched", async () => {
  if (dataHashBeforeTests) {
    const unchanged = await isDataFileUnchanged(dataHashBeforeTests);
    assert.ok(unchanged, "CRITICAL: data/fish-rubbing.json was modified during tests!");
  }
});
