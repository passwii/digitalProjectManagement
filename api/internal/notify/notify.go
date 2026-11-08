package notify

import (
	"fmt"
	"net/http"
	"strconv"
	
	

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	notifGroup := r.Group("/notifications", rbac.AuthMiddleware(db))
	{
		notifGroup.GET("", h.List)
		notifGroup.GET("/count", h.Count)
		notifGroup.GET("/dedup/config", h.GetDedupConfig)
		notifGroup.GET("/:nid", h.GetOne)
		notifGroup.POST("/:nid/read", h.MarkRead)
		notifGroup.POST("/read-all", h.MarkReadAll)
		notifGroup.POST("/:nid/handle", h.HandleOne)
		notifGroup.POST("/handle-all", h.HandleAll)
	}
}

func DedupDays(db *gorm.DB) int {
	var sp model.SysParam
	if err := db.Where("key = ?", "notify_dedup_days").First(&sp).Error; err == nil {
		if d, err := strconv.Atoi(sp.Value); err == nil && d >= 0 {
			return d
		}
	}
	return 1
}

func Push(db *gorm.DB, userID uint, nType, title, body, channel, refType string, refID, projectID *uint, dedupKey string) (*model.Notification, error) {
	now := timeutil.AppNow()
	days := DedupDays(db)

	if dedupKey != "" && days > 0 {
		threshold := timeutil.NewDateTime(now.AddDate(0, 0, -days))
		var cnt int64
		db.Model(&model.Notification{}).
			Where("user_id = ? AND dedup_key = ? AND created_at >= ?", userID, dedupKey, threshold).
			Count(&cnt)
		if cnt > 0 {
			return nil, nil // 去重跳过
		}
	}

	notif := model.Notification{
		UserID:    userID,
		Type:      nType,
		Title:     title,
		Body:      body,
		Channel:   channel,
		RefType:   refType,
		RefID:     refID,
		ProjectID: projectID,
		DedupKey:  dedupKey,
		State:     "pending",
		CreatedAt: timeutil.NowDateTime(),
	}

	if err := db.Create(&notif).Error; err != nil {
		return nil, err
	}
	return &notif, nil
}

type NotifItem struct {
	ID          uint               `json:"id"`
	UserID      uint               `json:"user_id"`
	Type        string             `json:"type"`
	Title       string             `json:"title"`
	Body        string             `json:"body"`
	Channel     string             `json:"channel"`
	RefType     string             `json:"ref_type"`
	RefID       *uint              `json:"ref_id"`
	ProjectID   *uint              `json:"project_id"`
	ReadAt      *timeutil.DateTime `json:"read_at"`
	State       string             `json:"state"`
	HandledAt   *timeutil.DateTime `json:"handled_at"`
	HandledBy   *uint              `json:"handled_by"`
	HandleNote  string             `json:"handle_note"`
	CreatedAt   timeutil.DateTime  `json:"created_at"`
	Link        string             `json:"link"`
	RefComplete bool               `json:"ref_complete"`
}

func formatNotification(n *model.Notification) NotifItem {
	link := ""
	if n.RefType != "" && n.RefID != nil {
		switch n.RefType {
		case "project":
			link = fmt.Sprintf("/projects/%d", *n.RefID)
		case "task":
			if n.ProjectID != nil {
				link = fmt.Sprintf("/projects/%d?tab=tasks&taskId=%d", *n.ProjectID, *n.RefID)
			}
		case "milestone":
			if n.ProjectID != nil {
				link = fmt.Sprintf("/projects/%d?tab=milestones", *n.ProjectID)
			}
		case "expense":
			if n.ProjectID != nil {
				link = fmt.Sprintf("/projects/%d?tab=costs&expenseId=%d", *n.ProjectID, *n.RefID)
			}
		case "budget_adjust":
			if n.ProjectID != nil {
				link = fmt.Sprintf("/projects/%d?tab=costs", *n.ProjectID)
			}
		case "followup":
			if n.ProjectID != nil {
				link = fmt.Sprintf("/projects/%d?tab=followups", *n.ProjectID)
			}
		}
	}

	return NotifItem{
		ID:          n.ID,
		UserID:      n.UserID,
		Type:        n.Type,
		Title:       n.Title,
		Body:        n.Body,
		Channel:     n.Channel,
		RefType:     n.RefType,
		RefID:       n.RefID,
		ProjectID:   n.ProjectID,
		ReadAt:      n.ReadAt,
		State:       n.State,
		HandledAt:   n.HandledAt,
		HandledBy:   n.HandledBy,
		HandleNote:  n.HandleNote,
		CreatedAt:   n.CreatedAt,
		Link:        link,
		RefComplete: n.RefType != "" && n.RefID != nil,
	}
}

