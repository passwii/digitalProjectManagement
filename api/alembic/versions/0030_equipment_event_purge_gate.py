"""让管理员删除设备时可在同一事务内临时穿透「流水不可变」触发器。

背景：
  `0027_equipment_assets` 为 `equipment_events` 建立了 `equipment_events_immutable`
  触发器（0029_user_modules 已为其父迁移），对 UPDATE / DELETE 一律 raise，
  以确保设备领用/借用/维修/报废等业务流水不可篡改、不可抹除。

  问题：管理员「彻底删除设备」接口需要删除该设备及其录入阶段流水，但流水受该
  触发器保护，导致生产环境任何设备都无法完成删除（抛 500 equipment event history
  is immutable），而单元测试用 `create_all` 建表不跑迁移、不存在该触发器，故测不出来。

方案（受控穿透，保留审计底线）：
  不移除触发器、不放宽权限。改写 `prevent_equipment_event_change()`：仅当当前会话
  显式设置 `app.allow_event_purge='on'` 时放行，否则照旧 raise。删除接口在同一事务内
  以 `SET LOCAL` 打开该开关（事务级、提交/回滚后自动失效），仅自己这一次删除受影响，
  任何其他写路径依然删不掉、也改不掉流水。

  触发器在放行时返回 OLD（BEFORE DELETE 的行级触发器放行语法），被删流水连同删除
  原因、受保护动作列表一并由 `delete_equipment` 审计快照留痕，保证强制删除事后可追溯。
"""

from alembic import op

revision = "0030_equipment_event_purge_gate"
down_revision = "0029_user_modules"
branch_labels = None
depends_on = None


def upgrade():
    # 幂等：仅重定义函数体（CREATE OR REPLACE 保留原 OID 与触发器绑定），重复执行安全。
    op.execute(
        """
        CREATE OR REPLACE FUNCTION prevent_equipment_event_change()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
            IF COALESCE(current_setting('app.allow_event_purge', true), 'off') = 'on' THEN
                RETURN OLD;  -- 放行：仅管理员删除设备事务通过 SET LOCAL 打开时生效
            END IF;
            RAISE EXCEPTION 'equipment event history is immutable';
        END; $function$
        """
    )


def downgrade():
    # 回到 0027 的完全不可变语义：任何 UPDATE/DELETE 一律拒绝。
    op.execute(
        """
        CREATE OR REPLACE FUNCTION prevent_equipment_event_change()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
            RAISE EXCEPTION 'equipment event history is immutable';
        END; $function$
        """
    )
