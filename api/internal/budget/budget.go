package budget

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var budgetSubjects = map[string]bool{"人工": true, "采购": true, "外包": true, "差旅": true, "其他": true}
var passingExpenseStatuses = []string{"approved", "exception"}

var budgetSorts = map[string]string{
	"id": "budgets.id", "project_id": "budgets.project_id", "subject": "budgets.subject",
	"amount": "budgets.amount", "period_start": "budgets.period_start",
	"period_end": "budgets.period_end", "created_at": "budgets.created_at",
}

func adjustmentDecision(approvalOn bool) (status string, auto bool) {
	if approvalOn {
		return "pending", false
	}
	return "approved", true
}

func (h *Handler) List(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectID, ok := budgetQueryID(c, "project_id")
	if !ok {
		return
	}
	q := h.DB.Model(&model.Budget{})
	if projectID > 0 {
		if _, err := projectdomain.LoadVisibleProject(h.DB, user, projectID); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
			return
		}
		q = q.Where("project_id = ?", projectID)
	} else {
		q = q.Where("project_id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	}
	if subject := strings.TrimSpace(c.Query("subject")); subject != "" {
		q = q.Where("subject = ?", subject)
	}
	page, size, ok := budgetPagination(c)
	if !ok {
		return
	}
	result, err := paging.Paginate[model.Budget](q, page, size, c.Query("sort"), budgetSorts, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	execution := h.executionForBudgets(result.Items)
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		spent := execution[budgetKey{row.ProjectID, row.Subject}]
		rate := float64(0)
		if row.Amount > 0 {
			rate = spent / row.Amount
		}
		items = append(items, gin.H{
			"id": row.ID, "project_id": row.ProjectID, "subject": row.Subject,
			"amount": row.Amount, "period_start": dateText(row.PeriodStart),
			"period_end": dateText(row.PeriodEnd), "spent": spent,
			"balance": row.Amount - spent, "rate": rate, "warn": rate >= .8,
			"over": spent > row.Amount,
		})
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

type budgetKey struct {
	projectID uint
	subject   string
}

func (h *Handler) executionForBudgets(rows []model.Budget) map[budgetKey]float64 {
	result := make(map[budgetKey]float64, len(rows))
	if len(rows) == 0 {
		return result
	}
	projectIDs := make([]uint, 0, len(rows))
	subjects := make([]string, 0, len(rows))
	keys := make(map[budgetKey]bool, len(rows))
	for _, row := range rows {
		key := budgetKey{row.ProjectID, row.Subject}
		if keys[key] {
			continue
		}
		keys[key] = true
		projectIDs = append(projectIDs, row.ProjectID)
		subjects = append(subjects, row.Subject)
	}
	type spendRow struct {
		ProjectID uint    `gorm:"column:project_id"`
		Subject   string  `gorm:"column:subject"`
		Amount    float64 `gorm:"column:amount"`
	}
	var spendRows []spendRow
	h.DB.Model(&model.Expense{}).
		Select("project_id, subject, COALESCE(SUM(amount), 0) AS amount").
		Where("project_id IN ? AND subject IN ? AND status IN ?", projectIDs, subjects, passingExpenseStatuses).
		Group("project_id, subject").Scan(&spendRows)
	for _, row := range spendRows {
		result[budgetKey{row.ProjectID, row.Subject}] = row.Amount
	}
	return result
}

func dateText(value *timeutil.Date) any {
	if value == nil {
		return nil
	}
	return value.Format("2006-01-02")
}

func (h *Handler) Create(c *gin.Context) {
	var req struct {
		ProjectID   uint           `json:"project_id"`
		Subject     string         `json:"subject"`
		Amount      float64        `json:"amount"`
		PeriodStart *timeutil.Date `json:"period_start"`
		PeriodEnd   *timeutil.Date `json:"period_end"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := projectdomain.LoadVisibleProject(h.DB, user, req.ProjectID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
		return
	}
	if projectRow.Status == "archived" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
		return
	}
	req.Subject = strings.TrimSpace(req.Subject)
	if !budgetSubjects[req.Subject] {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "预算科目无效"})
		return
	}
	if !validAmount(req.Amount) || req.Amount < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "预算金额须为大于等于 0 的有效数字"})
		return
	}
	if err := validatePeriod(req.PeriodStart, req.PeriodEnd, projectRow); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	now := timeutil.NowDateTime()
	row := model.Budget{
		ProjectID: req.ProjectID, Subject: req.Subject, Amount: req.Amount,
		PeriodStart: req.PeriodStart, PeriodEnd: req.PeriodEnd,
		CreatedAt: now, UpdatedAt: now,
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "create_budget", "budgets", strconv.FormatUint(uint64(row.ID), 10), req.Subject, c.ClientIP())
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "创建预算失败"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": row.ID, "project_id": row.ProjectID, "subject": row.Subject,
		"amount": row.Amount, "period_start": dateText(row.PeriodStart), "period_end": dateText(row.PeriodEnd),
		"spent": 0, "balance": row.Amount, "rate": 0, "warn": false, "over": false,
	})
}

func (h *Handler) SubmitAdjustment(c *gin.Context) {
	id, ok := budgetPathID(c, "bid")
	if !ok {
		return
	}
	var req struct {
		Amount *float64 `json:"amount"`
		Reason string   `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Amount == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "调整后金额必填"})
		return
	}
	if !validAmount(*req.Amount) || *req.Amount < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "调整后金额须为大于等于 0 的有效数字"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Budget
		if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&row, id).Error; err != nil {
			return err
		}
		projectRow, err := projectdomain.LoadVisibleProject(tx, user, row.ProjectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errBudgetProjectArchived
		}
		if row.Amount == *req.Amount {
			return errBudgetUnchanged
		}
		var setting model.SysParam
		approvalOn := tx.Where("key = ?", "budget_approval_on").First(&setting).Error == nil && setting.Value == "1"
		status, auto := adjustmentDecision(approvalOn)
		now := timeutil.NowDateTime()
		adjust := model.BudgetAdjust{
			BudgetID: row.ID, ProjectID: row.ProjectID, OldAmount: row.Amount,
			NewAmount: *req.Amount, Reason: strings.TrimSpace(req.Reason),
			Status: status, ByID: &user.ID, CreatedAt: now,
		}
		if auto {
			row.Amount = *req.Amount
			row.UpdatedAt = now
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
			adjust.DecisionReason = "审批开关关闭，系统自动生效"
			adjust.DecidedAt = &now
		}
		if err := tx.Create(&adjust).Error; err != nil {
			return err
		}
		projectID := row.ProjectID
		if err := tx.Create(&model.ApprovalRecord{
			Kind: "budget_adjust", RefID: adjust.ID, ProjectID: &projectID,
			Action: "submit", FromStatus: "", ToStatus: "pending",
			ActorID: &user.ID, Reason: strings.TrimSpace(req.Reason), CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		if auto {
			if err := tx.Create(&model.ApprovalRecord{
				Kind: "budget_adjust", RefID: adjust.ID, ProjectID: &projectID,
				Action: "auto", FromStatus: "pending", ToStatus: "approved",
				Reason: adjust.DecisionReason, CreatedAt: now,
			}).Error; err != nil {
				return err
			}
		}
		if err := audit.CommitAudited(tx, &user.ID, "adjust_budget", "budget_adjusts", strconv.FormatUint(uint64(adjust.ID), 10), row.Subject, c.ClientIP()); err != nil {
			return err
		}
		response = gin.H{
			"id": adjust.ID, "status": adjust.Status, "project_id": row.ProjectID,
			"subject": row.Subject, "old_amount": adjust.OldAmount, "new_amount": adjust.NewAmount,
			"decision_reason": adjust.DecisionReason,
		}
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			c.JSON(http.StatusNotFound, gin.H{"detail": "预算不存在"})
		case errBudgetProjectArchived:
			c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
		case errBudgetUnchanged:
			c.JSON(http.StatusBadRequest, gin.H{"detail": "调整后金额与当前预算相同"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "提交预算调整失败"})
		}
		return
	}
	c.JSON(http.StatusCreated, response)
}

