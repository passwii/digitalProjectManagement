package approval

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/notify"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var approvalKinds = map[string]bool{
	"project_filing": true, "budget_adjust": true, "expense": true,
}

func knownApprovalKind(kind string) bool {
	return approvalKinds[kind]
}

func (h *Handler) Pending(c *gin.Context) {
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "200"))
	if err != nil || limit < 1 || limit > 500 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "limit 须为 1-500"})
		return
	}
	kind := strings.TrimSpace(c.Query("kind"))
	if kind != "" && !knownApprovalKind(kind) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "审批类型无效"})
		return
	}
	want := func(candidate string) bool { return kind == "" || kind == candidate }
	activeProjectIDs := h.DB.Model(&model.Project{}).Select("id").Where("deleted_at IS NULL")
	var filingCount, adjustmentCount, expenseCount int64
	result := gin.H{
		"project_filings": []gin.H{}, "budget_adjusts": []gin.H{}, "expenses": []gin.H{},
		"total": 0, "totals": gin.H{"project_filings": filingCount, "budget_adjusts": adjustmentCount, "expenses": expenseCount},
		"limit": limit, "kind": kind,
	}
	totals := gin.H{"project_filings": filingCount, "budget_adjusts": adjustmentCount, "expenses": expenseCount}
	total := filingCount + adjustmentCount + expenseCount

	var filings []model.Project
	if want("project_filing") {
		q := h.DB.Model(&model.Project{}).Where("status = ? AND deleted_at IS NULL", "pending")
		if err := q.Count(&filingCount).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "统计立项待办失败"})
			return
		}
		totals["project_filings"] = filingCount
		if err := q.Order("id DESC").Limit(limit).Find(&filings).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询立项待办失败"})
			return
		}
	}

	var adjustments []model.BudgetAdjust
	if want("budget_adjust") {
		q := h.DB.Model(&model.BudgetAdjust{}).Where("status = ? AND project_id IN (?)", "pending", activeProjectIDs)
		if err := q.Count(&adjustmentCount).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "统计预算待办失败"})
			return
		}
		totals["budget_adjusts"] = adjustmentCount
		if err := q.Order("id DESC").Limit(limit).Find(&adjustments).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询预算待办失败"})
			return
		}
	}

	var expenses []model.Expense
	if want("expense") {
		q := h.DB.Model(&model.Expense{}).Where("status = ? AND project_id IN (?)", "pending", activeProjectIDs)
		if err := q.Count(&expenseCount).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "统计支出待办失败"})
			return
		}
		totals["expenses"] = expenseCount
		if err := q.Order("id DESC").Limit(limit).Find(&expenses).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询支出待办失败"})
			return
		}
	}

	projectIDs := make(map[uint]struct{})
	actorIDs := make(map[uint]struct{})
	budgetIDs := make(map[uint]struct{})
	for _, row := range filings {
		projectIDs[row.ID] = struct{}{}
		if row.OwnerID != nil {
			actorIDs[*row.OwnerID] = struct{}{}
		}
	}
	for _, row := range adjustments {
		projectIDs[row.ProjectID] = struct{}{}
		budgetIDs[row.BudgetID] = struct{}{}
		if row.ByID != nil {
			actorIDs[*row.ByID] = struct{}{}
		}
	}
	for _, row := range expenses {
		projectIDs[row.ProjectID] = struct{}{}
		if row.ByID != nil {
			actorIDs[*row.ByID] = struct{}{}
		}
	}
	projectNames := map[uint]string{}
	if len(projectIDs) > 0 {
		ids := uintKeys(projectIDs)
		var rows []model.Project
		if err := h.DB.Select("id", "name").Where("id IN ?", ids).Find(&rows).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询项目名称失败"})
			return
		}
		for _, row := range rows {
			projectNames[row.ID] = row.Name
		}
	}
	budgetSubjects := map[uint]string{}
	if len(budgetIDs) > 0 {
		var rows []model.Budget
		if err := h.DB.Select("id", "subject").Where("id IN ?", uintKeys(budgetIDs)).Find(&rows).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询预算科目失败"})
			return
		}
		for _, row := range rows {
			budgetSubjects[row.ID] = row.Subject
		}
	}
	actorNames := map[uint]string{}
	if len(actorIDs) > 0 {
		var rows []model.User
		if err := h.DB.Select("id", "real_name", "username").Where("id IN ?", uintKeys(actorIDs)).Find(&rows).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询申请人失败"})
			return
		}
		for _, row := range rows {
			name := strings.TrimSpace(row.RealName)
			if name == "" {
				name = row.Username
			}
			actorNames[row.ID] = name
		}
	}
	filingItems := make([]gin.H, 0, len(filings))
	for _, row := range filings {
		ownerName := ""
		if row.OwnerID != nil {
			ownerName = actorNames[*row.OwnerID]
		}
		filingItems = append(filingItems, gin.H{
			"kind": "project_filing", "id": row.ID, "project_id": row.ID,
			"code": row.Code, "name": row.Name, "owner_id": row.OwnerID,
			"applicant_name": ownerName, "budget_total": row.BudgetTotal,
			"plan_start": dateString(row.PlanStart), "plan_end": dateString(row.PlanEnd),
			"status": row.Status, "can_decide": true,
		})
	}
	adjustItems := make([]gin.H, 0, len(adjustments))
	for _, row := range adjustments {
		name := ""
		if row.ByID != nil {
			name = actorNames[*row.ByID]
		}
		adjustItems = append(adjustItems, gin.H{
			"kind": "budget_adjust", "id": row.ID, "project_id": row.ProjectID,
			"project_name": projectNames[row.ProjectID], "subject": budgetSubjects[row.BudgetID],
			"old_amount": row.OldAmount, "new_amount": row.NewAmount, "reason": row.Reason,
			"by_id": row.ByID, "applicant_name": name, "decision_reason": row.DecisionReason,
			"status": row.Status, "can_decide": true,
		})
	}
	expenseItems := make([]gin.H, 0, len(expenses))
	for _, row := range expenses {
		name := ""
		if row.ByID != nil {
			name = actorNames[*row.ByID]
		}
		expenseItems = append(expenseItems, gin.H{
			"kind": "expense", "id": row.ID, "project_id": row.ProjectID,
			"project_name": projectNames[row.ProjectID], "subject": row.Subject,
			"amount": row.Amount, "exp_date": dateString(row.ExpDate), "note": row.Note,
			"by_id": row.ByID, "applicant_name": name, "resubmit_count": row.ResubmitCount,
			"status": row.Status, "can_decide": true,
		})
	}
	total = filingCount + adjustmentCount + expenseCount
	result["project_filings"], result["budget_adjusts"], result["expenses"] = filingItems, adjustItems, expenseItems
	result["total"], result["totals"] = total, totals
	c.JSON(http.StatusOK, result)
}

