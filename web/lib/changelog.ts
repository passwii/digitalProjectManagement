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
    summary: "围绕项目管理基本盘，扩展财务、商机、附件预览、移动端与协同能力，并持续收敛日常操作体验与稳定性。",
    days: [
      {
        date: "2026-09-22",
        entries: [
          {
            kind: "功能",
            title: "附件图片与 PDF 预览升级",
            description: "统一合同、项目、凭证等附件的预览入口；图片支持点击放大、焦点回收与 Esc 关闭，PDF 支持多页渲染、缩放、适应宽度和失败重试，并补齐中文字体与静态资源加载。",
          },
          {
            kind: "修复",
            title: "最近项目与搜索状态同步",
            description: "删除项目后自动清理最近使用记录；项目选择器重新校验最近项目的可见性与最新编号，避免删除、权限变化或并发更新后继续展示过期项目。",
          },
        ],
      },
      {
        date: "2026-09-21",
        entries: [
          {
            kind: "功能",
            title: "商机管理",
            description: "新增商机列表与建档能力，支持按关键词、阶段、负责人筛选，维护客户、预计金额、预计签约日、负责人和商机阶段，并覆盖新增、编辑、删除与审计记录。",
          },
          {
            kind: "功能",
            title: "项目台账与友商档案优化",
            description: "整理项目合同字段、客户信息、年度筛选与友商合同附件，统一项目负责人、业绩合同和档案信息的维护口径，减少重复字段与重复录入。",
          },
          {
            kind: "功能",
            title: "公共附件预览能力",
            description: "将附件预览收敛为可复用组件，项目、通讯录、友商、凭证等业务统一处理图片与 PDF 内联预览；不支持内联的文档保留下载引导，并收口对象 URL 的释放生命周期。",
          },
          {
            kind: "优化",
            title: "读取请求自动恢复",
            description: "网络抖动或服务端短暂异常时，读取请求保留已加载内容并以指数退避后台重试；网络恢复、页面重新聚焦或回到前台时立即恢复，写操作不做无限重试。",
          },
        ],
      },
      {
        date: "2026-09-20",
        entries: [
          {
            kind: "财务",
            title: "财务凭证与核实流程",
            description: "建立账套、会计期间、凭证与支出票据全流程，支持凭证模板和 Excel 流转，补齐凭证校验、核实、审核与入账隔离，让支出从登记走到可追溯。",
          },
          {
            kind: "财务",
            title: "对账、固定资产与往来管理",
            description: "新增出纳与银行对账、固定资产折旧、应收应付核销和账龄管理，并将财务账套角色与岗位权限分开，覆盖现金、资产与往来的日常核算场景。",
          },
          {
            kind: "优化",
            title: "工作台与列表体验统一",
            description: "统一工作台页头、筛选区、主操作区、列表容器与分页定位，优化宽屏比例并恢复桌面滚动，让项目、进度、报表、成本等页面的操作位置更一致。",
          },
          {
            kind: "优化",
            title: "项目台账筛选与操作区",
            description: "负责人按姓名精确筛选，支持年度筛选与默认倒序；新建、删除、排序、分页等常用操作进一步收口并与筛选区域隔离，减少误操作。",
          },
          {
            kind: "优化",
            title: "账号会话安全",
            description: "同一账号仅保留一个有效会话，新登录会让旧会话失效，减少共享账号或过期登录状态造成的权限风险。",
          },
        ],
      },
      {
        date: "2026-09-19",
        entries: [
          {
            kind: "移动端",
            title: "PWA 外壳与移动端卡片流",
            description: "项目台账与审批中心适配手机卡片流，配合五位底部 Dock、peek/half/full 三态抽屉和触控操作，移动端核心任务可以在窄屏内完成。",
          },
          {
            kind: "功能",
            title: "通讯录与我的友商",
            description: "补齐部门人员、通讯录、友商主数据、联系人、业绩合同与附件管理，支持从人员查找、友商建档到合同资料维护的协同链路。",
          },
          {
            kind: "财务",
            title: "会计期间与财税规则基础能力",
            description: "建立会计期间生命周期、财税规则、科目层级与标准账套，为凭证、对账、固定资产和往来核销等后续财务闭环打基础。",
          },
        ],
      },
      {
        date: "2026-09-18",
        entries: [
          {
            kind: "功能",
            title: "附件与文档预览",
            description: "附件接入 R2 对象存储并按合同、项目、凭证、档案归档，支持上传进度、拖拽粘贴、502/404/400 失败分层和预览下载。",
          },
          {
            kind: "移动端",
            title: "PWA 导航与下拉刷新",
            description: "移动端加入 manifest、safe-area、viewport-fit、overscroll 与自建下拉刷新，配合稳定的五位导航结构和安装资源提示。",
          },
          {
            kind: "优化",
            title: "项目客户字段与状态展示",
            description: "项目台账补充客户联系人、联系方式和合同金额等信息，并统一项目变更状态的中文展示，减少业务字段理解成本。",
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
