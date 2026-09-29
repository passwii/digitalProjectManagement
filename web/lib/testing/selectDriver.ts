/**
 * 自绘下拉（`components/ui/Select`）在 DOM 测试里的驱动方式。
 *
 * 背景：PR #106 把原生 `<select>` 换成了 button + portal 的自绘控件，选项只在
 * 展开时渲染进 `document.body`。原先测试统一用的
 * `fireEvent.change(nativeSelect, { target: { value } })` 对新控件**完全无效**，
 * 而且不会报错——值一直是空，直到提交那一刻才以「接口没被调用」的形式炸出来，
 * 报错信息还指向毫不相干的断言，排查成本很高。
 *
 * 所以这里统一走真实用户路径：点开触发器 → 点选项。
 *
 * ⚠️ 只在 `*.dom.vitest.test.tsx` 里用（需要 jsdom + testing-library）。
 * 文件名刻意不带 `.test.`，否则会被 `tsconfig.test.json` 里那条
 * 「收 `lib` 下所有 `.test.ts`」的 include 划进 node:test 那套
 * （那里既没有 DOM 也没有 testing-library）。
 */
import { fireEvent, screen, within } from "@testing-library/react";

/**
 * 取出刚展开的那个 listbox。
 *
 * 不能靠 aria-label 关联：不少地方是 `<label><span>标题</span><Select/></label>`
 * 这种包裹式写法，`getByLabelText` 能靠外层 label 找到触发器，但 Select 自己
 * 并没收到 `aria-label`，渲染出来的 listbox 也就没有可访问名。
 *
 * 改用「最后一个」定位：portal 每次都往 `document.body` 末尾追加容器，
 * 所以最近点开的那个 listbox 在 DOM 顺序上一定排在最后。
 */
function openedListbox(): HTMLElement {
  const listboxes = screen.queryAllByRole("listbox");
  if (!listboxes.length) {
    throw new Error("没有找到已展开的下拉列表：触发器可能不可用、被 disabled，或选项为空");
  }
  return listboxes[listboxes.length - 1];
}

/** 展开某个下拉，返回它的 listbox；用于只断言选项内容、不做选择。 */
export function openSelect(label: string): HTMLElement {
  fireEvent.click(screen.getByLabelText(label));
  return openedListbox();
}

/** 展开某个下拉并选中指定选项——替代旧控件的 `fireEvent.change`。 */
export function selectOption(label: string, option: string | RegExp): void {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(within(openedListbox()).getByRole("option", { name: option }));
}

/**
 * 读出下拉当前选中项的可见文案。
 *
 * 旧的 `(getByLabelText(x) as HTMLSelectElement).value` 读的是原生 value（内部 id），
 * 新控件的触发器是 button，没有 value 属性，只有 `<span>{选中项文案}</span>`。
 * 断言可见文案比断言内部 id 更贴近用户实际看到的东西。
 */
export function selectedText(label: string): string {
  return screen.getByLabelText(label).textContent ?? "";
}
