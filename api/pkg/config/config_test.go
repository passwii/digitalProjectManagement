package config

import (
	"os"
	"testing"
)

func TestConfigProductionSecretCheck(t *testing.T) {
	os.Setenv("APP_ENV", "production")
	os.Setenv("STORAGE_BACKEND", "r2")
	os.Setenv("R2_ENDPOINT_URL", "https://test.r2.cloudflarestorage.com")
	os.Setenv("R2_ACCESS_KEY_ID", "test-key")
	os.Setenv("R2_SECRET_ACCESS_KEY", "test-secret")
	os.Setenv("R2_BUCKET_NAME", "test-bucket")
	os.Setenv("APP_SECRET", "dev-secret-change-me")

	_, err := Load()
	if err == nil {
		t.Fatalf("expected error when default secret is used in production")
	}

	os.Setenv("APP_SECRET", "super-secure-production-secret-key-12345")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("expected success with secure secret, got: %v", err)
	}
	if cfg.AppSecret != "super-secure-production-secret-key-12345" {
		t.Fatalf("secret mismatch")
	}

	// 恢复环境
	os.Setenv("APP_ENV", "development")
	os.Setenv("STORAGE_BACKEND", "local")
}
