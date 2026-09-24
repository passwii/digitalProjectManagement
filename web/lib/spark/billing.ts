export type BillingTab = "overview" | "cashier" | "members" | "marketing";

export const BILLING_TABS: readonly { value: BillingTab; label: string }[] = [
  { value: "overview", label: "总览" },
  { value: "cashier", label: "收银台" },
  { value: "members", label: "会员中心" },
  { value: "marketing", label: "营销活动" },
];

export const BILLING_METRICS = [
  { label: "今日营收", value: "¥48.62 万", delta: "+18.6%", tone: "cyan" as const, icon: "billing" as const },
  { label: "今日订单", value: "3,864", delta: "+12.4%", tone: "violet" as const, icon: "dashboard" as const },
  { label: "活跃会员", value: "1,486", delta: "+8.6%", tone: "amber" as const, icon: "permission" as const },
  { label: "客单价", value: "¥125.8", delta: "+4.2%", tone: "green" as const, icon: "compute" as const },
];

export const BILLING_REVENUE_DAYS = ["06-02", "06-03", "06-04", "06-05", "06-06", "06-07", "06-08"] as const;

// Captured SVG paths from the saved billing page; keeping the geometry preserves the original 7-day trend.
export const BILLING_REVENUE_SERIES = [
  {
    label: "会员",
    color: "#22d3ee",
    fill: "url(#billing-member-fill)",
    path: "M65,184.476C106.889,183.134,148.778,181.792,190.667,181.792C232.556,181.792,274.444,185.642,316.333,185.642C358.222,185.642,400.111,181.598,442,179.108C483.889,176.618,525.778,174.957,567.667,170.704C609.556,166.451,651.444,153.588,693.333,153.588C735.222,153.588,777.111,159.77,819,165.952",
    area: "M65,184.476C106.889,183.134,148.778,181.792,190.667,181.792C232.556,181.792,274.444,185.642,316.333,185.642C358.222,185.642,400.111,181.598,442,179.108C483.889,176.618,525.778,174.957,567.667,170.704C609.556,166.451,651.444,153.588,693.333,153.588C735.222,153.588,777.111,159.77,819,165.952L819,225L65,225Z",
  },
  {
    label: "散客",
    color: "#a855f7",
    fill: "url(#billing-walkin-fill)",
    path: "M65,134.58C106.889,134.14,148.778,133.7,190.667,133.7C232.556,133.7,274.444,143.314,316.333,143.314C358.222,143.314,400.111,133.96,442,127.584C483.889,121.208,525.778,114.89,567.667,105.056C609.556,95.222,651.444,68.58,693.333,68.58C735.222,68.58,777.111,84.42,819,100.26",
    area: "M65,134.58C106.889,134.14,148.778,133.7,190.667,133.7C232.556,133.7,274.444,143.314,316.333,143.314C358.222,143.314,400.111,133.96,442,127.584C483.889,121.208,525.778,114.89,567.667,105.056C609.556,95.222,651.444,68.58,693.333,68.58C735.222,68.58,777.111,84.42,819,100.26L819,165.952C777.111,159.77,735.222,153.588,693.333,153.588C651.444,153.588,609.556,166.451,567.667,170.704C525.778,174.957,483.889,176.618,442,179.108C400.111,181.598,358.222,185.642,316.333,185.642C274.444,185.642,232.556,181.792,190.667,181.792C148.778,181.792,106.889,183.134,65,184.476Z",
  },
  {
    label: "电竞酒店",
    color: "#34d399",
    fill: "url(#billing-hotel-fill)",
    path: "M65,113.372C106.889,112.228,148.778,111.084,190.667,111.084C232.556,111.084,274.444,119.422,316.333,119.422C358.222,119.422,400.111,109.159,442,101.536C483.889,93.913,525.778,85.945,567.667,73.684C609.556,61.423,651.444,27.968,693.333,27.968C735.222,27.968,777.111,45.59,819,63.212",
    area: "M65,113.372C106.889,112.228,148.778,111.084,190.667,111.084C232.556,111.084,274.444,119.422,316.333,119.422C358.222,119.422,400.111,109.159,442,101.536C483.889,93.913,525.778,85.945,567.667,73.684C609.556,61.423,651.444,27.968,693.333,27.968C735.222,27.968,777.111,45.59,819,63.212L819,100.26C777.111,84.42,735.222,68.58,693.333,68.58C651.444,68.58,609.556,95.222,567.667,105.056C525.778,114.89,483.889,121.208,442,127.584C400.111,133.96,358.222,143.314,316.333,143.314C274.444,143.314,232.556,133.7,190.667,133.7C148.778,133.7,106.889,134.14,65,134.58Z",
  },
] as const;

