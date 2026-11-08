package report

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) Warnings(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projects, err := h.visibleProjects(user)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询预警项目失败"})
		return
	}
	result, err := h.buildWarnings(projects)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成项目预警失败"})
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) buildWarnings(projects []costProject) (gin.H, error) {
	result := gin.H{
		"overdue_tasks": []gin.H{}, "milestones": []gin.H{},
		"stagnant_projects": []gin.H{}, "budget_warnings": []gin.H{},
		"followup_due": []gin.H{},
	}
	if len(projects) == 0 {
		return result, nil
	}
	projectIDs := make([]uint, 0, len(projects))
	projectNames := make(map[uint]string, len(projects))
	for _, project := range projects {
		projectIDs = append(projectIDs, project.ID)
		projectNames[project.ID] = project.Name
	}
	today := timeutil.NewDate(timeutil.AppNow())
	now := timeutil.AppNow()
	milestoneWarnDays := sysInt(h.DB, "milestone_warn_days", 3, 0, 365)
	stagnantDays := sysInt(h.DB, "stagnant_days", 7, 0, 3650)
	warnRate := sysFloat(h.DB, "budget_warn_rate", .8, 0, 100)

	var tasks []model.Task
	if err := h.DB.Where("project_id IN ? AND plan_end IS NOT NULL AND plan_end < ? AND status <> ? AND progress < 100", projectIDs, today, "done").Find(&tasks).Error; err != nil {
		return nil, err
	}
	overdueItems := make([]gin.H, 0, len(tasks))
	for _, row := range tasks {
		overdueItems = append(overdueItems, gin.H{
			"task_id": row.ID, "name": row.Name, "project_id": row.ProjectID,
			"owner_id": row.OwnerID, "ref_type": "task", "ref_id": row.ID,
			"plan_end": row.PlanEnd.Format("2006-01-02"),
		})
	}
	result["overdue_tasks"] = overdueItems

	milestoneLimit := today.AddDate(0, 0, milestoneWarnDays)
	var milestones []model.Milestone
	if err := h.DB.Where("project_id IN ? AND status = ? AND actual_date IS NULL AND plan_date IS NOT NULL AND plan_date <= ?", projectIDs, "open", milestoneLimit).Find(&milestones).Error; err != nil {
		return nil, err
	}
	milestoneItems := make([]gin.H, 0, len(milestones))
	for _, row := range milestones {
		days := int(row.PlanDate.Sub(today.Time).Hours() / 24)
		milestoneItems = append(milestoneItems, gin.H{
			"milestone_id": row.ID, "name": row.Name, "project_id": row.ProjectID,
			"owner_id": row.OwnerID, "ref_type": "milestone", "ref_id": row.ID,
			"overdue": days < 0, "days_left": days,
		})
	}
	result["milestones"] = milestoneItems

	type lastLog struct {
		ProjectID uint              `gorm:"column:project_id"`
		CreatedAt timeutil.DateTime `gorm:"column:created_at"`
	}
	var lastRows []lastLog
	if err := h.DB.Model(&model.ProgressLog{}).Select("project_id, MAX(created_at) AS created_at").
		Where("project_id IN ?", projectIDs).Group("project_id").Scan(&lastRows).Error; err != nil {
		return nil, err
	}
	lastMap := make(map[uint]timeutil.DateTime, len(lastRows))
	for _, row := range lastRows {
		lastMap[row.ProjectID] = row.CreatedAt
	}
	var projectRows []model.Project
	if err := h.DB.Select("id", "status").Where("id IN ?", projectIDs).Find(&projectRows).Error; err != nil {
		return nil, err
	}
	stagnantItems := make([]gin.H, 0)
	for _, row := range projectRows {
		if row.Status != "doing" {
			continue
		}
		days := stagnantDays
		if last, exists := lastMap[row.ID]; exists && !last.IsZero() {
			days = int(now.Sub(last.Time).Hours() / 24)
		}
		if days >= stagnantDays {
			stagnantItems = append(stagnantItems, gin.H{
				"project_id": row.ID, "name": projectNames[row.ID], "days_no_log": days,
				"ref_type": "project", "ref_id": row.ID,
			})
		}
	}
	result["stagnant_projects"] = stagnantItems

	type groupedAmount struct {
		ProjectID uint    `gorm:"column:project_id"`
		Subject   string  `gorm:"column:subject"`
		Amount    float64 `gorm:"column:amount"`
	}
	var budgets, expenses []groupedAmount
	if err := h.DB.Model(&model.Budget{}).Select("project_id, subject, COALESCE(SUM(amount), 0) AS amount").
		Where("project_id IN ?", projectIDs).Group("project_id, subject").Scan(&budgets).Error; err != nil {
		return nil, err
	}
	if err := h.DB.Model(&model.Expense{}).Select("project_id, subject, COALESCE(SUM(amount), 0) AS amount").
		Where("project_id IN ? AND status IN ?", projectIDs, []string{"approved", "exception"}).
		Group("project_id, subject").Scan(&expenses).Error; err != nil {
		return nil, err
	}
	spentMap := make(map[string]float64, len(expenses))
	for _, row := range expenses {
		spentMap[fmt.Sprintf("%d:%s", row.ProjectID, row.Subject)] = row.Amount
	}
	budgetItems := make([]gin.H, 0)
	for _, row := range budgets {
		if row.Amount == 0 {
			continue
		}
		spent := spentMap[fmt.Sprintf("%d:%s", row.ProjectID, row.Subject)]
		rate := round4(spent / row.Amount)
		warn, over := rate >= warnRate, spent > row.Amount
		if !warn && !over {
			continue
		}
		budgetItems = append(budgetItems, gin.H{
			"project_id": row.ProjectID, "subject": row.Subject,
			"budget": round2(row.Amount), "spent": round2(spent),
			"balance": round2(row.Amount - spent), "rate": rate,
			"warn": warn, "over": over, "ref_type": "project",
			"ref_id": row.ProjectID, "ref_key": strconv.FormatUint(uint64(row.ProjectID), 10) + ":" + row.Subject,
		})
	}
	result["budget_warnings"] = budgetItems

	var followups []model.Followup
	if err := h.DB.Where("project_id IN ? AND remind_at IS NOT NULL AND remind_at <= ? AND remind_state = ?", projectIDs, now, "pending").
		Order("remind_at ASC").Limit(500).Find(&followups).Error; err != nil {
		return nil, err
	}
	followupItems := make([]gin.H, 0, len(followups))
	for _, row := range followups {
		followupItems = append(followupItems, gin.H{
			"followup_id": row.ID, "project_id": row.ProjectID,
			"user_id": row.UserID, "remind_at": row.RemindAt,
			"content": row.Content, "ref_type": "followup", "ref_id": row.ID,
		})
	}
	result["followup_due"] = followupItems
	return result, nil
}

func sysInt(db *gorm.DB, key string, fallback, min, max int) int {
	var row model.SysParam
	if err := db.Where("key = ?", key).First(&row).Error; err != nil {
		return fallback
	}
	value, err := strconv.Atoi(strings.TrimSpace(row.Value))
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}

func sysFloat(db *gorm.DB, key string, fallback, min, max float64) float64 {
	var row model.SysParam
	if err := db.Where("key = ?", key).First(&row).Error; err != nil {
		return fallback
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(row.Value), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < min || value > max {
		return fallback
	}
	return value
}
