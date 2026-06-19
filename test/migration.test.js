import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestContext, deepClone } from "../lib/test-helpers.js";

const ctx = createTestContext(import.meta.url);
const { tmpFilePath, writeJson, readJson, cleanScopeDir } = ctx;

process.env.NO_LISTEN = "1";
const serverModule = await import("../server.js");
const { __test__ } = serverModule;
const { DEFAULT_MATERIALS, DEFAULT_BRANCH_ID, seed } = __test__;

before(async () => {
  await cleanScopeDir();
});

after(async () => {
  await cleanScopeDir();
});

function buildLegacySeedV1() {
  return {
    orders: [
      {
        id: "FT-LEGACY-001",
        client: "老客户A",
        fishSpecies: "真鲷",
        size: "70x35cm",
        paper: "手工楮皮纸",
        inkPlan: "淡墨鱼身，朱砂题款",
        mounting: "立轴",
        inscription: "海上清风",
        owner: "阿青",
        price: 1800,
        paid: false,
        payments: [],
        dueDate: "2026-06-24",
        status: "晾干中",
        history: [
          { at: "2026-06-12T09:00:00.000Z", stage: "待拓印", note: "客户送鱼并确认尺寸" }
        ]
      }
    ],
    works: [
      {
        id: "W-LEGACY-001",
        orderId: "FT-LEGACY-000",
        client: "老客户B",
        fishSpecies: "鲈鱼",
        size: "80x40cm",
        paper: "手工楮皮纸",
        inkPlan: "淡墨鱼身，朱砂点睛",
        mounting: "立轴",
        inscription: "烟波钓徒",
        owner: "阿青",
        completedAt: "2026-05-20T10:00:00.000Z"
      }
    ]
  };
}

function buildLegacySeedV2_NoMaterials() {
  const s = buildLegacySeedV1();
  s.materialTransactions = [];
  return s;
}

function buildLegacySeedV3_PartialMigrated() {
  const s = deepClone(seed);
  for (const order of s.orders) {
    delete order.tasks;
    delete order.changeHistory;
    delete order.customerId;
    delete order.branchId;
    delete order.materialUsage;
  }
  for (const mat of s.materials) {
    delete mat.branchId;
    delete mat.unitCost;
  }
  for (const work of s.works) {
    delete work.branchId;
    delete work.themeTags;
    delete work.displayLevel;
    delete work.clientAuthorization;
    delete work.customerId;
  }
  s.customers = [];
  s.customerMasters = [];
  s.orderChanges = [];
  delete s._materialMigrated;
  delete s._materialCostMigrated;
  delete s._customerMigrated;
  delete s._tasksMigrated;
  delete s._changeRequestMigrated;
  delete s._branchMigrated;
  delete s._worksEnhancedMigrated;
  delete s._customerMasterMigrated;
  delete s.branches;
  return s;
}

test("migration: empty JSON with only orders gets all defaults", async () => {
  const dbPath = tmpFilePath("migration-v1");
  await writeJson(dbPath, buildLegacySeedV1());

  const { loadDb } = await import("../lib/db.js");
  const migrated = await loadDb(dbPath);

  const fileOrder = migrated.orders.find(o => o.id === "FT-LEGACY-001");
  assert.ok(fileOrder, "legacy order FT-LEGACY-001 should exist in db file");
  assert.ok(fileOrder.customerId, "order should have customerId after migration");
  assert.ok(fileOrder.branchId, "order should have branchId after migration");
  assert.equal(fileOrder.branchId, DEFAULT_BRANCH_ID);
  assert.ok(Array.isArray(fileOrder.tasks), "order should have tasks after migration");
  assert.ok(fileOrder.tasks.length > 0, "tasks should be generated");
  assert.ok(Array.isArray(fileOrder.changeHistory), "order should have changeHistory");
  assert.ok(fileOrder.materialUsage, "order should have materialUsage (non-completed)");

  assert.ok(migrated.materials.length >= DEFAULT_MATERIALS.length, "default materials should be added");
  for (const m of migrated.materials) {
    assert.equal(m.branchId, DEFAULT_BRANCH_ID);
    assert.ok(m.unitCost !== undefined, "material should have unitCost");
  }

  assert.ok(migrated.customers.length >= 2, "customers should be created from both order.client and work.client");

  const fileWork = migrated.works.find(w => w.id === "W-LEGACY-001");
  assert.ok(fileWork, "legacy work W-LEGACY-001 should exist in db file");
  assert.ok(fileWork.branchId, "work should have branchId");
  assert.ok(fileWork.themeTags, "work should have themeTags");
  assert.ok(fileWork.displayLevel, "work should have displayLevel");
  assert.ok(fileWork.clientAuthorization, "work should have clientAuthorization");

  assert.equal(migrated._materialMigrated, true);
  assert.equal(migrated._materialCostMigrated, true);
  assert.equal(migrated._customerMigrated, true);
  assert.equal(migrated._tasksMigrated, true);
  assert.equal(migrated._changeRequestMigrated, true);
  assert.equal(migrated._branchMigrated, true);
  assert.equal(migrated._worksEnhancedMigrated, true);
  assert.equal(migrated._customerMasterMigrated, true);
  assert.ok(Array.isArray(migrated.branches));
  assert.ok(migrated.branches.some(b => b.id === DEFAULT_BRANCH_ID));
  assert.ok(Array.isArray(migrated.orderChanges));
  assert.ok(Array.isArray(migrated.materialTransactions));
  assert.ok(Array.isArray(migrated.customerMasters));
});

