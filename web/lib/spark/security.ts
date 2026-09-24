export const SECURITY_METRICS = [
  { label: "综合安全评分", value: "96.8", unit: "/100", tone: "cyan", icon: "security" },
  { label: "今日拦截威胁", value: "68", unit: "次", tone: "rose", icon: "security" },
  { label: "实名认证率", value: "99.2", unit: "%", tone: "violet", icon: "permission" },
  { label: "合规达标率", value: "100", unit: "%", tone: "green", icon: "dashboard" },
] as const;

export const SECURITY_POLICIES = [
  { id: "identity", title: "实名认证与人证合一", description: "对接公安身份认证 + 人脸识别，支持电子身份证", detail: "今日认证 1,486 人 · 通过率 99.2%", enabled: true },
  { id: "minor", title: "未成年人防沉迷", description: "未成年仅周五/六/日及法定节假日 20:00-21:00 可游戏", detail: "今日拦截未成年 42 人 · 已通知家长 38 人", enabled: true },
  { id: "device", title: "终端外设与网络管控", description: "禁用 USB 存储 / 截屏录屏 / 非法外挂 / 境外非法网站", detail: "今日阻断外设接入 18 次 · 外挂拦截 6 次", enabled: true },
  { id: "audit", title: "全量行为审计日志", description: "登录 / 消费 / 操作 / 内容访问，留存 180 天", detail: "今日日志 186,420 条 · 上链存证 24,680 条", enabled: true },
] as const;

export const SECURITY_AUDIT_LOGS = [
  { time: "22:28:14", store: "苏州中心旗舰店", user: "M10248 陈*航", action: "上机登录", target: "终端 A-047", ip: "10.18.2.47", result: "通过" },
  { time: "22:26:42", store: "观前街旗舰店", user: "未认证用户", action: "访问拦截", target: "境外游戏加速节点", ip: "10.22.4.12", result: "已拦截" },
  { time: "22:24:08", store: "独墅湖高校店", user: "未成年(16岁)", action: "22:00 防沉迷强制下线", target: "终端 C-082", ip: "10.31.6.82", result: "告警" },
  { time: "22:22:36", store: "李公堤湖景店", user: "M10326 周*琳", action: "电竞酒店房态开通", target: "客房 8602", ip: "10.24.8.6", result: "通过" },
  { time: "22:18:52", store: "昆山金鹰旗舰店", user: "店长 江慕白", action: "退款审批", target: "订单 #SZ202606082218", ip: "10.42.2.1", result: "通过" },
  { time: "22:15:20", store: "狮山龙湖旗舰店", user: "M11842 黄*宇", action: "修改会员手机号", target: "会员档案", ip: "10.12.4.88", result: "告警" },
  { time: "22:12:04", store: "相城天虹旗舰店", user: "系统", action: "USB 外接设备阻断", target: "终端 B-031", ip: "10.38.2.31", result: "已拦截" },
  { time: "22:08:48", store: "吴江万象汇店", user: "M12268 吴*凡", action: "充值 ¥200", target: "微信支付", ip: "10.48.2.66", result: "通过" },
] as const;

export const SECURITY_ENCRYPTION = [
  { title: "账号密码", value: "bcrypt + 国密 SM3" },
  { title: "支付交易", value: "TLS 1.3 + AES-256-GCM" },
  { title: "个人信息", value: "国密 SM4 字段级加密" },
  { title: "视频流", value: "AES-128 端到端加密" },
  { title: "审计日志", value: "区块链存证 + 哈希校验" },
] as const;

export const SECURITY_DISASTER_RECOVERY = [
  { title: "数据库全量备份", value: "每日 02:00" },
  { title: "增量归档", value: "每 15 分钟" },
  { title: "异地容灾", value: "苏州 + 上海双活" },
  { title: "RPO / RTO", value: "< 1 分钟 / < 5 分钟" },
] as const;

export const REGULATORY_CONNECTIONS = [
  { name: "苏州市文化广电和旅游局", scope: "网吧实名登记 / 电竞酒店内容审核", sync: "22:00 实时上报" },
  { name: "苏州市公安局网安支队", scope: "实名身份 / 网络安全 / 案件协查", sync: "22:28 实时同步" },
  { name: "江苏省通信管理局", scope: "IDC/云资源 / 网络数据安全", sync: "今日 09:00 日报" },
  { name: "苏州市消防救援支队", scope: "消防物联网 / 烟感告警联动", sync: "22:30 心跳正常" },
  { name: "国家税务总局苏州市税务局", scope: "电子发票自动开具 / 营收对账", sync: "今日开票 1,284 张" },
] as const;
