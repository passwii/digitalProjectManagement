package expense

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
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) Timeline(c *gin.Context) {
	id, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	row, _, err := loadExpense(h.DB, id, rbac.GetCurrentUser(c), false)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "支出不存在"})
		return
	}
	var items []model.ApprovalRecord
	if err := h.DB.Preload("Actor").Where("kind = ? AND ref_id = ?", "expense", id).Order("id ASC").Find(&items).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询支出时间线失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID, "status": row.Status, "decision_reason": row.DecisionReason, "decided_at": row.DecidedAt, "items": items})
}

func (h *Handler) Resubmit(c *gin.Context) {
	id, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil || body == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求体须为 JSON 对象"})
		return
	}
	allowed := map[string]bool{"subject": true, "amount": true, "exp_date": true, "note": true, "reason": true}
	for key := range body {
		if !allowed[key] {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "不支持的字段：" + key})
			return
		}
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Expense
		if err := tx.Clauses(expenseUpdateLock).First(&row, id).Error; err != nil {
			return err
		}
		projectRow, err := loadExpenseProject(tx, user, row.ProjectID, true)
		if err != nil {
			return err
		}
		if row.Status != "rejected" {
			return errExpenseRejectedOnly
		}
		if row.ByID == nil || *row.ByID != user.ID {
			return errExpenseApplicantOnly
		}
		if projectRow.Status == "archived" {
			return errExpenseProjectArchived
		}
		subject := row.Subject
		if raw := body["subject"]; len(raw) > 0 && json.Unmarshal(raw, &subject) != nil {
			return errExpenseInvalid
		}
		subject = strings.TrimSpace(subject)
		if len([]rune(subject)) > 32 {
			return errExpenseInvalid
		}
		amount := row.Amount
		if raw := body["amount"]; len(raw) > 0 {
			if json.Unmarshal(raw, &amount) != nil || amount <= 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
				return errExpenseInvalid
			}
		}
		expDate := row.ExpDate
		if raw, exists := body["exp_date"]; exists {
			expDate, err = parseExpenseDate(raw)
			if err != nil {
				return errExpenseInvalid
			}
		}
		if expDate != nil && projectRow.PlanStart != nil && expDate.Before(projectRow.PlanStart.Time) {
			return errExpenseInvalid
		}
		if raw := body["note"]; len(raw) > 0 {
			if json.Unmarshal(raw, &row.Note) != nil {
				return errExpenseInvalid
			}
		}
		budgetAmount, err := subjectBudget(tx, row.ProjectID, subject)
		if err != nil {
			return err
		}
		spent, err := subjectSpent(tx, row.ProjectID, subject)
		if err != nil {
			return err
		}
		over := budgetAmount > 0 && spent+amount > budgetAmount
		status := initialExpenseStatus(approvalEnabled(tx, "expense_approval_on"), over)
		oldStatus := row.Status
		row.Subject, row.Amount, row.ExpDate = subject, amount, expDate
		row.Status = status
		row.ResubmitCount++
		row.ApprovedBy = nil
		row.DecidedAt = nil
		row.DecisionReason = ""
		now := timeutil.NowDateTime()
		if status == "approved" {
			row.DecidedAt = &now
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		reason := ""
		if raw := body["reason"]; len(raw) > 0 {
			_ = json.Unmarshal(raw, &reason)
		}
		if err := addExpenseTimeline(tx, row, "resubmit", oldStatus, status, user.ID, strings.TrimSpace(reason), now); err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: row.ProjectID, Field: "expense",
			New:  "「" + row.Subject + "」重新提交 " + strconv.FormatFloat(row.Amount, 'f', 2, 64) + " 元",
			ByID: &user.ID, At: now,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "resubmit_expense", "expenses", strconv.FormatUint(uint64(row.ID), 10), oldStatus+"->"+status, c.ClientIP()); err != nil {
			return err
		}
		response = expenseRow(row)
		response["execution"] = executionSnapshot(budgetAmount, spent+amount)
		return nil
	})
	if err != nil {
		expenseError(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func (h *Handler) Approve(c *gin.Context) {
	h.decide(c, "approve", "")
}

func (h *Handler) Reject(c *gin.Context) {
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "驳回必须填写意见"})
		return
	}
	h.decide(c, "reject", strings.TrimSpace(req.Reason))
}

func (h *Handler) Exception(c *gin.Context) {
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Reason) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "特批必须填写理由"})
		return
	}
	h.decide(c, "exception", strings.TrimSpace(req.Reason))
}

