"""为设备入库批次增加唯一名称。"""
import sqlalchemy as sa
from alembic import op

revision = "0031_equipment_batch_names"
down_revision = "0030_equipment_event_purge_gate"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("equipment_batches", sa.Column("name", sa.String(128), nullable=True))
    op.execute("UPDATE equipment_batches SET name = '批次 #' || id::text")
    op.alter_column("equipment_batches", "name", nullable=False)
    op.execute(
        "CREATE UNIQUE INDEX uq_equipment_batches_name_lower "
        "ON equipment_batches (lower(name))"
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS uq_equipment_batches_name_lower")
    op.drop_column("equipment_batches", "name")
