from tests import support


def test_test_password_hash_is_compatible_with_production_verifier():
    from api.core.security import verify_password

    hashed = support._hash_test_password("fixture-performance-probe")

    assert verify_password("fixture-performance-probe", hashed)


def test_test_password_hash_uses_fast_test_cost():
    hashed = support._hash_test_password("fixture-performance-cost")

    assert hashed.split("$")[2] == "04"


def test_test_password_hash_reuses_result_per_password(monkeypatch):
    calls = []
    password = "fixture-performance-probe"

    def fake_hash(raw: str) -> str:
        calls.append(raw)
        return f"hashed:{raw}"

    monkeypatch.setattr(support, "_hash_test_password", fake_hash)
    first = support.hash_test_password(password)
    second = support.hash_test_password(password)

    assert first == second == f"hashed:{password}"
    assert calls == [password]
