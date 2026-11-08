package expense

import (
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

var expenseSorts = map[string]string{
	"id": "expenses.id", "project_id": "expenses.project_id",
	"subject": "expenses.subject", "amount": "expenses.amount",
	"exp_date": "expenses.exp_date", "status": "expenses.status",
	"by_id": "expenses.by_id", "created_at": "expenses.created_at",
}

func initialExpenseStatus(approvalOn, overBudget bool) string {
	if approvalOn || overBudget {
		return "pending"
	}
	return "approved"
}

func (h *Handler) List(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectID, ok := expenseQueryID(c, "project_id")
	if !ok {
		return
	}
	q := h.DB.Model(&model.Expense{})
	if projectID > 0 {
		if _, err := projectdomain.LoadVisibleProject(h.DB, user, projectID); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
			return
		}
		q = q.Where("project_id = ?", projectID)
	} else {
		q = q.Where("project_id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	}
	for _, key := range []string{"status", "subject"} {
		if value := strings.TrimSpace(c.Query(key)); value != "" {
			q = q.Where(key+" = ?", value)
		}
	}
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		q = q.Where("note ILIKE ?", "%"+keyword+"%")
	}
	if c.Query("mine") == "1" {
		q = q.Where("by_id = ?", user.ID)
	}
	for _, filter := range []struct {
		key string
		op  string
	}{
		{"date_from", ">="}, {"date_to", "<="},
	} {
		if raw := strings.TrimSpace(c.Query(filter.key)); raw != "" {
			date, err := parseDate(raw)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"detail": filter.key + " 格式须为 YYYY-MM-DD"})
				return
			}
			q = q.Where("(exp_date IS NULL OR exp_date "+filter.op+" ?)", date)
		}
	}
	page, size, ok := expensePagination(c)
	if !ok {
		return
	}
	result, err := paging.Paginate[model.Expense](q.Preload("User").Preload("Approver"), page, size, c.Query("sort"), expenseSorts, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		items = append(items, expenseRow(row))
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

func expenseRow(row model.Expense) gin.H {
	return gin.H{
		"id": row.ID, "project_id": row.ProjectID, "subject": row.Subject,
		"amount": row.Amount, "exp_date": dateString(row.ExpDate), "note": row.Note,
		"status": row.Status, "by_id": row.ByID, "approved_by": row.ApprovedBy,
		"decision_reason": row.DecisionReason, "decided_at": row.DecidedAt,
		"resubmit_count": row.ResubmitCount, "can_resubmit": row.Status == "rejected",
	}
}

func (h *Handler) Create(c *gin.Context) {
	var req struct {
		ProjectID uint           `json:"project_id"`
		Subject   string         `json:"subject"`
		Amount    float64        `json:"amount"`
		ExpDate   *timeutil.Date `json:"exp_date"`
		Note      string         `json:"note"`
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
	subject := strings.TrimSpace(req.Subject)
	if len([]rune(subject)) > 32 || !finite(req.Amount) || req.Amount <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "支出科目或金额无效，金额须大于 0"})
		return
	}
	if req.ExpDate != nil {
		if projectRow.PlanStart != nil && req.ExpDate.Before(projectRow.PlanStart.Time) {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "支出日期不能早于项目计划开始"})
			return
		}
		if req.ExpDate.After(timeutil.AppNow().AddDate(1, 0, 1)) {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "支出日期超出合理范围"})
			return
		}
	}
	var response gin.H
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		approvalOn := approvalEnabled(tx, "expense_approval_on")
		budgetAmount, err := subjectBudget(tx, req.ProjectID, subject)
		if err != nil {
			return err
		}
		spent, err := subjectSpent(tx, req.ProjectID, subject)
		if err != nil {
			return err
		}
		over := budgetAmount > 0 && spent+req.Amount > budgetAmount
		status := initialExpenseStatus(approvalOn, over)
		now := timeutil.NowDateTime()
		row := model.Expense{
			ProjectID: req.ProjectID, Subject: subject, Amount: req.Amount,
			ExpDate: req.ExpDate, Note: strings.TrimSpace(req.Note), Status: status,
			ByID: &user.ID, CreatedAt: now,
		}
		if status == "approved" {
			row.DecidedAt = &now
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: req.ProjectID, Field: "expense",
			New:  "登记「" + subject + "」" + strconv.FormatFloat(req.Amount, 'f', 2, 64) + " 元（" + status + "）",
			ByID: &user.ID, At: now,
		}).Error; err != nil {
			return err
		}
		projectID := req.ProjectID
		reason := ""
		if over {
			reason = "超预算待审批"
		}
		if err := tx.Create(&model.ApprovalRecord{
			Kind: "expense", RefID: row.ID, ProjectID: &projectID,
			Action: "submit", ToStatus: status, ActorID: &user.ID,
			Reason: reason, CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "create_expense", "expenses", strconv.FormatUint(uint64(row.ID), 10), status, c.ClientIP()); err != nil {
			return err
		}
		response = expenseRow(row)
		response["execution"] = executionSnapshot(budgetAmount, spent+req.Amount)
		response["over_budget"] = over
		return nil
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "登记支出失败"})
		return
	}
	c.JSON(http.StatusCreated, response)
}

