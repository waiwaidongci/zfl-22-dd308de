import { stages, scheduleStages, STAGE_DURATION_DAYS, MAX_TASKS_PER_DAY, DUE_DATE_WARNING_DAYS, WEEKDAY_LABELS } from "./constants.js";
import { toLocalDateString, daysBetween, addDays, getWeekRange } from "./utils.js";

export function calculateRemainingWorkDays(order) {
  const currentIdx = stages.indexOf(order.status);
  let totalDays = 0;
  for (let i = currentIdx; i < scheduleStages.length; i++) {
    totalDays += STAGE_DURATION_DAYS[scheduleStages[i]] || 1;
  }
  return totalDays;
}

export function assessScheduleRisk(order, newDueDate) {
  const today = toLocalDateString(new Date());
  const remainingDays = calculateRemainingWorkDays(order);
  const oldDueDate = order.dueDate;
  const effectiveNewDue = newDueDate || oldDueDate;

  const oldDaysToDue = daysBetween(today, oldDueDate);
  const newDaysToDue = daysBetween(today, effectiveNewDue);
  const oldBuffer = oldDaysToDue - remainingDays;
  const newBuffer = newDaysToDue - remainingDays;
  const bufferReduction = oldBuffer - newBuffer;

  const isDueDateChanged = newDueDate && newDueDate !== oldDueDate;
  const isCompressed = newDueDate && daysBetween(newDueDate, oldDueDate) > 0;

  const upcomingStages = [];
  const currentIdx = stages.indexOf(order.status);
  let accumulatedDays = 0;
  for (let i = currentIdx; i < scheduleStages.length; i++) {
    const stage = scheduleStages[i];
    const duration = STAGE_DURATION_DAYS[stage] || 1;
    const stageStartOffset = accumulatedDays;
    const stageEndOffset = accumulatedDays + duration;
    const stageOldEnd = addDays(today, stageEndOffset);
    const willStageCompress = isDueDateChanged && isCompressed && daysBetween(effectiveNewDue, stageOldEnd) > 0;
    upcomingStages.push({
      stage,
      durationDays: duration,
      plannedEndDate: stageOldEnd,
      willBeCompressed: willStageCompress,
      compressedByDays: willStageCompress ? daysBetween(effectiveNewDue, stageOldEnd) : 0
    });
    accumulatedDays += duration;
  }

  let riskLevel = "low";
  let riskMessage = "工期充足，无明显压缩风险";
  if (newBuffer < 0) {
    riskLevel = "high";
    riskMessage = `⚠️ 工期不足：剩余工序需 ${remainingDays} 天，但距离新交付日期仅 ${newDaysToDue} 天，缺少 ${Math.abs(newBuffer)} 天`;
  } else if (newBuffer <= 1) {
    riskLevel = "high";
    riskMessage = `⚠️ 工期极度紧张：完成工序需要 ${remainingDays} 天，缓冲仅剩 ${newBuffer} 天`;
  } else if (newBuffer <= 2) {
    riskLevel = "mid";
    riskMessage = `⚠️ 工期较紧张：完成工序需要 ${remainingDays} 天，缓冲仅 ${newBuffer} 天`;
  } else if (bufferReduction > 0 && isDueDateChanged) {
    riskLevel = "mid";
    riskMessage = `交付日期提前，缓冲时间从 ${oldBuffer} 天缩减至 ${newBuffer} 天（减少 ${bufferReduction} 天）`;
  }

  return {
    oldDueDate,
    newDueDate: effectiveNewDue,
    isDueDateChanged,
    remainingWorkDays: remainingDays,
    oldDaysToDue,
    newDaysToDue,
    oldBufferDays: Math.max(0, oldBuffer),
    newBufferDays: Math.max(0, newBuffer),
    bufferReductionDays: Math.max(0, bufferReduction),
    riskLevel,
    riskMessage,
    upcomingStages
  };
}

