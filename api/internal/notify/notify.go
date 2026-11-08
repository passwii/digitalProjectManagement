package notify

import (
	"time"
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

var typeLabels = map[string]string{
	"overdue_task": "任务逾期",
	"milestone":    "里程碑",
	"stagnant":     "项目停滞",
	"budget":       "预算预警",
	"followup":     "跟进提醒",
	"approval":     "审批",
	"expense":      "支出",
}

func linkOf(n *model.Notification) *string {
	if n.RefType == "task" && n.ProjectID != nil && n.RefID != nil {
		s := fmt.Sprintf("/progress?project_id=%d&task_id=%d", *n.ProjectID, *n.RefID)
		return &s
	}
	if n.RefType == "milestone" && n.ProjectID != nil && n.RefID != nil {
		s := fmt.Sprintf("/progress?project_id=%d&milestone_id=%d", *n.ProjectID, *n.RefID)
		return &s
	}
	if n.RefType == "expense" && n.RefID != nil {
		pidStr := ""
		if n.ProjectID != nil {
			pidStr = strconv.FormatUint(uint64(*n.ProjectID), 10)
		}
		s := fmt.Sprintf("/costs?project_id=%s&expense_id=%d", pidStr, *n.RefID)
		return &s
	}
	if n.RefType == "budget_adjust" && n.RefID != nil {
		s := fmt.Sprintf("/approvals?budget_adjust_id=%d", *n.RefID)
		return &s
	}
	if n.RefType == "followup" && n.ProjectID != nil && n.RefID != nil {
		s := fmt.Sprintf("/projects/%d?followup_id=%d", *n.ProjectID, *n.RefID)
		return &s
	}
	if n.ProjectID != nil {
		s := fmt.Sprintf("/projects/%d", *n.ProjectID)
		return &s
	}
	return nil
}

type NotifItem struct {
	ID          uint               `json:"id"`
	UserID      uint               `json:"user_id"`
	Type        string             `json:"type"`
	TypeLabel   string             `json:"type_label"`
	Title       string             `json:"title"`
	Body        string             `json:"body"`
	Channel     string             `json:"channel"`
	RefType     string             `json:"ref_type"`
	RefID       *uint              `json:"ref_id"`
	ProjectID   *uint              `json:"project_id"`
	Read        bool               `json:"read"`
	ReadAt      *timeutil.DateTime `json:"read_at"`
	State       string             `json:"state"`
	HandledAt   *timeutil.DateTime `json:"handled_at"`
	HandledBy   *uint              `json:"handled_by"`
	HandleNote  string             `json:"handle_note"`
	CreatedAt   timeutil.DateTime  `json:"created_at"`
	Link        *string            `json:"link"`
	RefComplete bool               `json:"ref_complete"`
}

func formatNotification(n *model.Notification) NotifItem {
	typeLabel := typeLabels[n.Type]
	if typeLabel == "" {
		typeLabel = n.Type
	}

	return NotifItem{
		ID:          n.ID,
		UserID:      n.UserID,
		Type:        n.Type,
		TypeLabel:   typeLabel,
		Title:       n.Title,
		Body:        n.Body,
		Channel:     n.Channel,
		RefType:     n.RefType,
		RefID:       n.RefID,
		ProjectID:   n.ProjectID,
		Read:        n.ReadAt != nil,
		ReadAt:      n.ReadAt,
		State:       n.State,
		HandledAt:   n.HandledAt,
		HandledBy:   n.HandledBy,
		HandleNote:  n.HandleNote,
		CreatedAt:   n.CreatedAt,
		Link:        linkOf(n),
		RefComplete: n.RefType != "" && n.RefID != nil,
	}
}


func SyncWarnings(db *gorm.DB, force bool) {
	now := timeutil.AppNow()
	nowDt := timeutil.NewDateTime(now)
	today := timeutil.NewDate(now)

	const syncInterval = 300 * time.Second
	var param model.SysParam
	if err := db.Where("key = ?", "notifications_synced_at").First(&param).Error; err == nil {
		if !force && param.Value != "" {
			if t, err := time.Parse(time.RFC3339, param.Value); err == nil {
				if now.Sub(t) < syncInterval {
					return
				}
			}
		}
	}

	// 1. 任务逾期预警
	var overdueTasks []model.Task
	_ = db.Model(&model.Task{}).
		Joins("JOIN projects ON projects.id = tasks.project_id").
		Where("projects.deleted_at IS NULL AND tasks.status <> 'done' AND tasks.plan_end < ?", today).
		Limit(50).Find(&overdueTasks).Error
	for _, t := range overdueTasks {
		if t.OwnerID != nil {
			title := fmt.Sprintf("任务逾期：%s", t.Name)
			body := "计划结束仍未完成"
			if t.PlanEnd != nil {
				body = fmt.Sprintf("计划结束 %s，仍未完成", t.PlanEnd.Format("2006-01-02"))
			}
			dedupKey := fmt.Sprintf("overdue_task:%d", t.ID)
			projectID := t.ProjectID
			_, _ = Push(db, *t.OwnerID, "overdue_task", title, body, "in_app", "task", &t.ID, &projectID, dedupKey)
		}
	}

	// 2. 里程碑临近/逾期预警
	var nearMilestones []model.Milestone
	_ = db.Model(&model.Milestone{}).
		Joins("JOIN projects ON projects.id = milestones.project_id").
		Where("projects.deleted_at IS NULL AND milestones.status = 'open' AND milestones.actual_date IS NULL AND milestones.plan_date IS NOT NULL AND milestones.plan_date <= ?", today.AddDate(0, 0, 3)).
		Limit(50).Find(&nearMilestones).Error
	for _, m := range nearMilestones {
		if m.OwnerID != nil && m.PlanDate != nil {
			state := "临近"
			if m.PlanDate.Before(today.Time) {
				state = "已逾期"
			}
			title := fmt.Sprintf("里程碑%s：%s", state, m.Name)
			body := fmt.Sprintf("计划日期 %s", m.PlanDate.Format("2006-01-02"))
			dedupKey := fmt.Sprintf("milestone:%d", m.ID)
			projectID := m.ProjectID
			_, _ = Push(db, *m.OwnerID, "milestone", title, body, "in_app", "milestone", &m.ID, &projectID, dedupKey)
		}
	}

	// 3. 跟进到期提醒
	var dueFollowups []model.Followup
	_ = db.Model(&model.Followup{}).
		Joins("JOIN projects ON projects.id = followups.project_id").
		Where("projects.deleted_at IS NULL AND followups.remind_at <= ? AND (followups.remind_state = 'pending' OR followups.remind_state IS NULL OR followups.remind_state = '')", nowDt).
		Limit(50).Find(&dueFollowups).Error
	for _, f := range dueFollowups {
		if f.UserID != nil {
			title := "跟进提醒"
			body := f.Content
			if len([]rune(body)) > 200 {
				body = string([]rune(body)[:200])
			}
			dedupKey := fmt.Sprintf("followup:%d", f.ID)
			projectID := f.ProjectID
			_, _ = Push(db, *f.UserID, "followup", title, body, "in_app", "followup", &f.ID, &projectID, dedupKey)
			_ = db.Model(&model.Followup{}).Where("id = ?", f.ID).Updates(map[string]any{
				"remind_state": "done",
				"reminded_at": nowDt,
			}).Error
		}
	}

	nowStr := now.Format(time.RFC3339)
	if param.ID > 0 {
		_ = db.Model(&param).Update("value", nowStr).Error
	} else {
		_ = db.Create(&model.SysParam{Key: "notifications_synced_at", Value: nowStr, Desc: "通知最近同步时间"}).Error
	}
}

func (h *Handler) List(c *gin.Context) {
	SyncWarnings(h.DB, false)
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

	var unreadCount, pendingCount int64
	h.DB.Model(&model.Notification{}).Where("user_id = ? AND read_at IS NULL", u.ID).Count(&unreadCount)
	h.DB.Model(&model.Notification{}).Where("user_id = ? AND state = 'pending'", u.ID).Count(&pendingCount)

	c.JSON(http.StatusOK, gin.H{
		"total":   env.Total,
		"unread":  unreadCount,
		"pending": pendingCount,
		"page":    env.Page,
		"size":    env.Size,
		"items":   items,
	})
}

func (h *Handler) Count(c *gin.Context) {
	SyncWarnings(h.DB, false)
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
