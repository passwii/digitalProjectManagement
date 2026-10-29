"""Shared test-only helpers."""
from functools import lru_cache

import bcrypt


def _hash_test_password(password: str) -> str:
    # Test fixtures do not need production KDF hardness; login still verifies by bcrypt.
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=4)).decode()


@lru_cache(maxsize=None)
def hash_test_password(password: str) -> str:
    return _hash_test_password(password)