func validAmount(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func validatePeriod(start, end *timeutil.Date, project model.Project) error {
	if start != nil && end != nil && start.After(end.Time) {
		return errors.New("预算期间开始不能晚于结束")
	}
	if start != nil && project.PlanStart != nil && start.Before(project.PlanStart.Time) {
		return errors.New("预算期间须落在项目计划期内")
	}
	if end != nil && project.PlanEnd != nil && end.After(project.PlanEnd.Time) {
		return errors.New("预算期间须落在项目计划期内")
	}
	return nil
}

func budgetQueryID(c *gin.Context, key string) (uint, bool) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" || raw == "0" {
		return 0, true
	}
	value, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": key + " 须为正整数"})
		return 0, false
	}
	return uint(value), true
}

func budgetPathID(c *gin.Context, key string) (uint, bool) {
	value, err := strconv.ParseUint(c.Param(key), 10, 32)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "ID 格式无效"})
		return 0, false
	}
	return uint(value), true
}

func budgetPagination(c *gin.Context) (int, int, bool) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "page 须为正整数"})
		return 0, 0, false
	}
	size, err := strconv.Atoi(c.DefaultQuery("size", "20"))
	if err != nil || size < 1 || size > paging.MaxPageSize {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "size 须为 1-100"})
		return 0, 0, false
	}
	return page, size, true
}

func budgetDate(raw json.RawMessage) (*timeutil.Date, error) {
	if string(raw) == "null" || len(raw) == 0 {
		return nil, nil
	}
	var value timeutil.Date
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, err
	}
	return &value, nil
}

var (
	errBudgetProjectArchived = errors.New("budget project archived")
	errBudgetUnchanged       = errors.New("budget unchanged")
)
