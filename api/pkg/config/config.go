package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	AppSecret       string
	DatabaseURL     string
	StorageBackend  string
	StorageLocalRoot string
	R2EndpointURL   string
	R2AccessKeyID   string
	R2SecretKey     string
	R2BucketName    string
	R2Region        string
	R2PublicURL     string
	R2PresignTTL    int
	AppEnv          string
	Port            string
	CorsOrigins     []string
}

func Load() (*Config, error) {
	c := &Config{
		AppSecret:        getEnv("APP_SECRET", "dev-secret-change-me"),
		DatabaseURL:      getEnv("DATABASE_URL", "postgresql://app:app@localhost:5432/app_test"),
		StorageBackend:   getEnv("STORAGE_BACKEND", "local"),
		StorageLocalRoot: getEnv("STORAGE_LOCAL_ROOT", ""),
		R2EndpointURL:    getEnv("R2_ENDPOINT_URL", ""),
		R2AccessKeyID:    getEnv("R2_ACCESS_KEY_ID", ""),
		R2SecretKey:      getEnv("R2_SECRET_ACCESS_KEY", ""),
		R2BucketName:     getEnv("R2_BUCKET_NAME", ""),
		R2Region:         getEnv("R2_REGION", "auto"),
		R2PublicURL:      getEnv("R2_PUBLIC_URL", ""),
		R2PresignTTL:     getEnvInt("R2_PRESIGN_TTL_SECONDS", 3600),
		AppEnv:           getEnv("APP_ENV", "development"),
		Port:             getEnv("PORT", "8001"),
	}

	origins := getEnv("CORS_ORIGINS", "http://localhost:3001,http://127.0.0.1:3001")
	for _, o := range strings.Split(origins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			c.CorsOrigins = append(c.CorsOrigins, o)
		}
	}

	// 生产环境附件后端校验
		if c.AppEnv == "production" {
		if c.AppSecret == "" || c.AppSecret == "dev-secret-change-me" || len(c.AppSecret) < 16 {
			return nil, fmt.Errorf("production environment requires secure non-default APP_SECRET (min 16 chars)")
		}
	}

	if c.AppEnv == "production" && c.StorageBackend == "local" {
		return nil, fmt.Errorf("production environment cannot use local storage backend")
	}

	if c.StorageBackend == "r2" {
		if c.R2EndpointURL == "" || c.R2AccessKeyID == "" || c.R2SecretKey == "" || c.R2BucketName == "" {
			if c.AppEnv == "production" {
				return nil, fmt.Errorf("STORAGE_BACKEND=r2 but R2_* configuration is incomplete")
			}
		}
	}

	return c, nil
}

func getEnv(key, def string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return def
}

func getEnvInt(key string, def int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return def
}
