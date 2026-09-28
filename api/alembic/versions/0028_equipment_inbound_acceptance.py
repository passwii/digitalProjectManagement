"""扩展设备入库批次采购元数据与验收流程。"""
import sqlalchemy as sa
from alembic import op

revision = "0028_equipment_acceptance"
down_revision = "0027_equipment_assets"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("equipment_batches", sa.Column("supplier", sa.String(255), nullable=False, server_default=""))
    op.add_column("equipment_batches", sa.Column("purchase_order_no", sa.String(128), nullable=False, server_default=""))
    op.add_column("equipment_batches", sa.Column("invoice_no", sa.String(128), nullable=False, server_default=""))
    op.add_column("equipment_batches", sa.Column("acceptance_status", sa.String(24), nullable=False, server_default="accepted"))
    op.create_check_constraint("ck_equipment_batch_acceptance_status", "equipment_batches",
                               "acceptance_status IN ('pending_acceptance','accepted')")
    op.drop_constraint("ck_equipment_status", "equipment_assets", type_="check")
    op.create_check_constraint("ck_equipment_status", "equipment_assets",
                               "status IN ('pending_acceptance','available','claimed','borrowed','maintenance','scrapped','void')")
    for column in ("supplier", "purchase_order_no", "invoice_no", "acceptance_status"):
        op.alter_column("equipment_batches", column, server_default=None)


def downgrade():
    op.execute("UPDATE equipment_assets SET status='available' WHERE status='pending_acceptance'")
    op.execute("UPDATE equipment_batches SET acceptance_status='accepted' WHERE acceptance_status='pending_acceptance'")
    op.drop_constraint("ck_equipment_status", "equipment_assets", type_="check")
    op.create_check_constraint("ck_equipment_status", "equipment_assets",
                               "status IN ('available','claimed','borrowed','maintenance','scrapped','void')")
    op.drop_constraint("ck_equipment_batch_acceptance_status", "equipment_batches", type_="check")
    op.drop_column("equipment_batches", "acceptance_status")
    op.drop_column("equipment_batches", "invoice_no")
    op.drop_column("equipment_batches", "purchase_order_no")
    op.drop_column("equipment_batches", "supplier")
