"""种子：admin/admin123456（首次强制改密）+ 6 角色 + 字典 + 参数。"""
from .core.database import Base, SessionLocal, engine
from .core.security import hash_password
from .models import Department, Dict, Role, SysParam, User, UserRole

ROLES = [("admin", "系统管理员"), ("project_manager", "项目负责人"),
         ("dept_manager", "部门负责人"), ("member", "项目成员"),
         ("cost_admin", "成本管理员"), ("executive", "高层（只读）")]

DICTS = [
    ("project_type", "research", "科研"), ("project_type", "construct", "工程"),
    ("project_type", "service", "服务"), ("project_type", "other", "其他"),
    ("priority", "高", "高"), ("priority", "中", "中"), ("priority", "低", "低"),
    ("expense_subject", "人工", "人工"), ("expense_subject", "采购", "采购"),
    ("expense_subject", "外包", "外包"), ("expense_subject", "差旅", "差旅"),
    ("expense_subject", "其他", "其他"),
    ("project_status", "draft", "草稿"), ("project_status", "filed", "已立项"),
    ("project_status", "pending", "待立项审批"),
    ("project_status", "doing", "进行中"), ("project_status", "paused", "暂停"),
    ("project_status", "done", "已完成"), ("project_status", "archived", "已归档"),
    ("project_status", "cancelled", "已取消"),
]

PARAMS = {
    "login_fail_limit": ("5", "连续失败锁定阈值"),
    "login_lock_minutes": ("15", "锁定分钟数"),
    "budget_warn_rate": ("0.8", "预算执行率预警线"),
    "budget_approval_on": ("0", "预算调整审批开关 0关/1开"),
    "expense_approval_on": ("0", "支出审批开关 0关/1开"),
    "milestone_warn_days": ("3", "里程碑到期预警天数"),
    "stagnant_days": ("7", "项目停滞无填报天数"),
    "project_approval_on": ("0", "立项审批开关 0关/1开"),
}


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        dept = db.query(Department).filter_by(name="综合部").first()
        if not dept:
            dept = Department(name="综合部")
            db.add(dept)
            db.flush()
        for code, name in ROLES:
            if not db.query(Role).filter_by(code=code).first():
                db.add(Role(code=code, name=name))
        db.flush()
        for i, (t, code, label) in enumerate(DICTS):
            if not db.query(Dict).filter_by(type=t, code=code).first():
                db.add(Dict(type=t, code=code, label=label, sort=i))
        for k, (v, desc) in PARAMS.items():
            if not db.query(SysParam).filter_by(key=k).first():
                db.add(SysParam(key=k, value=v, desc=desc))
        admin = db.query(User).filter_by(username="admin").first()
        if not admin:
            admin = User(username="admin", pwd_hash=hash_password("admin123456"),
                         real_name="系统管理员", dept_id=dept.id,
                         must_change_pwd=True)
            db.add(admin)
            db.flush()
        # admin 确保有 admin 角色
        role = db.query(Role).filter_by(code="admin").first()
        if not db.query(UserRole).filter_by(user_id=admin.id, role_id=role.id).first():
            db.add(UserRole(user_id=admin.id, role_id=role.id))
        db.commit()
        print("seed ok: admin/admin123456, roles=6, dicts, params")
    finally:
        db.close()


if __name__ == "__main__":
    main()
