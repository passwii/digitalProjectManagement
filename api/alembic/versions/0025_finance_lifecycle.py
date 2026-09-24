"""账套软删除与应收应付核销释放历史。"""

import sqlalchemy as sa
from alembic import op


revision = "0025_finance_lifecycle"
down_revision = "0024_opportunities"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _indexes(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade():
    if "deleted_at" not in _columns("account_books"):
        op.add_column("account_books", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    if "deleted_by" not in _columns("account_books"):
        op.add_column(
            "account_books",
            sa.Column("deleted_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        )
    if "ix_account_books_deleted_at" not in _indexes("account_books"):
        op.create_index("ix_account_books_deleted_at", "account_books", ["deleted_at"])

    if "released_at" not in _columns("arap_allocations"):
        op.add_column("arap_allocations", sa.Column("released_at", sa.DateTime(), nullable=True))
    if "released_by" not in _columns("arap_allocations"):
        op.add_column(
            "arap_allocations",
            sa.Column("released_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        )
    if "release_reason" not in _columns("arap_allocations"):
        op.add_column(
            "arap_allocations",
            sa.Column("release_reason", sa.Text(), server_default="", nullable=False),
        )
    if "release_voucher_id" not in _columns("arap_allocations"):
        op.add_column(
            "arap_allocations",
            sa.Column("release_voucher_id", sa.Integer(), sa.ForeignKey("vouchers.id"), nullable=True),
        )
    if "ix_arap_allocations_released_at" not in _indexes("arap_allocations"):
        op.create_index("ix_arap_allocations_released_at", "arap_allocations", ["released_at"])

    # 修复本功能上线前因作废、删除或已过账冲销而遗留的活动分配。
    # 分两条语句在同一 Alembic 事务里完成，避免余额扣回与分配标记不一致。
    op.execute(
        sa.text(
            """
            UPDATE arap_transactions AS target
            SET applied_amount = GREATEST(
                0,
                target.applied_amount - COALESCE((
                    SELECT SUM(allocation.amount)
                    FROM arap_allocations AS allocation
                    LEFT JOIN vouchers AS source
                      ON source.id = allocation.source_id
                     AND source.account_book_id = allocation.account_book_id
                    WHERE allocation.account_book_id = target.account_book_id
                      AND allocation.target_id = target.id
                      AND allocation.released_at IS NULL
                      AND (
                        source.id IS NULL
                        OR source.status = 'void'
                        OR EXISTS (
                            SELECT 1
                            FROM vouchers AS reversal
                            WHERE reversal.account_book_id = allocation.account_book_id
                              AND reversal.reversal_of = source.id
                              AND reversal.status = 'posted'
                        )
                      )
                ), 0)
            )
            WHERE EXISTS (
                SELECT 1
                FROM arap_allocations AS allocation
                LEFT JOIN vouchers AS source
                  ON source.id = allocation.source_id
                 AND source.account_book_id = allocation.account_book_id
                WHERE allocation.account_book_id = target.account_book_id
                  AND allocation.target_id = target.id
                  AND allocation.released_at IS NULL
                  AND (
                    source.id IS NULL
                    OR source.status = 'void'
                    OR EXISTS (
                        SELECT 1
                        FROM vouchers AS reversal
                        WHERE reversal.account_book_id = allocation.account_book_id
                          AND reversal.reversal_of = source.id
                          AND reversal.status = 'posted'
                    )
                  )
            )
            """
        )
    )
    op.execute(
        sa.text(
            """
            UPDATE arap_allocations AS allocation
            SET released_at = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai',
                release_voucher_id = (
                    SELECT reversal.id
                    FROM vouchers AS reversal
                    WHERE reversal.account_book_id = allocation.account_book_id
                      AND reversal.reversal_of = allocation.source_id
                      AND reversal.status = 'posted'
                    ORDER BY reversal.id
                    LIMIT 1
                ),
                release_reason = CASE
                    WHEN NOT EXISTS (
                        SELECT 1 FROM vouchers AS source
                        WHERE source.id = allocation.source_id
                          AND source.account_book_id = allocation.account_book_id
                    ) THEN '历史数据修复：来源凭证已删除'
                    WHEN EXISTS (
                        SELECT 1 FROM vouchers AS source
                        WHERE source.id = allocation.source_id
                          AND source.account_book_id = allocation.account_book_id
                          AND source.status = 'void'
                    ) THEN '历史数据修复：来源凭证已作废'
                    ELSE '历史数据修复：冲销凭证已过账'
                END
            WHERE allocation.released_at IS NULL
              AND (
                NOT EXISTS (
                    SELECT 1 FROM vouchers AS source
                    WHERE source.id = allocation.source_id
                      AND source.account_book_id = allocation.account_book_id
                )
                OR EXISTS (
                    SELECT 1 FROM vouchers AS source
                    WHERE source.id = allocation.source_id
                      AND source.account_book_id = allocation.account_book_id
                      AND source.status = 'void'
                )
                OR EXISTS (
                    SELECT 1 FROM vouchers AS reversal
                    WHERE reversal.account_book_id = allocation.account_book_id
                      AND reversal.reversal_of = allocation.source_id
                      AND reversal.status = 'posted'
                )
              )
            """
        )
    )


def downgrade():
    if "ix_arap_allocations_released_at" in _indexes("arap_allocations"):
        op.drop_index("ix_arap_allocations_released_at", table_name="arap_allocations")
    for column in ("release_voucher_id", "release_reason", "released_by", "released_at"):
        if column in _columns("arap_allocations"):
            op.drop_column("arap_allocations", column)

    if "ix_account_books_deleted_at" in _indexes("account_books"):
        op.drop_index("ix_account_books_deleted_at", table_name="account_books")
    for column in ("deleted_by", "deleted_at"):
        if column in _columns("account_books"):
            op.drop_column("account_books", column)