export function generateInitialTasks(order) {
  const tasks = [];
  const history = order.history || [];
  const stageSet = new Set(scheduleStages);
  const stageHistory = {};
  for (const h of history) {
    if (stageSet.has(h.stage) && !stageHistory[h.stage]) {
      stageHistory[h.stage] = h;
    }
  }
  let taskIndex = 1;
  const orderIdNum = order.id.replace(/\D/g, "");
  for (const stage of scheduleStages) {
    const stageIdx = stages.indexOf(stage);
    const currentIdx = stages.indexOf(order.status);
    const isPast = stageIdx < currentIdx;
    const isCurrent = stage === order.status;
    const isFuture = stageIdx > currentIdx;
    if (order.status === "已完成" || isPast || isCurrent) {
      const h = stageHistory[stage];
      const taskDate = h ? h.at.slice(0, 10) : (order.dueDate || new Date().toISOString().slice(0, 10));
      tasks.push({
        id: `T-${orderIdNum}-${taskIndex}`,
        stage,
        assignee: order.owner || "未分配",
        date: taskDate,
        note: h ? h.note : "",
        completed: isPast || order.status === "已完成",
        createdAt: h ? h.at : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      taskIndex++;
    }
  }
  return tasks;
}

export function buildWeekScheduleData(orders, refDate, assigneeFilter) {
  const weekRange = getWeekRange(refDate);
  const today = new Date().toISOString().slice(0, 10);

  const allTasks = [];
  orders.forEach(order => {
    (order.tasks || []).forEach(task => {
      allTasks.push({
        ...task,
        orderId: order.id,
        client: order.client,
        fishSpecies: order.fishSpecies,
        size: order.size,
        orderStatus: order.status,
        dueDate: order.dueDate,
        branchId: order.branchId
      });
    });
  });

  let filtered = allTasks.filter(t => weekRange.days.includes(t.date));
  if (assigneeFilter) {
    filtered = filtered.filter(t => t.assignee === assigneeFilter);
  }
  filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return scheduleStages.indexOf(a.stage) - scheduleStages.indexOf(b.stage);
  });

  const warnings = { overloaded: [], dueSoon: [], prereqMissing: [] };

  const workloadMap = {};
  filtered.filter(t => !t.completed).forEach(t => {
    const key = t.date + "|" + t.assignee;
    if (!workloadMap[key]) workloadMap[key] = [];
    workloadMap[key].push(t);
  });
  Object.entries(workloadMap).forEach(([key, tasks]) => {
    if (tasks.length >= MAX_TASKS_PER_DAY) {
      const [date, assignee] = key.split("|");
      warnings.overloaded.push({
        type: "overloaded",
        date,
        assignee,
        count: tasks.length,
        taskIds: tasks.map(t => t.id),
        message: assignee + " 在 " + date + " 有 " + tasks.length + " 个任务，超过每日上限 " + MAX_TASKS_PER_DAY + " 个"
      });
    }
  });

  const todayDate = new Date(today);
  filtered.filter(t => !t.completed && t.dueDate).forEach(t => {
    const dueDate = new Date(t.dueDate);
    const diffDays = Math.ceil((dueDate - todayDate) / (1000 * 60 * 60 * 24));
    if (diffDays <= DUE_DATE_WARNING_DAYS && diffDays >= -7) {
      warnings.dueSoon.push({
        type: "dueSoon",
        taskId: t.id,
        orderId: t.orderId,
        dueDate: t.dueDate,
        daysLeft: diffDays,
        isOverdue: diffDays < 0,
        message: diffDays < 0
          ? t.client + "·" + t.fishSpecies + " 已逾期 " + Math.abs(diffDays) + " 天"
          : t.client + "·" + t.fishSpecies + " 还有 " + diffDays + " 天交付"
      });
    }
  });

  const orderTasksMap = {};
  allTasks.forEach(t => {
    if (!orderTasksMap[t.orderId]) orderTasksMap[t.orderId] = [];
    orderTasksMap[t.orderId].push(t);
  });
  filtered.filter(t => !t.completed).forEach(t => {
    const stageIdx = scheduleStages.indexOf(t.stage);
    if (stageIdx > 0) {
      const prevStage = scheduleStages[stageIdx - 1];
      const orderTasks = orderTasksMap[t.orderId] || [];
      const prevTask = orderTasks.find(ot => ot.stage === prevStage);
      if (!prevTask || !prevTask.completed) {
        warnings.prereqMissing.push({
          type: "prereqMissing",
          taskId: t.id,
          orderId: t.orderId,
          stage: t.stage,
          prereqStage: prevStage,
          message: t.client + "·" + t.fishSpecies + " 的前置工序 " + prevStage + " 尚未完成"
        });
      }
    }
  });

  return {
    week: weekRange,
    weekdayLabels: WEEKDAY_LABELS,
    tasks: filtered,
    warnings,
    today
  };
}