func approvalEnabled(db *gorm.DB, key string) bool {
	var param model.SysParam
	return db.Where("key = ?", key).First(&param).Error == nil && param.Value == "1"
}

func subjectBudget(db *gorm.DB, projectID uint, subject string) (float64, error) {
	var total float64
	q := db.Model(&model.Budget{}).Where("project_id = ?", projectID)
	if subject = strings.TrimSpace(subject); subject != "" {
		q = q.Where("subject = ?", subject)
	}
	err := q.Select("COALESCE(SUM(amount), 0)").Scan(&total).Error
	return total, err
}

func subjectSpent(db *gorm.DB, projectID uint, subject string) (float64, error) {
	var total float64
	q := db.Model(&model.Expense{}).Where("project_id = ? AND status IN ?", projectID, []string{"approved", "exception"})
	if subject = strings.TrimSpace(subject); subject != "" {
		q = q.Where("subject = ?", subject)
	}
	err := q.Select("COALESCE(SUM(amount), 0)").Scan(&total).Error
	return total, err
}

func executionSnapshot(budget, spent float64) gin.H {
	rate := float64(0)
	if budget > 0 {
		rate = spent / budget
	}
	return gin.H{"budget": budget, "spent": spent, "balance": budget - spent, "rate": rate, "warn": rate >= .8, "over": spent > budget}
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func parseDate(raw string) (timeutil.Date, error) {
	var value timeutil.Date
	err := value.UnmarshalJSON([]byte(strconv.Quote(raw)))
	return value, err
}

func dateString(value *timeutil.Date) any {
	if value == nil {
		return nil
	}
	return value.Format("2006-01-02")
}

func expensePathID(c *gin.Context, key string) (uint, bool) {
	value, err := strconv.ParseUint(c.Param(key), 10, 32)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "ID 格式无效"})
		return 0, false
	}
	return uint(value), true
}

func expenseQueryID(c *gin.Context, key string) (uint, bool) {
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

func expensePagination(c *gin.Context) (int, int, bool) {
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

func loadExpense(db *gorm.DB, id uint, user *model.User, write bool) (model.Expense, model.Project, error) {
	var row model.Expense
	if err := db.First(&row, id).Error; err != nil {
		return row, model.Project{}, err
	}
	projectRow, err := projectdomain.LoadVisibleProject(db, user, row.ProjectID)
	if err != nil {
		return row, projectRow, err
	}
	if write && projectRow.Status == "archived" {
		return row, projectRow, errExpenseProjectArchived
	}
	return row, projectRow, nil
}

var (
	errExpenseProjectArchived = errors.New("expense project archived")
	errExpenseRejectedOnly    = errors.New("expense is not rejected")
	errExpenseNotPending      = errors.New("expense is not pending")
	errExpenseOverBudget      = errors.New("expense exceeds budget")
	errExpenseApplicantOnly   = errors.New("expense applicant only")
	errExpenseReasonRequired  = errors.New("decision reason required")
	errExpenseDecisionState   = errors.New("expense cannot be decided in current state")
	errExpenseAttachment      = errors.New("expense attachment not found")
	errExpenseForbidden       = errors.New("expense action forbidden")
)

var expenseUpdateLock = clause.Locking{Strength: clause.LockingStrengthUpdate}

var _ = audit.CommitAudited
