import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IDENTITY_STORAGE_KEY,
  IDENTITY_UNAVAILABLE,
  displayNameOf,
  identityViewOf,
  parseIdentitySnapshot,
  serializeIdentitySnapshot,
  type IdentityUser,
} from "./identityCore";

const ME: IdentityUser = {
  id: 7,
  username: "13800000007",
  real_name: "张伟",
  roles: [{ code: "member", name: "项目成员" }],
};

describe("身份快照：token 绑定（BLF-1125）", () => {
  it("序列化后再解析，能还原本人数据", () => {
    const raw = serializeIdentitySnapshot(ME, "tok-a");
    assert.deepEqual(parseIdentitySnapshot(raw, "tok-a"), ME);
  });

  it("token 不一致时不认（换账号/会话失效后不能读到上一个人的姓名）", () => {
    const raw = serializeIdentitySnapshot(ME, "tok-a");
    assert.equal(parseIdentitySnapshot(raw, "tok-b"), null, "旧 token 的快照必须失效");
    assert.equal(parseIdentitySnapshot(raw, null), null, "无 token 时不得启用快照");
  });

  it("解析出来的对象是可用身份（含 roles），不是残缺对象", () => {
    const parsed = parseIdentitySnapshot(serializeIdentitySnapshot(ME, "t"), "t");
    assert.ok(parsed);
    assert.equal(parsed.id, 7);
    assert.equal(parsed.real_name, "张伟");
    assert.deepEqual(parsed.roles.map((r) => r.code), ["member"]);
  });

  it("登录成功后拿到的 Me 结构可直接当快照写入", () => {
    // 与后端 /auth/me 契约对齐的最小子集：id/username/real_name/roles
    const apiLike = { ...ME, status: "active", dept_id: null, must_change_pwd: false };
    const raw = serializeIdentitySnapshot(apiLike, "tok");
    assert.deepEqual(parseIdentitySnapshot(raw, "tok"), apiLike);
  });
});

describe("身份快照：坏数据一律不认（宁可骨架，也不能显示来路不明的人）", () => {
  const bad: [string, string][] = [
    ["空字符串", ""],
    ["非 JSON", "不是一个 JSON"],
    ["JSON 但不是对象", "42"],
    ["缺 token 字段", JSON.stringify({ me: ME })],
    ["token 类型不对", JSON.stringify({ token: 123, me: ME })],
    ["缺 me 字段", JSON.stringify({ token: "t" })],
    ["me 不是对象", JSON.stringify({ token: "t", me: "张伟" })],
    ["me 缺 id", JSON.stringify({ token: "t", me: { ...ME, id: undefined } })],
    ["me 的 id 是字符串", JSON.stringify({ token: "t", me: { ...ME, id: "7" } })],
    ["me 缺 real_name", JSON.stringify({ token: "t", me: { ...ME, real_name: undefined } })],
    ["roles 不是数组", JSON.stringify({ token: "t", me: { ...ME, roles: "member" } })],
    ["roles 混入垃圾项", JSON.stringify({ token: "t", me: { ...ME, roles: [{ code: 1, name: null }] } })],
  ];

  for (const [label, raw] of bad) {
    it(`${label} → null`, () => {
      assert.equal(parseIdentitySnapshot(raw, "t"), null);
    });
  }

  it("null / undefined 输入不抛错", () => {
    assert.equal(parseIdentitySnapshot(null, "t"), null);
    assert.equal(parseIdentitySnapshot("{}", null), null);
  });

  it("存储键名与 token 同级（登出清 token 时快照一并失效）", () => {
    assert.equal(IDENTITY_STORAGE_KEY, "pm_identity_v1");
  });
});

describe("展示名：real_name 优先，缺省回落 username", () => {
  it("有 real_name 时用它", () => {
    assert.equal(displayNameOf(ME), "张伟");
  });

  it("real_name 为空串时回落 username", () => {
    assert.equal(displayNameOf({ ...ME, real_name: "" }), "13800000007");
  });

  it("没有身份数据时返回空串——UI 据此渲染骨架，而不是编一个「当前用户」", () => {
    assert.equal(displayNameOf(null), "");
  });
});