func (h *Handler) List(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	q := h.DB.Model(&model.Notification{}).Where("user_id = ?", u.ID)

	if state := c.Query("state"); state != "" {
		q = q.Where("state = ?", state)
	}
	if read := c.Query("read"); read != "" {
		if read == "1" || read == "true" {
			q = q.Where("read_at IS NOT NULL")
		} else if read == "0" || read == "false" {
			q = q.Where("read_at IS NULL")
		}
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	sortParam := c.Query("sort")

	allowed := map[string]string{
		"id":         "id",
		"created_at": "created_at",
		"type":       "type",
		"state":      "state",
	}

	env, err := paging.Paginate[model.Notification](q, page, size, sortParam, allowed, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	var items []NotifItem
	for i := range env.Items {
		items = append(items, formatNotification(&env.Items[i]))
	}
	if items == nil {
		items = []NotifItem{}
	}

	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": items,
	})
}

func (h *Handler) Count(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	var unread, pending int64
	h.DB.Model(&model.Notification{}).Where("user_id = ? AND read_at IS NULL", u.ID).Count(&unread)
	h.DB.Model(&model.Notification{}).Where("user_id = ? AND state = 'pending'", u.ID).Count(&pending)

	c.JSON(http.StatusOK, gin.H{
		"unread":  unread,
		"pending": pending,
	})
}

func (h *Handler) GetDedupConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"dedup_days": DedupDays(h.DB),
	})
}

func (h *Handler) GetOne(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	nid, err := strconv.Atoi(c.Param("nid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "无效的通知 ID"})
		return
	}

	var n model.Notification
	if err := h.DB.Where("id = ? AND user_id = ?", nid, u.ID).First(&n).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "通知不存在"})
		return
	}

	refAvailable := true
	if n.RefType != "" && n.RefID != nil {
		switch n.RefType {
		case "project":
			var count int64
			h.DB.Model(&model.Project{}).Where("id = ? AND deleted_at IS NULL", *n.RefID).Count(&count)
			refAvailable = count > 0
		case "task":
			var count int64
			h.DB.Model(&model.Task{}).Where("id = ?", *n.RefID).Count(&count)
			refAvailable = count > 0
		}
	}

	item := formatNotification(&n)
	c.JSON(http.StatusOK, gin.H{
		"notification":  item,
		"ref_available": refAvailable,
	})
}

func (h *Handler) MarkRead(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	nid, _ := strconv.Atoi(c.Param("nid"))
	now := timeutil.NowDateTime()
	h.DB.Model(&model.Notification{}).
		Where("id = ? AND user_id = ? AND read_at IS NULL", nid, u.ID).
		Update("read_at", now)

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) MarkReadAll(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	now := timeutil.NowDateTime()
	h.DB.Model(&model.Notification{}).
		Where("user_id = ? AND read_at IS NULL", u.ID).
		Update("read_at", now)

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type HandleReq struct {
	State string `json:"state"`
	Note  string `json:"note"`
}

func (h *Handler) HandleOne(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	nid, _ := strconv.Atoi(c.Param("nid"))

	var req HandleReq
	if err := c.ShouldBindJSON(&req); err != nil || req.State == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "state 必填"})
		return
	}
	if req.State != "pending" && req.State != "done" && req.State != "ignored" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "state 须为 pending/done/ignored"})
		return
	}

	now := timeutil.NowDateTime()
	err := h.DB.Model(&model.Notification{}).
		Where("id = ? AND user_id = ?", nid, u.ID).
		Updates(map[string]interface{}{
			"state":       req.State,
			"handled_at":  now,
			"handled_by":  u.ID,
			"handle_note": req.Note,
		}).Error

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "处理通知失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type HandleAllReq struct {
	State string `json:"state"`
	Note  string `json:"note"`
	Type  string `json:"type"`
}

func (h *Handler) HandleAll(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	var req HandleAllReq
	if err := c.ShouldBindJSON(&req); err != nil || req.State == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "state 必填"})
		return
	}
	if req.State != "pending" && req.State != "done" && req.State != "ignored" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "state 须为 pending/done/ignored"})
		return
	}

	now := timeutil.NowDateTime()
	q := h.DB.Model(&model.Notification{}).Where("user_id = ?", u.ID)
	if req.Type != "" {
		q = q.Where("type = ?", req.Type)
	}

	err := q.Updates(map[string]interface{}{
		"state":       req.State,
		"handled_at":  now,
		"handled_by":  u.ID,
		"handle_note": req.Note,
	}).Error

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "批量处理通知失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
