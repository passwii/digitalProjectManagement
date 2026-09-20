export type ChangelogKind = "功能" | "优化" | "修复" | "移动端" | "财务";

export interface ChangelogEntry {
  kind: ChangelogKind;
  title: string;
  description: string;
}

export interface ChangelogDay {
  date: string;
  entries: ChangelogEntry[];
}

export type ChangelogVersionId = "v1" | "v2";

export interface ChangelogVersion {
  id: ChangelogVersionId;
  label: string;
  title: string;
  summary: string;
  days: ChangelogDay[];
}

export const CHANGELOG_VERSIONS: ChangelogVersion[] = [
  {
    id: "v2",
    label: "V2",
    title: "扩展能力",
    summary: "围绕项目管理基本盘，补齐财务、移动端与协同能力。",
    days: [
      {
        date: "2026-09-20",
        entries: [
          {
            kind: "财务",
            title: "财务凭证与核实流程",
            description: "支持支出票据上传、凭证校验、核实与审核状态流转，让支出从登记走到可追溯。",
          },
          {
            kind: "优化",
            title: "项目台账筛选与操作区",
            description: "负责人筛选、项目排序、新建与删除操作进一步收口，常用动作更容易找到。",
          },
        ],
      },
      {
        date: "2026-09-19",
        entries: [
          {
            kind: "移动端",
            title: "PWA 外壳与移动端卡片流",
            description: "项目台账与审批中心适配手机卡片流，配合底部 Dock、三态抽屉和触控操作。",
          },
          {
            kind: "功能",
            title: "通讯录与我的友商",
            description: "补齐部门人员、通讯录、友商主数据、人员信息与业绩合同管理。",
          },
          {
            kind: "财务",
            title: "会计期间与财税规则基础能力",
            description: "建立会计期间生命周期、财税规则和标准账套，为后续财务闭环打基础。",
          },
        ],
      },
      {
        date: "2026-09-18",
        entries: [
          {
            kind: "功能",
            title: "附件与文档预览",
            description: "附件接入对象存储，支持业务目录、上传进度、拖拽粘贴、失败分层与预览。",
          },
          {
            kind: "移动端",
            title: "PWA 导航与下拉刷新",
            description: "移动端加入安全区适配、自建下拉刷新和稳定的五位导航结构。",
          },
          {
            kind: "优化",
            title: "项目客户字段与状态展示",
            description: "项目台账补充客户联系人等信息，并统一项目变更状态的中文展示。",
          },
        ],
      },
    ],
  },
  {
    id: "v1",
    label: "V1",
    title: "基础项目管理",
    summary: "让团队完成从立项、推进到支出归集的项目运营基本闭环。",
    days: [
      {
        date: "2026-09-01",
        entries: [
          {
            kind: "功能",
            title: "工作台",
            description: "集中查看项目健康度、进度、支出趋势和本周动态，快速掌握交付状态。",
          },
          {
            kind: "功能",
            title: "项目台账与进度跟踪",
            description: "支持项目创建、状态管理、年度筛选、任务、里程碑、进度填报和逾期识别。",
          },
          {
            kind: "功能",
            title: "审批中心与支出报表",
            description: "覆盖项目与支出审批、结果通知、支出登记、分类统计和报表查看。",
          },
          {
            kind: "功能",
            title: "账号与权限",
            description: "提供用户登录、首次登录改密、角色权限和账号操作菜单。",
          },
        ],
      },
    ],
  },
];