describe("身份展示推导：未确认就骨架，绝不先插一个默认值（BLF-1125 的核心回归点）", () => {
  const ANY_VIEW_TEXT = (v: ReturnType<typeof identityViewOf>) =>
    [v.name, v.role?.text, v.role?.tip, v.roleShort].filter((x): x is string => typeof x === "string").join(" | ");

  it("身份与权限都没回来 → 姓名 null + 角色 null（渲染骨架，不输出任何文案）", () => {
    const v = identityViewOf({ me: null, isAdmin: null });
    assert.equal(v.name, null);
    assert.equal(v.role, null);
    assert.equal(v.roleShort, null);
    assert.equal(ANY_VIEW_TEXT(v), "", "未确认状态下不得产生任何可展示文案");
  });

  it("关键回归：「当前用户」绝不出现在任何展示路径上", () => {
    const cases = [
      identityViewOf({ me: null, isAdmin: null }),
      identityViewOf({ me: null, isAdmin: true }),
      identityViewOf({ me: null, isAdmin: false }),
      identityViewOf({ me: null, isAdmin: null, identityFailed: true }),
      identityViewOf({ me: ME, isAdmin: null }),
      identityViewOf({ me: ME, isAdmin: true }),
      identityViewOf({ me: ME, isAdmin: false }),
      identityViewOf({ me: ME, isAdmin: false, permsFailed: true }),
    ];
    for (const v of cases) {
      assert.ok(!ANY_VIEW_TEXT(v).includes("当前用户"), `出现了默认占位文案：${ANY_VIEW_TEXT(v)}`);
    }
  });

  it("有快照但权限未确认 → 姓名已就位（不再闪），角色区留空走骨架", () => {
    const v = identityViewOf({ me: ME, isAdmin: null });
    assert.equal(v.name, "张伟", "姓名来自快照，首帧即可显示真名");
    assert.equal(v.role, null, "权限未确认时不能断言角色");
    assert.equal(v.roleShort, null);
  });

  it("权限确认后是非管理员 → 姓名 + 普通用户角色行（含角色名提示）", () => {
    const v = identityViewOf({ me: ME, isAdmin: false });
    assert.equal(v.name, "张伟");
    assert.equal(v.role?.text, "普通用户 · 参与项目业务");
    assert.match(v.role?.tip ?? "", /项目成员/);
    assert.equal(v.roleShort, "项目成员");
  });

  it("权限确认后是管理员 → 管理员文案", () => {
    const v = identityViewOf({ me: ME, isAdmin: true });
    assert.equal(v.role?.text, "管理员 · 全局管理与审批");
    assert.equal(v.roleShort, "管理员");
  });

  it("无角色名时角色提示退化为中性说明，而不是空白", () => {
    const v = identityViewOf({ me: { ...ME, roles: [] }, isAdmin: false });
    assert.equal(v.role?.tip, "当前账号无管理与审批权限，仅参与项目业务");
  });

  it("权限同步失败 → 不谎称管理员，也不谎称普通用户", () => {
    const v = identityViewOf({ me: ME, isAdmin: false, permsFailed: true });
    assert.equal(v.role?.text, "权限信息加载失败");
    assert.ok(!ANY_VIEW_TEXT(v).includes("管理员"), "失败时不得声称管理员");
    assert.ok(!ANY_VIEW_TEXT(v).includes("普通用户"), "失败时不得声称普通用户");
    assert.equal(v.roleShort, "项目成员", "失败时可用快照里的角色名兜底展示");
  });

  it("权限同步失败且身无快照 → 顶栏短描述退化为「身份信息未同步」", () => {
    const v = identityViewOf({ me: null, isAdmin: null, permsFailed: true });
    assert.equal(v.roleShort, IDENTITY_UNAVAILABLE);
  });

  it("身份接口失败且无快照 → 如实告知未同步，而不是把骨架永远转下去", () => {
    const v = identityViewOf({ me: null, isAdmin: null, identityFailed: true });
    assert.equal(v.name, IDENTITY_UNAVAILABLE);
    assert.notEqual(v.name, null, "失败态必须收敛，不能一直停在骨架");
  });

  it("身份接口失败但有快照 → 继续显示快照姓名（不因一次失败丢掉已知身份）", () => {
    const v = identityViewOf({ me: ME, isAdmin: null, identityFailed: true });
    assert.equal(v.name, "张伟");
  });
});
