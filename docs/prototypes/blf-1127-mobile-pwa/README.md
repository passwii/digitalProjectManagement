# 手机端 PWA 原型（BLF-1127）

## 打开方式

```bash
open docs/prototypes/blf-1127-mobile-pwa/index.html
```

单文件、零依赖、双击即可看。左侧是 390×844 的手机画布，右侧是方案说明。

## 可交互的东西

| 操作 | 效果 |
| --- | --- |
| 直接点底部 Dock | 打开对应的 peek 抽屉（不跳页） |
| 再点当前 Dock | peek 收起；half/full 降回 peek |
| 拖抽屉顶部（手势条或标题） | 上拖 peek → half → full；下甩降档 / 关闭 |
| 点遮罩 | 关闭抽屉 |
| 点卡片 | 进入模块或项目详情 |
| 顶部工具条 | 切换 6 个场景、模拟键盘抬起、切换普通用户 / 管理员视角、360/390/430 三档宽度 |

场景按钮对应需求里的三件事：①登录页居中、②底部 Dock、③Dock 展开（peek 卡片 / 全屏抽屉）。

「管理员视角」用来对比 `/meta/me/menus` 两种菜单集合：普通用户看不到审批中心 / 系统管理 / 通讯录，管理员在「我的」抽屉里能看到并带待办红点。

## 自检

```bash
python3 docs/prototypes/blf-1127-mobile-pwa/verify.py
```

无头 Chrome 里真实点一遍，50 项断言（几何 / 触控尺寸 / 权限可见性 / 横向溢出 / 字号下限 / 无 JS 报错），
并把截图写到 `shots/`。需要本机已装 Google Chrome（脚本用 `channel="chrome"`）。

## 这是原型，不是成品代码

- 视觉令牌与动效曲线都取自 `web/app/globals.css` 与 `components/ui/Shell.module.css`，可 1:1 迁移；
- 业务数据取自 `scripts/seed_mock.py` 的真实演示项目（企业官网改版 / CRM 系统一期实施）；
- 落地映射见 `docs/superpowers/specs/2026-09-18-mobile-pwa-navigation-design.md` 第 7 节。
