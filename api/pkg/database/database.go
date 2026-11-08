package database

import (
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var GlobalDB *gorm.DB

func Init(dbURL string, appEnv string) (*gorm.DB, error) {
	// 兼容 python sqlalchemy 的 postgresql+psycopg:// 前缀
	dsn := strings.Replace(dbURL, "postgresql+psycopg://", "postgresql://", 1)

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
