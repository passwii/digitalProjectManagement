package dashboard

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
)

func healthy(status string, rate float64, overdue, stagnantDays, milestoneOverdue, milestoneNear int) string {
	if status == "cancelled" || status == "archived" {
		return "closed"
	}
	if status != "doing" {
		stagnantDays = 0
	}
	if rate > 1 || overdue >= 3 || stagnantDays >= 14 || milestoneOverdue > 0 {
		return "bad"
	}
	if overdue > 0 || stagnantDays >= 7 || rate >= .8 || milestoneNear > 0 {
		return "risk"
	}
	return "ok"
}

type projectHealth struct {
	ID               uint           `json:"id"`
	Code             string         `json:"code"`
	Name             string         `json:"name"`
	Status           string         `json:"status"`
	Priority         string         `json:"priority"`
	OwnerID          *uint          `json:"owner_id"`
	Progress         float64        `json:"progress"`
	PlanEnd          *timeutil.Date `json:"plan_end"`
	Budget           float64        `json:"budget"`
	Spent            float64        `json:"spent"`
	Rate             float64        `json:"rate"`
	OverdueTasks     int            `json:"overdue_tasks"`
	StagnantDays     int            `json:"stagnant_days"`
	MilestoneOverdue int            `json:"milestone_overdue"`
	MilestoneNear    int            `json:"milestone_near"`
	Health           string         `json:"health"`
}

type summaryData struct {
	KPI       gin.H           `json:"kpi"`
	Trend     []gin.H         `json:"trend"`
	BySubject []gin.H         `json:"by_subject"`
	Health    []projectHealth `json:"health"`
}

