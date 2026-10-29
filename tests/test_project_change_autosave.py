"""项目简介自动保存的日志合并。

正文输入框每停顿约 900ms 就 PATCH 一次；若每次保存都追加一条留痕，「日志」
会变成整段文字的逐字符演变链。连续保存应合并成一条「本次编辑前 → 最终内容」，
且已经产生的历史记录也应在读取时折叠。
"""
from datetime import timedelta

from api.core.timeutil import app_now
from api.models import ProjectChange, User
from tests.test_project_changes_ledger import create_project, login


def description_changes(client, headers, project_id):
    response = client.get(f"/api/v1/projects/{project_id}/changes", headers=headers)
    assert response.status_code == 200, response.text
    return [row for row in response.json() if row["field"] == "description"]


def test_consecutive_description_autosaves_create_one_history_entry(client, db):
    headers = login(client, "pm")
    project = create_project(client, headers)
    texts = [
        "昆山移动电子政务外网项目",
        "昆山移动电子政务外网项目过单",
        "昆山移动电子政务外网项目过单，这是数慧的后向单位。",
    ]

    for text in texts:
        response = client.patch(
            f"/api/v1/projects/{project['id']}",
            headers=headers,
            json={"description": text},
        )
        assert response.status_code == 200, response.text

    session = db()
    try:
        rows = (
            session.query(ProjectChange)
            .filter_by(project_id=project["id"], field="description")
            .order_by(ProjectChange.id)
            .all()
        )
    finally:
        session.close()

    assert len(rows) == 1
    assert rows[0].old == ""
    assert rows[0].new == texts[-1]

    listed = description_changes(client, headers, project["id"])
    assert len(listed) == 1
    assert listed[0]["old"] == ""
    assert listed[0]["new"] == texts[-1]


def test_existing_description_autosave_rows_are_collapsed_when_listed(client, db):
    headers = login(client, "pm")
    project = create_project(client, headers)
    base = app_now() - timedelta(minutes=4)

    session = db()
    try:
        user_id = session.query(User.id).filter(User.username == "pm").scalar()
        for offset, old, new in [
            (0, "", "昆山"),
            (1, "昆山", "昆山移动"),
            (2, "昆山移动", "昆山移动电子政务外网项目"),
        ]:
            session.add(
                ProjectChange(
                    project_id=project["id"],
                    field="description",
                    old=old,
                    new=new,
                    by_id=user_id,
                    at=base + timedelta(minutes=offset),
                )
            )
        session.commit()
    finally:
        session.close()

    listed = description_changes(client, headers, project["id"])
    assert len(listed) == 1
    assert listed[0]["old"] == ""
    assert listed[0]["new"] == "昆山移动电子政务外网项目"


def test_description_edits_in_separate_sessions_stay_separate(client, db):
    headers = login(client, "pm")
    project = create_project(client, headers)
    now = app_now()

    session = db()
    try:
        user_id = session.query(User.id).filter(User.username == "pm").scalar()
        session.add_all(
            [
                ProjectChange(
                    project_id=project["id"],
                    field="description",
                    old="",
                    new="第一版",
                    by_id=user_id,
                    at=now - timedelta(hours=2),
                ),
                ProjectChange(
                    project_id=project["id"],
                    field="description",
                    old="第一版",
                    new="第二版",
                    by_id=user_id,
                    at=now,
                ),
            ]
        )
        session.commit()
    finally:
        session.close()

    listed = description_changes(client, headers, project["id"])
    assert len(listed) == 2
    assert [row["new"] for row in listed] == ["第二版", "第一版"]


def test_other_project_changes_break_the_auto_save_chain(client, db):
    headers = login(client, "pm")
    project = create_project(client, headers)
    now = app_now()

    session = db()
    try:
        user_id = session.query(User.id).filter(User.username == "pm").scalar()
        session.add_all(
            [
                ProjectChange(
                    project_id=project["id"],
                    field="description",
                    old="",
                    new="第一段",
                    by_id=user_id,
                    at=now - timedelta(minutes=2),
                ),
                ProjectChange(
                    project_id=project["id"],
                    field="status",
                    old="draft",
                    new="filed",
                    by_id=user_id,
                    at=now - timedelta(minutes=1),
                ),
                ProjectChange(
                    project_id=project["id"],
                    field="description",
                    old="第一段",
                    new="第一段，第二段",
                    by_id=user_id,
                    at=now,
                ),
            ]
        )
        session.commit()
    finally:
        session.close()

    listed = description_changes(client, headers, project["id"])
    assert len(listed) == 2
    assert [row["new"] for row in listed] == ["第一段，第二段", "第一段"]