func (h *Handler) Timeline(c *gin.Context) {
	kind := c.Param("kind")
	if !knownApprovalKind(kind) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "审批类型无效"})
		return
	}
	id, ok := approvalID(c)
	if !ok {
		return
	}
	var records []model.ApprovalRecord
	if err := h.DB.Preload("Actor").Where("kind = ? AND ref_id = ?", kind, id).Order("id ASC").Find(&records).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询审批时间线失败"})
		return
	}
	if len(records) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"detail": "审批记录不存在"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"kind": kind, "id": id, "items": records})
}

func (h *Handler) Decide(c *gin.Context) {
	kind := c.Param("kind")
	if !knownApprovalKind(kind) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "审批类型无效"})
		return
	}
	id, ok := approvalID(c)
	if !ok {
		return
	}
	var request struct {
		Approve *bool  `json:"approve"`
		Reason  string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}
	approve := true
	if request.Approve != nil {
		approve = *request.Approve
	}
	reason := strings.TrimSpace(request.Reason)
	if !approve && reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "驳回必须填写意见"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		switch kind {
		case "project_filing":
			response, err = decideProject(tx, user, id, approve, reason, c.ClientIP())
		case "budget_adjust":
			response, err = decideBudget(tx, user, id, approve, reason, c.ClientIP())
		case "expense":
			response, err = decideExpense(tx, user, id, approve, reason, c.ClientIP())
		}
		return err
	})
	if err != nil {
		approvalError(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func decideProject(tx *gorm.DB, user *model.User, id uint, approve bool, reason, ip string) (gin.H, error) {
	var row model.Project
	if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).Where("id = ? AND deleted_at IS NULL", id).First(&row).Error; err != nil {
		return nil, err
	}
	if row.Status != "pending" {
		return nil, errApprovalHandled
	}
	old := row.Status
	row.Status = "cancelled"
	action := "reject"
	if approve {
		row.Status, action = "filed", "approve"
	}
	now := timeutil.NowDateTime()
	row.UpdatedAt = now
	if err := tx.Save(&row).Error; err != nil {
		return nil, err
	}
	if err := tx.Create(&model.ProjectChange{ProjectID: id, Field: "status", Old: old, New: row.Status, ByID: &user.ID, At: now}).Error; err != nil {
		return nil, err
	}
	projectID := id
	if err := tx.Create(&model.ApprovalRecord{
		Kind: "project_filing", RefID: id, ProjectID: &projectID,
		Action: action, FromStatus: old, ToStatus: row.Status,
		ActorID: &user.ID, Reason: reason, CreatedAt: now,
	}).Error; err != nil {
		return nil, err
	}
	if err := audit.CommitAudited(tx, &user.ID, "decide_project_filing", "projects", strconv.FormatUint(uint64(id), 10), action+" "+reason, ip); err != nil {
		return nil, err
	}
	return gin.H{"kind": "project_filing", "id": id, "status": row.Status}, nil
}

func decideBudget(tx *gorm.DB, user *model.User, id uint, approve bool, reason, ip string) (gin.H, error) {
	var row model.BudgetAdjust
	if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&row, id).Error; err != nil {
		return nil, err
	}
	if row.Status != "pending" {
		return nil, errApprovalHandled
	}
	if _, err := projectdomain.LoadVisibleProject(tx, user, row.ProjectID); err != nil {
		return nil, err
	}
	var budget model.Budget
	if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&budget, row.BudgetID).Error; err != nil {
		return nil, err
	}
	old := row.Status
	row.Status = "rejected"
	action := "reject"
	if approve {
		row.Status, action = "approved", "approve"
		budget.Amount, budget.UpdatedAt = row.NewAmount, timeutil.NowDateTime()
		if err := tx.Save(&budget).Error; err != nil {
			return nil, err
		}
	}
	now := timeutil.NowDateTime()
	row.ApprovedBy, row.DecisionReason, row.DecidedAt = &user.ID, reason, &now
	if err := tx.Save(&row).Error; err != nil {
		return nil, err
	}
	projectID := row.ProjectID
	if err := tx.Create(&model.ApprovalRecord{
		Kind: "budget_adjust", RefID: row.ID, ProjectID: &projectID,
		Action: action, FromStatus: old, ToStatus: row.Status,
		ActorID: &user.ID, Reason: reason, CreatedAt: now,
	}).Error; err != nil {
		return nil, err
	}
	if err := audit.CommitAudited(tx, &user.ID, "decide_budget_adjust", "budget_adjusts", strconv.FormatUint(uint64(row.ID), 10), action+" "+reason, ip); err != nil {
		return nil, err
	}
	return gin.H{"kind": "budget_adjust", "id": row.ID, "status": row.Status, "subject": budget.Subject, "decision_reason": reason}, nil
}

