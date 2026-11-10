package database

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var GlobalDB *gorm.DB

func Init(dbURL string, appEnv string) (*gorm.DB, error) {
	dsn, err := normalizeDatabaseURL(dbURL)
	if err != nil {
		return nil, fmt.Errorf("invalid DATABASE_URL: %w", err)
	}

	logLevel := logger.Warn
	if appEnv == "development" {
		logLevel = logger.Info
	}

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logLevel),
		NowFunc: func() time.Time {
			return time.Now().In(time.FixedZone("Asia/Shanghai", 8*3600))
		},
	})
	if err != nil {
		return nil, err
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}

	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetMaxOpenConns(50)
	sqlDB.SetConnMaxLifetime(time.Hour)

	GlobalDB = db
	return db, nil
}

func normalizeDatabaseURL(dbURL string) (string, error) {
	trimmed := strings.TrimSpace(dbURL)
	if trimmed == "" {
		return "", fmt.Errorf("database URL is empty")
	}
	if !strings.Contains(trimmed, "://") {
		if strings.TrimSpace(os.Getenv("DB_FORWARD_HOST")) != "" {
			return "", fmt.Errorf("DB_FORWARD_HOST requires a URL-form DATABASE_URL")
		}
		return trimmed, nil
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "postgresql+psycopg":
		parsed.Scheme = "postgresql"
	case "postgresql", "postgres":
	default:
		return "", fmt.Errorf("unsupported database URL scheme %q", parsed.Scheme)
	}
	if parsed.Hostname() == "" {
		return "", fmt.Errorf("database URL has no host")
	}

	if forwardHost := strings.Trim(strings.TrimSpace(os.Getenv("DB_FORWARD_HOST")), "[]"); forwardHost != "" {
		parsed.Host = net.JoinHostPort(forwardHost, "5432")
	}
	return parsed.String(), nil
}
