import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRecentProjects,
  rememberProject,
  reconcileValidatedRecentProjects,
  removeRecentProject,
  syncRecentProjects,
} from "./recentProjects";

const STORAGE_KEY = "pm_recent_projects_v1";

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  (globalThis as unknown as { window: { localStorage: typeof storage } }).window = {
    localStorage: storage,
  };
  return storage;
}

test("删除项目后，最近项目快照不再返回该项目", () => {
  const storage = installStorage();
  rememberProject({ id: 101, code: "PJ-OLD", name: "旧项目" });
  rememberProject({ id: 202, code: "PJ-KEEP", name: "保留项目" });

  const next = removeRecentProject(101);

  assert.deepEqual(next, [{ id: 202, code: "PJ-KEEP", name: "保留项目" }]);
  assert.deepEqual(loadRecentProjects(), next);
  assert.equal(storage.getItem(STORAGE_KEY), JSON.stringify(next));
});

test("服务端校验合并最新快照时，保留校验期间新选择的项目", () => {
  const stored = [
    { id: 101, code: "PJ-OLD", name: "旧项目" },
    { id: 202, code: "PJ-KEEP", name: "保留项目" },
  ];
  const latest = [
    { id: 303, code: "PJ-NEW", name: "新选择项目" },
    ...stored,
  ];

  const next = reconcileValidatedRecentProjects(stored, latest, [stored[1]]);

  assert.deepEqual(next, [
    { id: 303, code: "PJ-NEW", name: "新选择项目" },
    { id: 202, code: "PJ-KEEP", name: "保留项目" },
  ]);
});

test("服务端校验时，用最新项目编号和名称更新 Recent 快照", () => {
  installStorage();
  const stored = [{ id: 12, code: "PJ-OLD-001", name: "项目旧名称" }];
  const latest = [...stored];
  const validated = [{ id: 12, code: "SHZK-NEW-001", name: "项目新名称" }];

  const next = reconcileValidatedRecentProjects(stored, latest, validated);
  syncRecentProjects(next);

  assert.deepEqual(next, validated);
  assert.deepEqual(loadRecentProjects(), validated);
});