func (h *Handler) decide(c *gin.Context, decision, reason string) {
	id, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.Expense
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Expense
		if err := tx.Clauses(expenseUpdateLock).First(&row, id).Error; err != nil {
			return err
		}
		projectRow, err := loadExpenseProject(tx, user, row.ProjectID, false)
		if err != nil {
			return err
		}
		old := row.Status
		to := "approved"
		action := "approve"
		switch decision {
		case "approve":
			if row.Status != "pending" {
				return errExpenseNotPending
			}
			budgetAmount, err := subjectBudget(tx, row.ProjectID, row.Subject)
			if err != nil {
				return err
			}
			spent, err := subjectSpent(tx, row.ProjectID, row.Subject)
			if err != nil {
				return err
			}
			if budgetAmount > 0 && spent+row.Amount > budgetAmount {
				return errExpenseOverBudget
			}
		case "reject":
			if row.Status != "pending" {
				return errExpenseNotPending
			}
			if reason == "" {
				return errExpenseReasonRequired
			}
			to, action = "rejected", "reject"
		case "exception":
			if row.Status != "pending" && row.Status != "rejected" {
				return errExpenseDecisionState
			}
			if reason == "" {
				return errExpenseReasonRequired
			}
			to, action = "exception", "exception"
		}
		if projectRow.Status == "archived" {
			return errExpenseProjectArchived
		}
		now := timeutil.NowDateTime()
		row.Status = to
		row.ApprovedBy = &user.ID
		row.DecisionReason = reason
		row.DecidedAt = &now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := addExpenseTimeline(tx, row, action, old, to, user.ID, reason, now); err != nil {
			return err
		}
		decisionText := "「" + row.Subject + "」审批通过"
		if to == "rejected" {
			decisionText = "「" + row.Subject + "」被驳回：" + reason
		} else if to == "exception" {
			decisionText = "「" + row.Subject + "」特批放行：" + reason
		}
		if err := tx.Create(&model.ProjectChange{ProjectID: row.ProjectID, Field: "expense", New: decisionText, ByID: &user.ID, At: now}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, action+"_expense", "expenses", strconv.FormatUint(uint64(row.ID), 10), old+"->"+to+" "+reason, c.ClientIP()); err != nil {
			return err
		}
		result = row
		return nil
	})
	if err != nil {
		expenseError(c, err)
		return
	}
	c.JSON(http.StatusOK, expenseRow(result))
}

func loadExpenseProject(db *gorm.DB, user *model.User, projectID uint, write bool) (model.Project, error) {
	row, err := projectdomain.LoadVisibleProject(db, user, projectID)
	if err != nil {
		return row, err
	}
	if write && row.Status == "archived" {
		return row, errExpenseProjectArchived
	}
	return row, nil
}

func addExpenseTimeline(tx *gorm.DB, row model.Expense, action, from, to string, actorID uint, reason string, now timeutil.DateTime) error {
	projectID := row.ProjectID
	return tx.Create(&model.ApprovalRecord{
		Kind: "expense", RefID: row.ID, ProjectID: &projectID,
		Action: action, FromStatus: from, ToStatus: to,
		ActorID: &actorID, Reason: reason, CreatedAt: now,
	}).Error
}

func parseExpenseDate(raw []byte) (*timeutil.Date, error) {
	if string(raw) == "null" || len(raw) == 0 {
		return nil, nil
	}
	var value timeutil.Date
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, err
	}
	return &value, nil
}

func expenseError(c *gin.Context, err error) {
	switch err {
	case gorm.ErrRecordNotFound:
		c.JSON(http.StatusNotFound, gin.H{"detail": "支出不存在"})
	case errExpenseProjectArchived:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
	case errExpenseRejectedOnly:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "仅已驳回的支出可重新提交"})
	case errExpenseApplicantOnly:
		c.JSON(http.StatusForbidden, gin.H{"detail": "仅申请人本人可重新提交"})
	case errExpenseNotPending:
		c.JSON(http.StatusConflict, gin.H{"detail": "支出不在待审批状态"})
	case errExpenseOverBudget:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "超预算：通过前请先调预算或走特批"})
	case errExpenseReasonRequired:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "必须填写审批意见"})
	case errExpenseDecisionState:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "仅待审批或已驳回的支出可特批"})
	case errExpenseInvalid:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "支出字段无效"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "支出操作失败"})
	}
}

var errExpenseInvalid = errors.New("invalid expense input")

var _ = audit.WriteAudit