func decideExpense(tx *gorm.DB, user *model.User, id uint, approve bool, reason, ip string) (gin.H, error) {
	var row model.Expense
	if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&row, id).Error; err != nil {
		return nil, err
	}
	if row.Status != "pending" {
		return nil, errApprovalHandled
	}
	if _, err := projectdomain.LoadVisibleProject(tx, user, row.ProjectID); err != nil {
		return nil, err
	}
	if approve {
		budget, err := approvalSubjectBudget(tx, row.ProjectID, row.Subject)
		if err != nil {
			return nil, err
		}
		var spent float64
		err = tx.Model(&model.Expense{}).Select("COALESCE(SUM(amount), 0)").
			Where("project_id = ? AND subject = ? AND status IN ?", row.ProjectID, row.Subject, []string{"approved", "exception"}).Scan(&spent).Error
		if err != nil {
			return nil, err
		}
		if budget > 0 && spent+row.Amount > budget {
			return nil, errApprovalExpenseOverBudget
		}
	}
	old := row.Status
	row.Status = "rejected"
	action := "reject"
	if approve {
		row.Status, action = "approved", "approve"
	}
	now := timeutil.NowDateTime()
	row.ApprovedBy, row.DecisionReason, row.DecidedAt = &user.ID, reason, &now
	if err := tx.Save(&row).Error; err != nil {
		return nil, err
	}
	projectID := row.ProjectID
	if err := tx.Create(&model.ApprovalRecord{
		Kind: "expense", RefID: row.ID, ProjectID: &projectID,
		Action: action, FromStatus: old, ToStatus: row.Status,
		ActorID: &user.ID, Reason: reason, CreatedAt: now,
	}).Error; err != nil {
		return nil, err
	}
	if err := tx.Create(&model.ProjectChange{
		ProjectID: row.ProjectID, Field: "expense",
		New:  fmt.Sprintf("「%s」审批%s%s", row.Subject, map[bool]string{true: "通过", false: "驳回"}[approve], reason),
		ByID: &user.ID, At: now,
	}).Error; err != nil {
		return nil, err
	}
	if err := audit.CommitAudited(tx, &user.ID, "decide_expense", "expenses", strconv.FormatUint(uint64(row.ID), 10), action+" "+reason, ip); err != nil {
		return nil, err
	}
	if row.ByID != nil {
		actionLabel := "已通过"
		bodyMsg := "审批通过，金额已计入预算执行"
		if !approve {
			actionLabel = "已驳回"
			bodyMsg = reason
		}
		if bodyMsg == "" {
			bodyMsg = "当前状态：" + row.Status
		}
		title := fmt.Sprintf("支出%s：%s %s", actionLabel, row.Subject, strconv.FormatFloat(row.Amount, 'f', 2, 64))
		dedupKey := fmt.Sprintf("expense-decided:%d:%s:%d", row.ID, row.Status, row.ResubmitCount)
		_, _ = notify.Push(tx, *row.ByID, "approval", title, bodyMsg, "in_app", "expense", &row.ID, &projectID, dedupKey)
	}
	return gin.H{"kind": "expense", "id": row.ID, "status": row.Status, "decision_reason": reason}, nil
}

