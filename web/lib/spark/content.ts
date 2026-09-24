export type ContentTab = "games" | "events" | "additional" | "compliance";

export const CONTENT_TABS: readonly { value: ContentTab; label: string }[] = [
  { value: "games", label: "游戏库" },
  { value: "events", label: "电竞赛事" },
  { value: "additional", label: "增值内容" },
  { value: "compliance", label: "合规审核" },
];

export const CONTENT_SUBTITLE = "苏州全域统一内容分发 · P2SP + CDN 边缘加速 · 电竞赛事一站式运营";

export const CONTENT_METRICS = [
  { label: "游戏总数", value: "286", detail: "覆盖 5 大品类", tone: "cyan" as const, icon: "content" as const },
  { label: "今日分发量", value: "4,860", unit: "GB", detail: "P2P 命中率 92%", tone: "violet" as const, icon: "compute" as const },
  { label: "热门游戏", value: "24", detail: "近 7 日启动 Top", tone: "green" as const, icon: "dashboard" as const },
  { label: "待审核", value: "6", detail: "含 UGC / 更新包", tone: "amber" as const, icon: "security" as const },
];

export const GAME_CATEGORIES = ["全部", "MOBA", "FPS", "吃鸡", "3A 大作", "竞技体育"] as const;

export const CONTENT_GAMES = [
  { id: "G001", name: "英雄联盟", category: "MOBA", publisher: "腾讯", size: "32 GB", rating: "4.8", distribution: "34/34 店", popularity: 96 },
  { id: "G002", name: "无畏契约", category: "FPS", publisher: "腾讯", size: "28 GB", rating: "4.7", distribution: "34/34 店", popularity: 94 },
  { id: "G003", name: "CS2", category: "FPS", publisher: "Valve", size: "36 GB", rating: "4.9", distribution: "32/34 店", popularity: 88 },
  { id: "G004", name: "黑神话:悟空", category: "3A 大作", publisher: "游戏科学（杭州）", size: "128 GB", rating: "5.0", distribution: "34/34 店", popularity: 98 },
  { id: "G005", name: "APEX 英雄", category: "吃鸡", publisher: "EA", size: "68 GB", rating: "4.5", distribution: "28/34 店", popularity: 76 },
  { id: "G006", name: "绝地求生", category: "吃鸡", publisher: "Krafton", size: "82 GB", rating: "4.4", distribution: "30/34 店", popularity: 72 },
  { id: "G007", name: "永劫无间", category: "吃鸡", publisher: "网易", size: "48 GB", rating: "4.6", distribution: "32/34 店", popularity: 82 },
  { id: "G008", name: "DOTA 2", category: "MOBA", publisher: "Valve", size: "54 GB", rating: "4.7", distribution: "26/34 店", popularity: 68 },
  { id: "G009", name: "FC 26", category: "竞技体育", publisher: "EA", size: "72 GB", rating: "4.3", distribution: "22/34 店", popularity: 58 },
  { id: "G010", name: "原神", category: "3A 大作", publisher: "米哈游", size: "96 GB", rating: "4.6", distribution: "30/34 店", popularity: 80 },
] as const;

export const CONTENT_EVENT_STATUSES = ["全部", "直播中", "报名中", "即将开赛"] as const;

export const CONTENT_EVENTS = [
  { id: "T2026-061", name: "苏州电竞节 · 无畏契约城市挑战赛", game: "无畏契约", venue: "苏州国际博览中心 C1 馆", time: "2026-06-08 19:00", teams: 16, prizePool: "¥ 200,000", status: "直播中", viewers: "126,800" },
  { id: "T2026-058", name: "金鸡湖杯 · 英雄联盟高校联赛", game: "英雄联盟", venue: "独墅湖高教区体育中心", time: "2026-06-14 14:00", teams: 24, prizePool: "¥ 80,000", status: "报名中" },
  { id: "T2026-055", name: "观前夜战 · CS2 民间公开赛", game: "CS2", venue: "观前街玄妙广场主舞台", time: "2026-06-21 18:30", teams: 32, prizePool: "¥ 50,000", status: "即将开赛" },
  { id: "T2026-052", name: "昆山花桥 · 永劫无间选拔赛", game: "永劫无间", venue: "昆山花桥国际商务城", time: "2026-07-05 13:00", teams: 20, prizePool: "¥ 60,000", status: "报名中" },
] as const;

export const CONTENT_LEADERBOARD = [
  { rank: "1", tag: "SP", name: "Suzhou Phantoms 苏州幻影", wins: 18, losses: 2, points: 54 },
  { rank: "2", tag: "GT", name: "Gusu Tigers 姑苏虎", wins: 16, losses: 4, points: 48 },
  { rank: "3", tag: "JL", name: "Jinji Lake Esports 金鸡湖", wins: 14, losses: 6, points: 42 },
  { rank: "4", tag: "SL", name: "SND Lions 高新狮", wins: 12, losses: 8, points: 36 },
  { rank: "5", tag: "KD", name: "Kunshan Dragons 昆山龙", wins: 10, losses: 10, points: 30 },
  { rank: "6", tag: "WW", name: "Wujiang Wolves 吴江狼", wins: 8, losses: 12, points: 24 },
] as const;

export const CONTENT_ADDITIONAL = [
  { name: "院线大片同步", description: "500+ 部正版电影 · 4K HDR", metric: "月活 8,640", category: "院线大片同步" },
  { name: "电竞音乐专区", description: "Hi-Res 无损 · 游戏原声", metric: "曲库 12 万", category: "电竞音乐专区" },
  { name: "电竞赛事直播", description: "LPL / VCT / 主客场多路", metric: "今日观看 3,486", category: "电竞赛事直播" },
  { name: "电竞主播陪玩", description: "认证主播 248 位", metric: "今日订单 486", category: "电竞主播陪玩" },
] as const;

export const CONTENT_REVIEW_TYPES = ["全部", "UGC 地图", "直播回放", "图文内容", "语音包"] as const;

export const CONTENT_REVIEW_QUEUE = [
  { id: "review-1", name: "玩家自制 CS2 地图 de_gusu", type: "UGC 地图", submitter: "玩家@姑苏烟雨", submitted: "10 分钟前", risk: "低风险" },
  { id: "review-2", name: "苏州中心店店内赛事直播录像", type: "直播回放", submitter: "苏州中心旗舰店", submitted: "32 分钟前", risk: "低风险" },
  { id: "review-3", name: "观前街店战队招募海报", type: "图文内容", submitter: "观前街旗舰店", submitted: "1 小时前", risk: "待复核" },
  { id: "review-4", name: "玩家语音包（吴语版）", type: "语音包", submitter: "玩家@园区码农", submitted: "2 小时前", risk: "待复核" },
] as const;
