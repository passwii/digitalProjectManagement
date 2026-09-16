import pytest

from api.core.config import load_settings


def test_development_uses_local_defaults(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.delenv("APP_SECRET", raising=False)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)

    settings = load_settings()

    assert settings.app_env == "development"
    assert settings.secret_key == "dev-secret-change-me"
    assert settings.cookie_secure is False
    assert settings.access_cookie_name == "pm_access_token"
    assert settings.refresh_cookie_name == "pm_refresh_token"
    assert settings.csrf_cookie_name == "pm_csrf_token"


def test_production_rejects_missing_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("APP_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="APP_SECRET"):
        load_settings()


def test_production_rejects_short_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "too-short")

    with pytest.raises(RuntimeError, match="至少 32"):
        load_settings()


def test_production_enables_secure_cookie(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "x" * 32)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)

    settings = load_settings()

    assert settings.cookie_secure is True


def test_cookie_secure_can_be_overridden_for_staging_http(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "x" * 32)
    monkeypatch.setenv("COOKIE_SECURE", "0")

    settings = load_settings()

    assert settings.cookie_secure is False