func uintKeys(values map[uint]struct{}) []uint {
	result := make([]uint, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	return result
}

func dateString(value *timeutil.Date) any {
	if value == nil {
		return nil
	}
	return value.Format("2006-01-02")
}

func approvalSubjectBudget(tx *gorm.DB, projectID uint, subject string) (float64, error) {
	var amount float64
	err := tx.Model(&model.Budget{}).Select("COALESCE(SUM(amount), 0)").
		Where("project_id = ? AND subject = ?", projectID, subject).Scan(&amount).Error
	return amount, err
}

func approvalID(c *gin.Context) (uint, bool) {
	value, err := strconv.ParseUint(c.Param("aid"), 10, 32)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "审批 ID 无效"})
		return 0, false
	}
	return uint(value), true
}

func approvalError(c *gin.Context, err error) {
	switch err {
	case gorm.ErrRecordNotFound:
		c.JSON(http.StatusNotFound, gin.H{"detail": "审批记录不存在"})
	case errApprovalHandled:
		c.JSON(http.StatusConflict, gin.H{"detail": "该审批已处理"})
	case errApprovalExpenseOverBudget:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "超预算：通过前请先调预算或走特批"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "审批处理失败"})
	}
}

var errApprovalHandled = errors.New("approval already handled")
var errApprovalExpenseOverBudget = errors.New("expense exceeds budget")

func (h *Handler) ExpenseException(c *gin.Context) {
	eidStr := c.Param("eid")
	eid, err := strconv.ParseUint(eidStr, 10, 32)
	if err != nil || eid == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "支出 ID 无效"})
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "特批必须填写理由"})
		return
	}
	reason := strings.TrimSpace(req.Reason)
	user := rbac.GetCurrentUser(c)
	var result model.Expense
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Expense
		if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&row, eid).Error; err != nil {
			return err
		}
		if row.Status != "pending" && row.Status != "rejected" {
			return errors.New("expense_decision_state")
		}
		if _, err := projectdomain.LoadVisibleProject(tx, user, row.ProjectID); err != nil {
			return err
		}
		old := row.Status
		now := timeutil.NowDateTime()
		row.Status = "exception"
		row.ApprovedBy = &user.ID
		row.DecisionReason = reason
		row.DecidedAt = &now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		projectID := row.ProjectID
		if err := tx.Create(&model.ApprovalRecord{
			Kind: "expense", RefID: row.ID, ProjectID: &projectID,
			Action: "exception", FromStatus: old, ToStatus: "exception",
			ActorID: &user.ID, Reason: reason, CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: row.ProjectID, Field: "expense",
			New:  fmt.Sprintf("「%s」特批放行：%s", row.Subject, reason),
			ByID: &user.ID, At: now,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "exception_expense", "expenses", strconv.FormatUint(uint64(row.ID), 10), reason, c.ClientIP()); err != nil {
			return err
		}
		if row.ByID != nil {
			title := fmt.Sprintf("支出特批放行：%s %s", row.Subject, strconv.FormatFloat(row.Amount, 'f', 2, 64))
			dedupKey := fmt.Sprintf("expense-decided:%d:exception:%d", row.ID, row.ResubmitCount)
			_, _ = notify.Push(tx, *row.ByID, "approval", title, reason, "in_app", "expense", &row.ID, &projectID, dedupKey)
		}
		result = row
		return nil
	})
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"detail": "支出不存在"})
		} else if err.Error() == "expense_decision_state" {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "仅待审批或已驳回的支出可特批"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "特批放行失败"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"kind": "expense", "id": result.ID, "status": result.Status, "decision_reason": reason})
}