export const BILLING_PAYMENT_CHANNELS = [
  { name: "微信支付", value: 42, color: "#22d3ee" },
  { name: "支付宝", value: 34, color: "#a855f7" },
  { name: "会员余额", value: 16, color: "#34d399" },
  { name: "数字人民币", value: 6, color: "#fbbf24" },
  { name: "现金/银行卡", value: 2, color: "#64748b" },
] as const;

export const BILLING_RULES = [
  { period: "白天时段", time: "08:00 - 16:00", walkIn: "¥ 6/时", member: "¥ 4.5/时", privateRoom: "¥ 12/时" },
  { period: "黄金时段", time: "16:00 - 24:00", walkIn: "¥ 10/时", member: "¥ 8/时", privateRoom: "¥ 18/时" },
  { period: "通宵包段", time: "24:00 - 08:00", walkIn: "¥ 28 封顶", member: "¥ 22 封顶", privateRoom: "¥ 48 封顶" },
  { period: "节假日全天", time: "法定节假日", walkIn: "¥ 12/时", member: "¥ 9/时", privateRoom: "¥ 22/时" },
] as const;

export const BILLING_STORES = ["观前街旗舰店（姑苏区）", "苏州中心旗舰店", "昆山金鹰旗舰店"] as const;
export const CASHIER_TYPES = ["上机计费", "包厢计费", "商品零售"] as const;
export const CASHIER_METHODS = ["微信", "支付宝", "现金"] as const;
export const BILLING_RECHARGE_AMOUNTS = [100, 200, 500, 1000] as const;

export const BILLING_MEMBER_TIERS = [
  { name: "青铜会员", count: "8,420", discount: "95 折", recharge: "充 100 送 5", amount: 100 },
  { name: "白银会员", count: "4,860", discount: "90 折", recharge: "充 200 送 20", amount: 200 },
  { name: "黄金会员", count: "1,246", discount: "85 折", recharge: "充 500 送 80", amount: 500 },
  { name: "钻石会员", count: "328", discount: "75 折", recharge: "充 1000 送 220", amount: 1000 },
] as const;

export const BILLING_MEMBERS = [
  { id: "M10248", name: "陈*航", phone: "138****6624", tier: "钻石会员", balance: "2,864", points: "48,260", hours: "1,284 h", store: "苏州中心旗舰店" },
  { id: "M10326", name: "周*琳", phone: "139****2218", tier: "钻石会员", balance: "1,842", points: "36,480", hours: "968 h", store: "李公堤湖景店" },
  { id: "M11084", name: "王*宇", phone: "137****8862", tier: "黄金会员", balance: "986", points: "21,480", hours: "624 h", store: "独墅湖高校店" },
  { id: "M11266", name: "李*轩", phone: "135****4408", tier: "黄金会员", balance: "624", points: "16,840", hours: "486 h", store: "观前街旗舰店" },
  { id: "M12048", name: "赵*欣", phone: "136****2266", tier: "白银会员", balance: "386", points: "8,640", hours: "284 h", store: "狮山龙湖旗舰店" },
  { id: "M12684", name: "吴*凡", phone: "138****0044", tier: "白银会员", balance: "248", points: "5,240", hours: "168 h", store: "昆山金鹰旗舰店" },
] as const;

export const BILLING_CAMPAIGNS = [
  { name: "苏州中心店庆", kind: "店庆活动", offer: "满 100 减 30" },
  { name: "新客首充礼", kind: "会员充值", offer: "充 100 送 30" },
  { name: "暑期夜包券", kind: "时段优惠", offer: "通宵立减 8 元" },
  { name: "端午畅玩券", kind: "节日活动", offer: "满 50 减 15" },
] as const;
