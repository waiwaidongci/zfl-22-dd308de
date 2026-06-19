export const DEFAULT_BRANCH_ID = "BR-DEFAULT";

export const stages = ["待拓印", "晾干中", "装裱中", "待取件", "已完成"];
export const scheduleStages = ["待拓印", "晾干中", "装裱中", "待取件"];
export const MAX_TASKS_PER_DAY = 5;
export const DUE_DATE_WARNING_DAYS = 3;
export const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export const MATERIAL_CATEGORIES = {
  PAPER: "纸张",
  INK: "墨料",
  CINNABAR: "朱砂",
  MOUNTING_AXLE: "装裱轴头"
};

export const DEFAULT_MATERIALS = [
  { id: "M-001", name: "手工楮皮纸", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 50, reserved: 0, threshold: 10, unitCost: 8, note: "四尺整纸规格 69x138cm" },
  { id: "M-002", name: "云母宣", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 80, reserved: 0, threshold: 15, unitCost: 5, note: "四尺整纸规格 69x138cm" },
  { id: "M-003", name: "净皮宣", category: MATERIAL_CATEGORIES.PAPER, unit: "张", stock: 60, reserved: 0, threshold: 15, unitCost: 6, note: "四尺整纸规格 69x138cm" },
  { id: "M-004", name: "墨料", category: MATERIAL_CATEGORIES.INK, unit: "克", stock: 500, reserved: 0, threshold: 100, unitCost: 0.5, note: "松烟墨粉" },
  { id: "M-005", name: "朱砂", category: MATERIAL_CATEGORIES.CINNABAR, unit: "克", stock: 100, reserved: 0, threshold: 20, unitCost: 3, note: "书画朱砂粉" },
  { id: "M-006", name: "装裱轴头(木)", category: MATERIAL_CATEGORIES.MOUNTING_AXLE, unit: "对", stock: 30, reserved: 0, threshold: 5, unitCost: 15, note: "实木轴头，四尺用" },
  { id: "M-007", name: "装裱轴头(仿红木)", category: MATERIAL_CATEGORIES.MOUNTING_AXLE, unit: "对", stock: 20, reserved: 0, threshold: 5, unitCost: 25, note: "仿红木轴头，四尺用" }
];

export const STAGE_DURATION_DAYS = {
  "待拓印": 1,
  "晾干中": 2,
  "装裱中": 2,
  "待取件": 1
};

export const DISPLAY_LEVELS = [
  { value: "standard", label: "普通作品" },
  { value: "featured", label: "精选作品" },
  { value: "flagship", label: "镇店之宝" }
];

export const AUTHORIZATION_STATUS = [
  { value: "unauthorized", label: "未授权" },
  { value: "authorized", label: "已授权展示" }
];

export const DEFAULT_THEME_TAGS = [
  "吉祥寓意", "节日主题", "山水意境", "文人雅趣",
  "传统吉祥", "现代简约", "送礼佳品", "收藏级",
  "家庭装饰", "办公陈设"
];

export const seed = {
  materials: JSON.parse(JSON.stringify(DEFAULT_MATERIALS)),
  materialTransactions: [],
  orders: [
    {
      id: "FT-2601",
      client: "沈钧",
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
      tasks: [
        { id: "T-2601-1", stage: "待拓印", assignee: "阿青", date: "2026-06-13", note: "右侧直接拓印", completed: true, createdAt: "2026-06-12T09:00:00.000Z", updatedAt: "2026-06-13T15:30:00.000Z" },
        { id: "T-2601-2", stage: "晾干中", assignee: "阿青", date: "2026-06-17", note: "自然晾干，注意湿度", completed: false, createdAt: "2026-06-13T15:30:00.000Z", updatedAt: "2026-06-13T15:30:00.000Z" }
      ],
      history: [
        { at: "2026-06-12T09:00:00.000Z", stage: "待拓印", note: "客户送鱼并确认尺寸" },
        { at: "2026-06-13T15:30:00.000Z", stage: "晾干中", note: "完成右侧直接拓印" }
      ]
    },
    {
      id: "FT-2600",
      client: "周明远",
      fishSpecies: "黑鲷",
      size: "60x30cm",
      paper: "云母宣",
      inkPlan: "浓墨鱼身，浓淡对比",
      mounting: "镜片",
      inscription: "渔乐无穷",
      owner: "阿青",
      price: 1500,
      paid: true,
      payments: [
        { id: "PAY-2600-1", type: "定金", amount: 500, paidAt: "2026-06-01", note: "微信转账" },
        { id: "PAY-2600-2", type: "尾款", amount: 1000, paidAt: "2026-06-10", note: "取件时现金结清" }
      ],
      dueDate: "2026-06-10",
      status: "已完成",
      archived: false,
      tasks: [
        { id: "T-2600-1", stage: "待拓印", assignee: "阿青", date: "2026-06-02", note: "浓墨拓印", completed: true, createdAt: "2026-06-01T09:00:00.000Z", updatedAt: "2026-06-03T14:00:00.000Z" },
        { id: "T-2600-2", stage: "晾干中", assignee: "阿青", date: "2026-06-04", note: "晾干两天", completed: true, createdAt: "2026-06-03T14:00:00.000Z", updatedAt: "2026-06-06T10:00:00.000Z" },
        { id: "T-2600-3", stage: "装裱中", assignee: "阿青", date: "2026-06-07", note: "镜片装裱", completed: true, createdAt: "2026-06-06T10:00:00.000Z", updatedAt: "2026-06-09T16:00:00.000Z" },
        { id: "T-2600-4", stage: "待取件", assignee: "阿青", date: "2026-06-10", note: "通知客户取件", completed: true, createdAt: "2026-06-09T16:00:00.000Z", updatedAt: "2026-06-10T11:00:00.000Z" }
      ],
      history: [
        { at: "2026-06-01T09:00:00.000Z", stage: "待拓印", note: "新委托接单" },
        { at: "2026-06-03T14:00:00.000Z", stage: "晾干中", note: "完成拓印" },
        { at: "2026-06-06T10:00:00.000Z", stage: "装裱中", note: "开始装裱" },
        { at: "2026-06-09T16:00:00.000Z", stage: "待取件", note: "装裱完成" },
        { at: "2026-06-10T11:00:00.000Z", stage: "已完成", note: "客户取件并结清" }
      ]
    }
  ],
  works: [
    {
      id: "W-001",
      orderId: "FT-2599",
      client: "李渔",
      fishSpecies: "鲈鱼",
      size: "80x40cm",
      paper: "手工楮皮纸",
      inkPlan: "淡墨鱼身，朱砂点睛",
      mounting: "立轴",
      inscription: "烟波钓徒",
      owner: "阿青",
      completedAt: "2026-05-20T10:00:00.000Z",
      themeTags: ["文人雅趣", "山水意境"],
      displayLevel: "featured",
      clientAuthorization: "authorized"
    },
    {
      id: "W-002",
      orderId: "FT-2598",
      client: "张潮",
      fishSpecies: "真鲷",
      size: "65x32cm",
      paper: "云母宣",
      inkPlan: "浓淡墨渐变",
      mounting: "册页",
      inscription: "海阔凭鱼跃",
      owner: "阿青",
      completedAt: "2026-05-15T15:30:00.000Z",
      themeTags: ["吉祥寓意", "送礼佳品"],
      displayLevel: "standard",
      clientAuthorization: "unauthorized"
    }
  ]
};
