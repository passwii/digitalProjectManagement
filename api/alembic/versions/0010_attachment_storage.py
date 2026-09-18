"""附件存储坐标：storage_backend / object_key / etag（BLF-1136 接入 Cloudflare R2）。

背景：正文从「只落本地磁盘」改为「本地 / R2 双后端」，元数据需要知道正文在哪。

  · `storage_backend`：`local` / `r2`；**服务端默认 `local`** —— 存量行全部是本地的，
    默认值让老数据无需回填即自洽，新写入由应用按 `STORAGE_BACKEND` 决定。
  · `object_key`：对象存储的键（README §5.3 的 `tenant/default/...` 命名），本地行为空。
  · `etag`：对象存储返回的内容指纹，用于上传后核对与对账。

`attachments.path` 语义随之扩展：local = 磁盘路径；r2 = 对象公开 URL（保留人可读性，
便于排查；真实取数一律走 `object_key`）。

幂等：所有 `add_column` 都先查存在性，重复执行不报错（与本仓库既有迁移一致）。
"""
import sqlalchemy as sa

from alembic import op

revision = "0010_attachment_storage"
down_revision = "0009_contact_roster_independent"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    return col in [c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)]


def upgrade():
    if not _has_column("attachments", "storage_backend"):
        op.add_column(
            "attachments",
            sa.Column("storage_backend", sa.String(16), nullable=False,
                      server_default="local"),
        )
    if not _has_column("attachments", "object_key"):
        op.add_column(
            "attachments",
            sa.Column("object_key", sa.String(512), nullable=False, server_default=""),
        )
    if not _has_column("attachments", "etag"):
        op.add_column(
            "attachments",
            sa.Column("etag", sa.String(128), nullable=False, server_default=""),
        )


def downgrade():
    for col in ("etag", "object_key", "storage_backend"):
        if _has_column("attachments", col):
            op.drop_column("attachments", col)
