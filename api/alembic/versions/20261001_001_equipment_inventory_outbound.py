"""为设备台账增加库存数量与出库流水字段。"""

import sqlalchemy as sa
from alembic import op

revision = "34"
down_revision = "0033_project_receivable_updaters"
branch_labels = None
depends_on = None


def upgrade():
    # 守住旧版设备语义：现存单件资产默认库存数量为 1；允许库存余额归零。
    op.add_column(
        "equipment_assets",
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "equipment_assets",
        sa.Column("available_quantity", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "equipment_assets",
        sa.Column("inventory_managed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_check_constraint(
        "ck_equipment_quantity_positive", "equipment_assets", "quantity > 0",
    )
    op.create_check_constraint(
        "ck_equipment_available_quantity_range",
        "equipment_assets",
        "available_quantity >= 0 AND available_quantity <= quantity",
    )
    op.create_check_constraint(
        "ck_equipment_single_asset_quantity",
        "equipment_assets",
        "inventory_managed OR (quantity = 1 AND available_quantity = 1)",
    )

    op.add_column("equipment_events", sa.Column("quantity", sa.Integer(), nullable=True))
    op.add_column("equipment_events", sa.Column("customer", sa.String(255), nullable=True))
    op.add_column("equipment_events", sa.Column("destination", sa.String(255), nullable=True))
    op.add_column("equipment_events", sa.Column("shipped_at", sa.DateTime(), nullable=True))
    op.create_check_constraint(
        "ck_equipment_outbound_details",
        "equipment_events",
        "action <> 'outbound' OR (quantity > 0 AND shipped_at IS NOT NULL "
        "AND (length(trim(coalesce(customer, ''))) > 0 OR "
        "length(trim(coalesce(destination, ''))) > 0))",
    )
    op.create_index(
        "ix_equipment_events_outbound_time",
        "equipment_events",
        ["action", "shipped_at"],
    )

    # Server defaults only needed while existing rows are backfilled.
    for table, column in (
        ("equipment_assets", "quantity"),
        ("equipment_assets", "available_quantity"),
        ("equipment_assets", "inventory_managed"),
    ):
        op.alter_column(table, column, server_default=None)


def downgrade():
    op.drop_index("ix_equipment_events_outbound_time", table_name="equipment_events")
    op.drop_constraint(
        "ck_equipment_outbound_details", "equipment_events", type_="check",
    )
    op.drop_column("equipment_events", "shipped_at")
    op.drop_column("equipment_events", "destination")
    op.drop_column("equipment_events", "customer")
    op.drop_column("equipment_events", "quantity")

    op.drop_constraint(
        "ck_equipment_single_asset_quantity", "equipment_assets", type_="check",
    )
    op.drop_constraint(
        "ck_equipment_available_quantity_range", "equipment_assets", type_="check",
    )
    op.drop_constraint("ck_equipment_quantity_positive", "equipment_assets", type_="check")
    op.drop_column("equipment_assets", "inventory_managed")
    op.drop_column("equipment_assets", "available_quantity")
    op.drop_column("equipment_assets", "quantity")
