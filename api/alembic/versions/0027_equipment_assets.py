"""公司设备台账、入库批次和不可变流水。"""
import sqlalchemy as sa
from alembic import op

revision = "0027_equipment_assets"
down_revision = "0026_fin_project_exp_voucher"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("equipment_batches",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("source", sa.String(255), nullable=False),
        sa.Column("note", sa.Text, nullable=False),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False))
    op.create_table("equipment_assets",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("code", sa.String(40), nullable=False, unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("category_code", sa.String(32), nullable=False),
        sa.Column("serial_number", sa.String(128), nullable=True, unique=True),
        sa.Column("brand", sa.String(128), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("location", sa.String(128), nullable=False),
        sa.Column("note", sa.Text, nullable=False),
        sa.Column("purchase_date", sa.Date, nullable=True),
        sa.Column("purchase_price", sa.Numeric(14, 2), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("holder_id", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("due_date", sa.Date, nullable=True),
        sa.Column("batch_id", sa.Integer, sa.ForeignKey("equipment_batches.id"), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.CheckConstraint("status IN ('available','claimed','borrowed','maintenance','scrapped','void')", name="ck_equipment_status"))
    for name in ("code", "category_code", "status", "holder_id", "batch_id"):
        op.create_index(f"ix_equipment_assets_{name}", "equipment_assets", [name])
    op.create_table("equipment_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("asset_id", sa.Integer, sa.ForeignKey("equipment_assets.id"), nullable=False),
        sa.Column("batch_id", sa.Integer, sa.ForeignKey("equipment_batches.id"), nullable=True),
        sa.Column("action", sa.String(24), nullable=False),
        sa.Column("from_status", sa.String(20), nullable=True),
        sa.Column("to_status", sa.String(20), nullable=False),
        sa.Column("actor_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("holder_id", sa.Integer, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("due_date", sa.Date, nullable=True),
        sa.Column("note", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False))
    op.create_index("ix_equipment_events_asset_id", "equipment_events", ["asset_id"])
    op.create_index("ix_equipment_events_created_at", "equipment_events", ["created_at"])
    op.execute("""CREATE FUNCTION prevent_equipment_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'equipment event history is immutable'; END; $$""")
    op.execute("""CREATE TRIGGER equipment_events_immutable BEFORE UPDATE OR DELETE ON equipment_events
    FOR EACH ROW EXECUTE FUNCTION prevent_equipment_event_change()""")


def downgrade():
    op.execute("DROP TRIGGER IF EXISTS equipment_events_immutable ON equipment_events")
    op.execute("DROP FUNCTION IF EXISTS prevent_equipment_event_change()")
    op.drop_table("equipment_events")
    op.drop_table("equipment_assets")
    op.drop_table("equipment_batches")
