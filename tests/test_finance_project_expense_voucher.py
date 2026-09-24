"""项目支出来源凭证的持久化契约。"""

from sqlalchemy import UniqueConstraint

from api.models import Voucher


def test_voucher_source_expense_id_is_unique_fk_in_metadata():
    table = Voucher.__table__

    assert "source_expense_id" in table.c
    column = table.c.source_expense_id
    assert column.nullable
    assert len(column.foreign_keys) == 1
    foreign_key = next(iter(column.foreign_keys))
    assert foreign_key.target_fullname == "expenses.id"
    assert foreign_key.ondelete == "RESTRICT"
    assert foreign_key.constraint.name == "fk_vouchers_source_expense_id_expenses"
    assert any(
        isinstance(constraint, UniqueConstraint)
        and constraint.name == "uq_vouchers_source_expense_id"
        and [item.name for item in constraint.columns] == ["source_expense_id"]
        for constraint in table.constraints
    )
