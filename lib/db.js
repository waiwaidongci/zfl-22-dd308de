import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BRANCH_ID, DEFAULT_MATERIALS, seed } from "./constants.js";
import { estimateMaterialUsage } from "./materials.js";
import { generateInitialTasks } from "./schedule.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getDbPath(customPath) {
  return customPath || join(dirname(__dirname), "data", "fish-rubbing.json");
}

export async function loadDb(dbPath) {
  const path = getDbPath(dbPath);
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(path, "utf8"));
  await migrateLegacyData(db, path);
  return db;
}

export async function saveDb(db, dbPath) {
  const path = getDbPath(dbPath);
  await writeFile(path, JSON.stringify(db, null, 2));
}

async function migrateLegacyData(db, dbPath) {
  let changed = false;
  if (!db.materials) {
    db.materials = JSON.parse(JSON.stringify(DEFAULT_MATERIALS));
    changed = true;
  } else {
    for (const def of DEFAULT_MATERIALS) {
      if (!db.materials.find(m => m.id === def.id)) {
        db.materials.push(JSON.parse(JSON.stringify(def)));
        changed = true;
      }
    }
  }
  if (!db.materialTransactions) {
    db.materialTransactions = [];
    changed = true;
  }
  if (!db._materialMigrated) {
    for (const order of (db.orders || [])) {
      if (!order.materialUsage && order.status !== "已完成") {
        order.materialUsage = estimateMaterialUsage(order);
        for (const [matId, qty] of Object.entries(order.materialUsage)) {
          const mat = db.materials.find(m => m.id === matId);
          if (mat) {
            mat.reserved = (mat.reserved || 0) + qty;
          }
        }
        changed = true;
      }
    }
    db._materialMigrated = true;
    changed = true;
  }
  if (!db._materialCostMigrated) {
    for (const mat of (db.materials || [])) {
      if (mat.unitCost === undefined || mat.unitCost === null) {
        const defMat = DEFAULT_MATERIALS.find(d => d.id === mat.id);
        mat.unitCost = defMat?.unitCost || 0;
        changed = true;
      }
    }
    db._materialCostMigrated = true;
    changed = true;
  }
  if (!db.customers) { db.customers = []; changed = true; }
  if (!db._customerMigrated) {
    const nameToId = new Map(db.customers.map(c => [c.name, c.id]));
    function ensureCustomer(name) {
      if (!name) return null;
      if (nameToId.has(name)) return nameToId.get(name);
      const id = `C-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const customer = {
        id,
        name,
        phone: "",
        wechat: "",
        address: "",
        note: "",
        createdAt: new Date().toISOString()
      };
      db.customers.push(customer);
      nameToId.set(name, id);
      return id;
    }
    if (Array.isArray(db.orders)) {
      for (const order of db.orders) {
        if (!order.customerId && order.client) {
          order.customerId = ensureCustomer(order.client);
          changed = true;
        }
      }
    }
    if (Array.isArray(db.works)) {
      for (const work of db.works) {
        if (!work.customerId && work.client) {
          work.customerId = ensureCustomer(work.client);
          changed = true;
        }
      }
    }
    db._customerMigrated = true;
    changed = true;
  }
  if (!db._tasksMigrated) {
    if (Array.isArray(db.orders)) {
      for (const order of db.orders) {
        if (!order.tasks) {
          order.tasks = generateInitialTasks(order);
          changed = true;
        }
      }
    }
    db._tasksMigrated = true;
    changed = true;
  }
  if (!db.orderChanges) {
    db.orderChanges = [];
    changed = true;
  }
  if (!db._changeRequestMigrated) {
    if (Array.isArray(db.orders)) {
      for (const order of db.orders) {
        if (!order.changeHistory) {
          order.changeHistory = [];
          changed = true;
        }
      }
    }
    db._changeRequestMigrated = true;
    changed = true;
  }
  if (!db._branchMigrated) {
    if (!db.branches) {
      db.branches = [{ id: DEFAULT_BRANCH_ID, name: "总店（默认）", manager: "", address: "", phone: "", createdAt: new Date().toISOString(), isDefault: true }];
    }
    for (const order of (db.orders || [])) {
      if (!order.branchId) { order.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const material of (db.materials || [])) {
      if (!material.branchId) { material.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const customer of (db.customers || [])) {
      if (!customer.branchId) { customer.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const work of (db.works || [])) {
      if (!work.branchId) { work.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const tx of (db.materialTransactions || [])) {
      if (!tx.branchId) { tx.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    for (const change of (db.orderChanges || [])) {
      if (!change.branchId) { change.branchId = DEFAULT_BRANCH_ID; changed = true; }
    }
    db._branchMigrated = true;
    changed = true;
  }
  if (!db._worksEnhancedMigrated) {
    if (Array.isArray(db.works)) {
      for (const work of db.works) {
        if (!work.themeTags) { work.themeTags = []; changed = true; }
        if (!work.displayLevel) { work.displayLevel = "standard"; changed = true; }
        if (!work.clientAuthorization) { work.clientAuthorization = "unauthorized"; changed = true; }
      }
    }
    db._worksEnhancedMigrated = true;
    changed = true;
  }
  if (!db.customerMasters) {
    db.customerMasters = [];
    changed = true;
  }
  if (!db._customerMasterMigrated) {
    if (Array.isArray(db.customers)) {
      for (const customer of db.customers) {
        if (customer.masterId === undefined) {
          customer.masterId = null;
          changed = true;
        }
      }
    }
    db._customerMasterMigrated = true;
    changed = true;
  }
  if (changed) {
    await saveDb(db, dbPath);
  }
}