test("migration: existing materials get merged with defaults", async () => {
  const dbPath = tmpFilePath("migration-v2");
  const seedV2 = buildLegacySeedV2_NoMaterials();
  seedV2.materials = [
    { id: "M-001", name: "手工楮皮纸", stock: 30, reserved: 2, threshold: 5 }
  ];
  await writeJson(dbPath, seedV2);

  const { loadDb } = await import("../lib/db.js");
  const migrated = await loadDb(dbPath);

  assert.ok(migrated.materials.length >= DEFAULT_MATERIALS.length, "missing default materials should be added");

  const m1 = migrated.materials.find(m => m.id === "M-001");
  assert.equal(m1.stock, 30, "existing material stock should be preserved");
  assert.ok(m1.reserved >= 2, "existing material reserved is at least original (increased due to migration materialUsage estimation)");

  for (const defMat of DEFAULT_MATERIALS) {
    assert.ok(
      migrated.materials.some(m => m.id === defMat.id),
      `default material ${defMat.id} should exist after migration`
    );
  }
});

test("migration: data idempotent - running migrate twice produces same result", async () => {
  const dbPath = tmpFilePath("migration-idempotent");
  await writeJson(dbPath, buildLegacySeedV3_PartialMigrated());

  const { loadDb } = await import("../lib/db.js");
  await loadDb(dbPath);
  const afterFirstMigrate = JSON.stringify(await readJson(dbPath));

  await loadDb(dbPath);
  const afterSecondMigrate = JSON.stringify(await readJson(dbPath));

  assert.equal(afterFirstMigrate, afterSecondMigrate, "migration should be idempotent");
});

test("migration: completed orders skip materialUsage generation", async () => {
  const dbPath = tmpFilePath("migration-completed");
  const seedData = {
    orders: [
      {
        id: "FT-COMPLETED",
        client: "已完成客户",
        fishSpecies: "黑鲷",
        size: "60x30cm",
        paper: "云母宣",
        inkPlan: "浓墨鱼身",
        mounting: "镜片",
        inscription: "渔乐无穷",
        owner: "阿青",
        price: 1500,
        paid: true,
        payments: [],
        dueDate: "2026-06-10",
        status: "已完成",
        history: []
      }
    ],
    works: []
  };
  await writeJson(dbPath, seedData);

  const { loadDb } = await import("../lib/db.js");
  const migrated = await loadDb(dbPath);
  const completedOrder = migrated.orders.find(o => o.id === "FT-COMPLETED");
  assert.equal(completedOrder.materialUsage, undefined, "completed orders should not get materialUsage");
});

test("migration: customer master fields added correctly", async () => {
  const dbPath = tmpFilePath("migration-customermaster");
  const seedData = deepClone(seed);
  for (const c of seedData.customers || []) {
    delete c.masterId;
  }
  delete seedData.customerMasters;
  delete seedData._customerMasterMigrated;
  await writeJson(dbPath, seedData);

  const { loadDb } = await import("../lib/db.js");
  const migrated = await loadDb(dbPath);
  assert.ok(Array.isArray(migrated.customerMasters), "customerMasters should exist as array");
  if (migrated.customers && migrated.customers.length > 0) {
    for (const customer of migrated.customers) {
      assert.ok(customer.masterId === null || typeof customer.masterId === "string",
        `customer ${customer.id} should have masterId set to null or string`);
    }
  }
  assert.equal(migrated._customerMasterMigrated, true);
});
