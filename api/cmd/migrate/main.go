package main

import (
	"context"
	"log"
	"os"
	"time"

	"digitalprojectmanagement/api/pkg/database"
	"digitalprojectmanagement/api/pkg/migrations"
)

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	gormDB, err := database.Init(dbURL, os.Getenv("APP_ENV"))
	if err != nil {
		log.Fatalf("connect to database for migrations: %v", err)
	}
	sqlDB, err := gormDB.DB()
	if err != nil {
		log.Fatalf("get database connection for migrations: %v", err)
	}
	defer sqlDB.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := migrations.Up(ctx, sqlDB); err != nil {
		log.Fatalf("database migrations failed: %v", err)
	}
	log.Print("database migrations are up to date")
}
