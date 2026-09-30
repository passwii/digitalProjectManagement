import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolvePopoverPlacement,
  type Rect,
} from "./datePopoverPosition";

/** 由四边构造矩形，宽高顺手算好，省得每条用例手写两遍。 */
function rect(top: number, left: number, right: number, bottom: number): Rect {
  return { top, left, right, bottom, width: right - left, height: bottom - top };
}

/** 常见默认：弹层 300×400，间距 4，安全边 8。 */
const POPOVER = { width: 300, height: 400 };

describe("弹层定位：竖直方向", () => {
  it("下方放得下时向下展开，高度取自然高度", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(100, 100, 300, 140),
      boundary: rect(0, 0, 800, 800),
      popover: POPOVER,
    });
    assert.equal(result.placement, "down");
    assert.equal(result.maxHeight, 400);
    assert.equal(result.width, 300);
    assert.equal(result.left, 0);
  });

  it("下方逼仄但上方宽裕时向上翻", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(350, 50, 250, 390),
      boundary: rect(0, 0, 400, 500),
      popover: POPOVER,
    });
    // 下方可用 500-390-4-8 = 98，放不下 400；上方可用 350-0-4-8 = 338，更宽裕
    assert.equal(result.placement, "up");
  });

  it("上下都放不下时留在下方，但把高度夹到可用空间", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(200, 0, 300, 240),
      boundary: rect(0, 0, 400, 500),
      popover: POPOVER,
    });
    // 下方可用 500-240-4-8 = 248；上方可用 200-0-4-8 = 188（更小，不翻）
    assert.equal(result.placement, "down");
    assert.equal(result.maxHeight, 248);
  });

  it("maxHeightCap 参与夹取", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(100, 0, 300, 140),
      boundary: rect(0, 0, 800, 2000),
      popover: { width: 300, height: 900 },
    });
    // 自然高度 900 > 上限 480，且下方空间充足 → 取上限
    assert.equal(result.maxHeight, 480);
  });
});

describe("弹层定位：水平方向", () => {
  it("右侧顶出容器时整块左移，右缘贴住 inset", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(100, 288, 488, 140),
      boundary: rect(0, 0, 500, 800),
      popover: POPOVER,
    });
    // width = min(300, 500-16) = 300；288+300 = 588 > 500-8 = 492
    // left = 492 - 300 - 288 = -96
    assert.equal(result.left, -96);
    assert.equal(result.width, 300);
    // 弹层右缘恰好落在容器右缘 inset 上
    assert.equal(288 + result.left + result.width, 500 - 8);
  });

  it("容器窄于弹层时把宽度夹到容器内", () => {
    const result = resolvePopoverPlacement({
      // trigger.left 取 8（= inset），左侧不再触发修正，便于单独看宽度夹取
      trigger: rect(100, 8, 58, 140),
      boundary: rect(0, 0, 200, 800),
      popover: POPOVER,
    });
    // width = min(300, 200-16) = 184
    assert.equal(result.width, 184);
    assert.equal(result.left, 0);
  });

  it("容器极窄时宽度不为负", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(100, 0, 10, 140),
      boundary: rect(0, 0, 10, 800),
      popover: POPOVER,
    });
    assert.equal(result.width, 0);
  });

  it("退化容器下左移过头会被拉回左缘", () => {
    const result = resolvePopoverPlacement({
      trigger: rect(100, 5, 8, 140),
      boundary: rect(0, 0, 10, 800),
      popover: { width: 300, height: 400 },
    });
    // 宽度夹成 0；右移修正后 left = (10-8) - 0 - 5 = -3，
    // 触发点回到 2 < 左缘 inset 8，于是再拉到 8-5 = 3
    assert.equal(result.left, 3);
    assert.equal(5 + result.left, 8);
  });
});

describe("弹层定位：结果永远落在容器 inset 之内", () => {
  const cases = [
    { trigger: rect(100, 100, 300, 140), boundary: rect(0, 0, 800, 800) },
    { trigger: rect(350, 50, 250, 390), boundary: rect(0, 0, 400, 500) },
    { trigger: rect(200, 0, 300, 240), boundary: rect(0, 0, 400, 500) },
    { trigger: rect(100, 288, 488, 140), boundary: rect(0, 0, 500, 800) },
    { trigger: rect(40, 0, 100, 80), boundary: rect(0, 0, 200, 300) },
    { trigger: rect(5, 2, 6, 40), boundary: rect(0, 0, 10, 100) },
    { trigger: rect(60, 760, 900, 100), boundary: rect(0, 720, 800, 900) },
  ];

  it("left 不越界，宽度/高度均非负且不超自然尺寸", () => {
    const inset = 8;
    for (const { trigger, boundary } of cases) {
      const result = resolvePopoverPlacement({
        trigger,
        boundary,
        popover: POPOVER,
        inset,
      });
      const popoverLeft = trigger.left + result.left;
      const popoverRight = popoverLeft + result.width;
      assert.ok(result.width >= 0, `width >= 0 for ${JSON.stringify(trigger)}`);
      assert.ok(result.maxHeight >= 0, `maxHeight >= 0 for ${JSON.stringify(trigger)}`);
      assert.ok(result.maxHeight <= POPOVER.height, "maxHeight 不超自然高度");
      assert.ok(result.width <= POPOVER.width, "width 不超自然宽度");
      // 容器本身比两侧 inset 之和还窄时，「落在 inset 内」这件事无解，
      // 算法只保证宽度夹到 0，不再断言左右边界。正常容器下必须成立。
      if (boundary.width >= inset * 2) {
        assert.ok(
          popoverLeft >= boundary.left + inset - 1e-6,
          `left 不越过容器左缘: ${popoverLeft} >= ${boundary.left + inset}`,
        );
        assert.ok(
          popoverRight <= boundary.right - inset + 1e-6,
          `right 不越过容器右缘: ${popoverRight} <= ${boundary.right - inset}`,
        );
      }
    }
  });
});
