package main

import (
	"fmt"
	"log"
	"net/http"

	"digitalprojectmanagement/api/internal/admin"
	"digitalprojectmanagement/api/internal/approval"
	"digitalprojectmanagement/api/internal/auth"
	"digitalprojectmanagement/api/internal/budget"
	"digitalprojectmanagement/api/internal/contact"
	"digitalprojectmanagement/api/internal/dashboard"
	"digitalprojectmanagement/api/internal/equipment"
	"digitalprojectmanagement/api/internal/expense"
	"digitalprojectmanagement/api/internal/finance"
	"digitalprojectmanagement/api/internal/meta"
	"digitalprojectmanagement/api/internal/milestone"
	"digitalprojectmanagement/api/internal/notify"
	"digitalprojectmanagement/api/internal/opportunity"
	"digitalprojectmanagement/api/internal/partner"
	"digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/receivable"
	"digitalprojectmanagement/api/internal/report"
	"digitalprojectmanagement/api/internal/task"
	"digitalprojectmanagement/api/pkg/config"
	"digitalprojectmanagement/api/pkg/database"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/storage"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	security.Init(cfg.AppSecret)

	db, err := database.Init(cfg.DatabaseURL, cfg.AppEnv)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}

	// 附件存储初始化
	var backend storage.StorageBackend
	if cfg.StorageBackend == "r2" {
		r2, err := storage.NewR2Backend(cfg.R2EndpointURL, cfg.R2AccessKeyID, cfg.R2SecretKey, cfg.R2BucketName, cfg.R2Region, cfg.R2PublicURL)
		if err != nil {
			log.Fatalf("R2 存储初始化失败: %v", err)
		}
		backend = r2
		log.Printf("[storage] 附件后端：r2 (bucket=%s)", cfg.R2BucketName)
	} else {
		loc, err := storage.NewLocalBackend(cfg.StorageLocalRoot)
		if err != nil {
			log.Fatalf("本地存储初始化失败: %v", err)
		}
		backend = loc
		log.Println("[storage] 附件后端：本地临时暂存（仅开发/测试）")
	}
	storage.InitGlobal(backend)

	if cfg.AppEnv == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.Default()

	// CORS 配置
	corsConfig := cors.DefaultConfig()
	corsConfig.AllowOrigins = cfg.CorsOrigins
	corsConfig.AllowCredentials = true
	corsConfig.AllowHeaders = []string{
		"Authorization",
		"Content-Type",
		"Accept",
		"Origin",
		"User-Agent",
		"DNT",
		"Cache-Control",
		"X-Mx-ReqToken",
		"Keep-Alive",
		"X-Requested-With",
		"If-Modified-Since",
		"X-CSRF-Token",
	}
	corsConfig.AllowMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
	corsConfig.ExposeHeaders = []string{"Content-Disposition"}
	r.Use(cors.New(corsConfig))

	// 健康检查
	r.GET("/health", func(c *gin.Context) {
		res := gin.H{
			"ok":              true,
			"storage_backend": backend.Name(),
		}
		if cfg.StorageBackend == "r2" {
			res["storage_bucket"] = cfg.R2BucketName
		}
		c.JSON(http.StatusOK, res)
	})

	// API v1 路由组装配
	v1 := r.Group("/api/v1")
	{
		auth.RegisterRoutes(v1, db)
		meta.RegisterRoutes(v1, db)
		admin.RegisterRoutes(v1, db)
		project.RegisterRoutes(v1, db)
		task.RegisterRoutes(v1, db)
		milestone.RegisterRoutes(v1, db)
		budget.RegisterRoutes(v1, db)
		expense.RegisterRoutes(v1, db)
		receivable.RegisterRoutes(v1, db)
		approval.RegisterRoutes(v1, db)
		dashboard.RegisterRoutes(v1, db)
		report.RegisterRoutes(v1, db)
		notify.RegisterRoutes(v1, db)
		contact.RegisterRoutes(v1, db)
		partner.RegisterRoutes(v1, db)
		opportunity.RegisterRoutes(v1, db)
		equipment.RegisterRoutes(v1, db)
		finance.RegisterRoutes(v1, db)
	}

	addr := fmt.Sprintf("0.0.0.0:%s", cfg.Port)
	log.Printf("项目管理系统 Go API 服务启动在 %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("服务退出: %v", err)
	}
}
