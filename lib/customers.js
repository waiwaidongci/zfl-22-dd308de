import { DEFAULT_BRANCH_ID } from "./constants.js";
import { stringSimilarity } from "./utils.js";

export function enrichCustomer(customer, orders, works) {
  const cOrders = orders.filter(o => o.customerId === customer.id);
  const cWorks = works.filter(w => w.customerId === customer.id);
  const allItems = [...cOrders, ...cWorks];
  const totalPaid = cOrders.reduce((s, o) => s + (o.payments || []).reduce((a, p) => a + p.amount, 0), 0);
  const totalSpent = cOrders.reduce((s, o) => {
    const paid = (o.payments || []).reduce((a, p) => a + p.amount, 0);
    if (o.paid && paid === 0) return s + (o.price || 0);
    return s + paid;
  }, 0);
  const paperCount = {};
  const mountingCount = {};
  const sortedItems = allItems.slice().sort((a, b) => {
    const aTime = new Date(a.dueDate || a.completedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.dueDate || b.completedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
  allItems.forEach(item => {
    if (item.paper) paperCount[item.paper] = (paperCount[item.paper] || 0) + 1;
    if (item.mounting) mountingCount[item.mounting] = (mountingCount[item.mounting] || 0) + 1;
  });
  const autoPreferredPaper = Object.entries(paperCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const autoPreferredMounting = Object.entries(mountingCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const lastInscription = sortedItems.find(item => item.inscription && item.inscription.trim())?.inscription || "";
  const preferredPaper = customer.preferredPaper || autoPreferredPaper;
  const preferredMounting = customer.preferredMounting || autoPreferredMounting;
  const pendingOrders = cOrders.filter(o => o.status !== "已完成").length;
  return {
    ...customer,
    orderCount: cOrders.length,
    workCount: cWorks.length,
    pendingOrders,
    totalPaid,
    totalSpent,
    preferredPaper,
    preferredMounting,
    lastInscription,
    autoPreferredPaper,
    autoPreferredMounting
  };
}

export function calculateCustomerSimilarity(c1, c2) {
  let score = 0;
  let reasons = [];
  const nameSim = stringSimilarity(c1.name, c2.name);
  if (nameSim >= 0.6) {
    score = Math.max(score, nameSim);
    reasons.push("姓名相似");
  }
  if (c1.phone && c2.phone) {
    const phoneSim = stringSimilarity(c1.phone.replace(/\D/g, ""), c2.phone.replace(/\D/g, ""));
    if (phoneSim >= 0.8) {
      score = Math.max(score, phoneSim);
      reasons.push("电话相似");
    }
  }
  if (c1.wechat && c2.wechat) {
    const wechatSim = stringSimilarity(c1.wechat, c2.wechat);
    if (wechatSim >= 0.7) {
      score = Math.max(score, wechatSim);
      reasons.push("微信相似");
    }
  }
  return { score, reasons };
}

export function findSimilarCustomers(customers, threshold = 0.5) {
  const groups = [];
  const visited = new Set();
  for (let i = 0; i < customers.length; i++) {
    if (visited.has(customers[i].id)) continue;
    const group = { center: customers[i], members: [customers[i]], matches: [] };
    visited.add(customers[i].id);
    for (let j = i + 1; j < customers.length; j++) {
      if (visited.has(customers[j].id)) continue;
      const { score, reasons } = calculateCustomerSimilarity(customers[i], customers[j]);
      if (score >= threshold) {
        group.members.push(customers[j]);
        group.matches.push({ customer: customers[j], score, reasons });
        visited.add(customers[j].id);
      }
    }
    if (group.members.length > 1) {
      groups.push(group);
    }
  }
  groups.sort((a, b) => b.members.length - a.members.length);
  return groups;
}

export function enrichMasterCustomer(master, customers, orders, works, branches) {
  const masterCustomers = customers.filter(c => c.masterId === master.id);
  const allOrders = orders.filter(o => masterCustomers.some(mc => mc.id === o.customerId));
  const allWorks = works.filter(w => masterCustomers.some(mc => mc.id === w.customerId));
  const totalSpent = allOrders.reduce((s, o) => {
    const paid = (o.payments || []).reduce((a, p) => a + p.amount, 0);
    if (o.paid && paid === 0) return s + (o.price || 0);
    return s + paid;
  }, 0);
  const pendingOrders = allOrders.filter(o => o.status !== "已完成").length;
  const branchIds = [...new Set(masterCustomers.map(c => c.branchId || DEFAULT_BRANCH_ID))];
  const branchInfo = branchIds.map(bid => {
    const branch = branches.find(b => b.id === bid);
    const branchCustomers = masterCustomers.filter(c => (c.branchId || DEFAULT_BRANCH_ID) === bid);
    const branchOrders = allOrders.filter(o => (o.branchId || DEFAULT_BRANCH_ID) === bid);
    const branchWorks = allWorks.filter(w => (w.branchId || DEFAULT_BRANCH_ID) === bid);
    const branchSpent = branchOrders.reduce((s, o) => {
      const paid = (o.payments || []).reduce((a, p) => a + p.amount, 0);
      if (o.paid && paid === 0) return s + (o.price || 0);
      return s + paid;
    }, 0);
    return {
      branchId: bid,
      branchName: branch?.name || "未知分店",
      customerCount: branchCustomers.length,
      orderCount: branchOrders.length,
      workCount: branchWorks.length,
      totalSpent: branchSpent
    };
  });
  const paperCount = {};
  const mountingCount = {};
  [...allOrders, ...allWorks].forEach(item => {
    if (item.paper) paperCount[item.paper] = (paperCount[item.paper] || 0) + 1;
    if (item.mounting) mountingCount[item.mounting] = (mountingCount[item.mounting] || 0) + 1;
  });
  const preferredPaper = Object.entries(paperCount).sort((a, b) => b[1] - a[1])[0]?.[0] || master.preferredPaper || "";
  const preferredMounting = Object.entries(mountingCount).sort((a, b) => b[1] - a[1])[0]?.[0] || master.preferredMounting || "";
  return {
    ...master,
    customerCount: masterCustomers.length,
    orderCount: allOrders.length,
    workCount: allWorks.length,
    pendingOrders,
    totalSpent,
    preferredPaper,
    preferredMounting,
    branchInfo,
    customerIds: masterCustomers.map(c => c.id)
  };
}