func (h *Handler) Summary(c *gin.Context) {
	data, err := h.buildSummary(rbac.GetCurrentUser(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成工作台汇总失败"})
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *Handler) Health(c *gin.Context) {
	data, err := h.buildSummary(rbac.GetCurrentUser(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询项目健康度失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": data.Health})
}

func (h *Handler) buildSummary(user *model.User) (summaryData, error) {
	var projects []model.Project
	q := h.DB.Where("id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	if err := q.Find(&projects).Error; err != nil {
		return summaryData{}, err
	}
	projectIDs := make([]uint, 0, len(projects))
	for _, row := range projects {
		projectIDs = append(projectIDs, row.ID)
	}
	now := timeutil.AppNow()
	today := timeutil.NewDate(now)
	month := now.Format("2006-01")

	myProjects := make(map[uint]bool)
	if rbac.HasProjectScope(user) {
		for _, row := range projects {
			myProjects[row.ID] = true
		}
	} else if len(projectIDs) > 0 {
		var members []model.ProjectMember
		if err := h.DB.Where("user_id = ? AND project_id IN ?", user.ID, projectIDs).Find(&members).Error; err != nil {
			return summaryData{}, err
		}
		for _, row := range members {
			myProjects[row.ProjectID] = true
		}
		for _, row := range projects {
			if row.OwnerID != nil && *row.OwnerID == user.ID {
				myProjects[row.ID] = true
			}
		}
	}

	var tasks []model.Task
	if len(projectIDs) > 0 {
		if err := h.DB.Where("project_id IN ?", projectIDs).Find(&tasks).Error; err != nil {
			return summaryData{}, err
		}
	}
	overdueByProject := map[uint]int{}
	myTaskIDs := map[uint]bool{}
	overdueCount, myOverdueCount := 0, 0
	for _, row := range tasks {
		if row.OwnerID != nil && *row.OwnerID == user.ID {
			myTaskIDs[row.ID] = true
		}
		if row.PlanEnd != nil && row.PlanEnd.Before(today.Time) && row.Progress < 100 && row.Status != "done" {
			overdueByProject[row.ProjectID]++
			overdueCount++
			if myTaskIDs[row.ID] {
				myOverdueCount++
			}
		}
	}

	lastLogs := map[uint]timeutil.DateTime{}
	if len(projectIDs) > 0 {
		type lastLog struct {
			ProjectID uint              `gorm:"column:project_id"`
			CreatedAt timeutil.DateTime `gorm:"column:created_at"`
		}
		var rows []lastLog
		if err := h.DB.Model(&model.ProgressLog{}).Select("project_id, MAX(created_at) AS created_at").
			Where("project_id IN ?", projectIDs).Group("project_id").Scan(&rows).Error; err != nil {
			return summaryData{}, err
		}
		for _, row := range rows {
			lastLogs[row.ProjectID] = row.CreatedAt
		}
	}
	stagnant := map[uint]int{}
	for _, row := range projects {
		last, exists := lastLogs[row.ID]
		if !exists || last.IsZero() {
			stagnant[row.ID] = 999
		} else {
			stagnant[row.ID] = int(now.Sub(last.Time).Hours() / 24)
		}
	}

	type amountGroup struct {
		ProjectID uint    `gorm:"column:project_id"`
		Subject   string  `gorm:"column:subject"`
		Amount    float64 `gorm:"column:amount"`
	}
	budgetByProject := map[uint]float64{}
	spentByProject := map[uint]float64{}
	bySubjectMap := map[string]map[string]float64{}
	if len(projectIDs) > 0 {
		var budgets []amountGroup
		if err := h.DB.Model(&model.Budget{}).Select("project_id, subject, COALESCE(SUM(amount),0) AS amount").
			Where("project_id IN ?", projectIDs).Group("project_id, subject").Scan(&budgets).Error; err != nil {
			return summaryData{}, err
		}
		for _, row := range budgets {
			budgetByProject[row.ProjectID] += row.Amount
			addSubject(bySubjectMap, row.Subject)["budget"] += row.Amount
		}
		var expenses []amountGroup
		if err := h.DB.Model(&model.Expense{}).Select("project_id, subject, COALESCE(SUM(amount),0) AS amount").
			Where("project_id IN ? AND status IN ?", projectIDs, []string{"approved", "exception"}).
			Group("project_id, subject").Scan(&expenses).Error; err != nil {
			return summaryData{}, err
		}
		for _, row := range expenses {
			spentByProject[row.ProjectID] += row.Amount
			addSubject(bySubjectMap, row.Subject)["spent"] += row.Amount
		}
	}

	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, timeutil.Loc).AddDate(0, -5, 0)
	trendMap := map[string]float64{}
	if len(projectIDs) > 0 {
		var rows []model.Expense
		if err := h.DB.Select("exp_date, amount").Where(
			"project_id IN ? AND status IN ? AND exp_date >= ? AND exp_date < ?",
			projectIDs, []string{"approved", "exception"}, monthStart, now.AddDate(0, 0, 1),
		).Find(&rows).Error; err != nil {
			return summaryData{}, err
		}
		for _, row := range rows {
			if row.ExpDate != nil {
				trendMap[row.ExpDate.Format("2006-01")] += row.Amount
			}
		}
	}
	trend := make([]gin.H, 0, 6)
	for offset := 5; offset >= 0; offset-- {
		date := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, timeutil.Loc).AddDate(0, -offset, 0)
		key := date.Format("2006-01")
		trend = append(trend, gin.H{"month": key, "spent": round2(trendMap[key])})
	}

	var milestones []model.Milestone
	if len(projectIDs) > 0 {
		if err := h.DB.Where("project_id IN ? AND status = ?", projectIDs, "open").Find(&milestones).Error; err != nil {
			return summaryData{}, err
		}
	}
	nearByProject, overdueMileByProject := map[uint]int{}, map[uint]int{}
	nearMilestoneCount := 0
	for _, row := range milestones {
		if row.PlanDate == nil || row.ActualDate != nil {
			continue
		}
		days := int(row.PlanDate.Sub(today.Time).Hours() / 24)
		if days < 0 {
			overdueMileByProject[row.ProjectID]++
		} else if days <= 3 {
			nearByProject[row.ProjectID]++
			nearMilestoneCount++
		}
	}

	var pendingApprovals int64
	if rbac.CanApprove(user) {
		h.DB.Model(&model.Project{}).Where("status = ? AND deleted_at IS NULL", "pending").Count(&pendingApprovals)
		var count int64
		h.DB.Model(&model.BudgetAdjust{}).Where("status = ? AND project_id IN (?)", "pending", projectdomain.VisibleProjectIDs(h.DB, user)).Count(&count)
		pendingApprovals += count
		h.DB.Model(&model.Expense{}).Where("status = ? AND project_id IN (?)", "pending", projectdomain.VisibleProjectIDs(h.DB, user)).Count(&count)
		pendingApprovals += count
	}
	var unread int64
	if err := h.DB.Model(&model.Notification{}).Where("user_id = ? AND read_at IS NULL", user.ID).Count(&unread).Error; err != nil {
		return summaryData{}, err
	}

	healthRows := make([]projectHealth, 0, len(projects))
	totalBudget, totalSpent := float64(0), float64(0)
	activeProjects, stagnantProjects := 0, 0
	for _, row := range projects {
		budgetAmount, spentAmount := budgetByProject[row.ID], spentByProject[row.ID]
		totalBudget += budgetAmount
		totalSpent += spentAmount
		if row.Status == "filed" || row.Status == "doing" {
			activeProjects++
		}
		if row.Status == "doing" && stagnant[row.ID] >= 7 {
			stagnantProjects++
		}
		rate := float64(0)
		if budgetAmount > 0 {
			rate = spentAmount / budgetAmount
		}
		healthRows = append(healthRows, projectHealth{
			ID: row.ID, Code: row.Code, Name: row.Name, Status: row.Status,
			Priority: row.Priority, OwnerID: row.OwnerID, Progress: row.Progress,
			PlanEnd: row.PlanEnd, Budget: round2(budgetAmount), Spent: round2(spentAmount),
			Rate: round4(rate), OverdueTasks: overdueByProject[row.ID],
			StagnantDays: stagnant[row.ID], MilestoneOverdue: overdueMileByProject[row.ID],
			MilestoneNear: nearByProject[row.ID],
			Health:        healthy(row.Status, rate, overdueByProject[row.ID], stagnant[row.ID], overdueMileByProject[row.ID], nearByProject[row.ID]),
		})
	}
	healthRank := map[string]int{"bad": 0, "risk": 1, "ok": 2, "closed": 3}
	sort.Slice(healthRows, func(i, j int) bool {
		if healthRank[healthRows[i].Health] != healthRank[healthRows[j].Health] {
			return healthRank[healthRows[i].Health] < healthRank[healthRows[j].Health]
		}
		return healthRows[i].Progress > healthRows[j].Progress
	})
	bySubject := make([]gin.H, 0, len(bySubjectMap))
	for subject, values := range bySubjectMap {
		bySubject = append(bySubject, gin.H{"subject": subject, "budget": round2(values["budget"]), "spent": round2(values["spent"])})
	}
	sort.Slice(bySubject, func(i, j int) bool { return bySubject[i]["subject"].(string) < bySubject[j]["subject"].(string) })
	if len(healthRows) > 20 {
		healthRows = healthRows[:20]
	}
	totalRate := float64(0)
	if totalBudget > 0 {
		totalRate = totalSpent / totalBudget
	}
	return summaryData{
		KPI: gin.H{
			"my_projects": len(myProjects), "active_projects": activeProjects,
			"overdue_tasks": overdueCount, "my_overdue_tasks": myOverdueCount,
			"near_milestones": nearMilestoneCount, "stagnant_projects": stagnantProjects,
			"total_budget": round2(totalBudget), "total_spent": round2(totalSpent),
			"total_rate": round4(totalRate), "month_spent": round2(trendMap[month]),
			"month": month, "pending_approvals": pendingApprovals, "unread_notifications": unread,
		},
		Trend: trend, BySubject: bySubject, Health: healthRows,
	}, nil
}

func addSubject(values map[string]map[string]float64, subject string) map[string]float64 {
	if subject == "" {
		subject = "其他"
	}
	if values[subject] == nil {
		values[subject] = map[string]float64{"budget": 0, "spent": 0}
	}
	return values[subject]
}

func (h *Handler) MyWeekly(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectsQuery := h.DB.Where("id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	projectID, err := strconv.ParseUint(c.DefaultQuery("project_id", "0"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "project_id 须为正整数"})
		return
	}
	if projectID > 0 {
		projectsQuery = projectsQuery.Where("id = ?", projectID)
	}
	var projects []model.Project
	if err := projectsQuery.Find(&projects).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询可见项目失败"})
		return
	}
	if projectID > 0 && len(projects) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在或无权访问"})
		return
	}
	projectIDs := make([]uint, 0, len(projects))
	for _, row := range projects {
		projectIDs = append(projectIDs, row.ID)
	}
	now := timeutil.AppNow()
	weekAgo := now.AddDate(0, 0, -7)
	logs := []model.ProgressLog{}
	tasks := []model.Task{}
	if len(projectIDs) > 0 {
		if err := h.DB.Where("project_id IN ? AND created_at >= ?", projectIDs, weekAgo).Order("id DESC").Limit(50).Find(&logs).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询本周填报失败"})
			return
		}
		if err := h.DB.Where("project_id IN ?", projectIDs).Find(&tasks).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询任务失败"})
			return
		}
	}
	today := timeutil.NewDate(now)
	dueLimit := timeutil.NewDate(now.AddDate(0, 0, 7))
	overdue, dueSoon := make([]gin.H, 0), make([]gin.H, 0)
	for _, row := range tasks {
		if row.PlanEnd == nil || row.Progress >= 100 {
			continue
		}
		item := gin.H{"id": row.ID, "name": row.Name, "project_id": row.ProjectID, "plan_end": row.PlanEnd.Format("2006-01-02"), "progress": row.Progress, "owner_id": row.OwnerID}
		if row.PlanEnd.Before(today.Time) && row.Status != "done" {
			overdue = append(overdue, item)
		} else if !row.PlanEnd.Before(today.Time) && !row.PlanEnd.After(dueLimit.Time) {
			dueSoon = append(dueSoon, item)
		}
	}
	logItems := make([]gin.H, 0, len(logs))
	for _, row := range logs {
		logItems = append(logItems, gin.H{
			"task_id": row.TaskID, "project_id": row.ProjectID, "user_id": row.UserID,
			"progress": row.Progress, "note": row.Note, "created_at": row.CreatedAt,
		})
	}
	projectItems := make([]gin.H, 0, len(projects))
	for _, row := range projects {
		projectItems = append(projectItems, gin.H{"id": row.ID, "code": row.Code, "name": row.Name, "status": row.Status, "progress": row.Progress})
	}
	c.JSON(http.StatusOK, gin.H{
		"range":      gin.H{"from": weekAgo.Format("2006-01-02"), "to": today.Format("2006-01-02")},
		"project_id": optionalProjectID(uint(projectID)), "progress_logs": logItems,
		"log_count": len(logs), "overdue": overdue, "due_soon": dueSoon, "projects": projectItems,
	})
}

func optionalProjectID(value uint) any {
	if value == 0 {
		return nil
	}
	return value
}

func round2(value float64) float64 { return math.Round(value*100) / 100 }
func round4(value float64) float64 { return math.Round(value*10000) / 10000 }
