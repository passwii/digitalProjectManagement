import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const financePage = readFileSync(join(root, "app/(dashboard)/finance/page.tsx"), "utf8");
const arapPanel = readFileSync(join(root, "app/(dashboard)/finance/ArapPanel.tsx"), "utf8");
const api = readFileSync(join(root, "lib/api.ts"), "utf8");
const membersDialog = join(root, "app/(dashboard)/finance/BookMembersDialog.tsx");

describe("财务模块统一授权", () => {
  it("以 canFinance 作为财务页门禁，并准确说明模块未分配", () => {
    expect(financePage).toMatch(/if \(!canFinance\) return <NoAccess title="未分配财务管理模块"/);
    expect(financePage).not.toMatch(/\bisAdmin\b/);
  });

  it("finance 用户可使用新建、回收站和移入回收站操作", () => {
    const actions = financePage.slice(financePage.indexOf("const bookActions"), financePage.indexOf("function handleMobileMenuKeyDown"));
    expect(actions).toContain("+ 新建账套");
    expect(actions).toContain("账套回收站");
    expect(actions).toContain("移入回收站");
    expect(financePage).toMatch(/<AccountBookRecycleBinDialog/);
    expect(financePage).toMatch(/<MoveBookToRecycleBinDialog/);
    expect(financePage).not.toMatch(/BookMembersDialog|成员与权限|bookMembersOpen/);
  });

  it("应收应付配置和辅助资料操作不再按管理员身份隐藏", () => {
    expect(arapPanel).not.toMatch(/\bisAdmin\b/);
    expect(arapPanel).toMatch(/辅助资料/);
    expect(arapPanel).toMatch(/新增资料/);
    expect(arapPanel).toMatch(/请在右上方新增辅助资料/);
    expect(arapPanel).not.toMatch(/请先由管理员维护|管理员维护/);
  });

  it("移除账套成员授权的组件和客户端 API", () => {
    expect(existsSync(membersDialog)).toBe(false);
    expect(api).not.toMatch(/FinanceRole|FinanceBookMember|saveMember|removeMember|members:/);
  });
});
