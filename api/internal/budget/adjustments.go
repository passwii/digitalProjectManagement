package budget

import (
	"errors"
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

var adjustmentSorts = map[string]string{
	"id": "budget_adjusts.id", "project_id": "budget_adjusts.project_id",
	"old_amount": "budget_adjusts.old_amount", "new_amount": "budget_adjusts.new_amount",
	"status": "budget_adjusts.status", "created_at": "budget_adjusts.created_at",
}

func (h *Handler) ListAdjustments(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectID, ok := budgetQueryID(c, "project_id")
	if !ok {
		return
	}
	q := h.DB.Model(&model.BudgetAdjust{})
	if projectID > 0 {
		if _, err := projectdomain.LoadVisibleProject(h.DB, user, projectID); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
			return
		}
		q = q.Where("project_id = ?", projectID)
	} else {
		q = q.Where("project_id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		q = q.Where("status = ?", status)
	}
	if budgetID, ok := budgetQueryID(c, "budget_id"); !ok {
		return
	} else if budgetID > 0 {
		q = q.Where("budget_id = ?", budgetID)
	}
	mine := c.Query("mine") == "1"
	if mine {
		q = q.Where("by_id = ?", user.ID)
	}
	page, size, ok := budgetPagination(c)
	if !ok {
		return
	}
	result, err := paging.Paginate[model.BudgetAdjust](q.Preload("User"), page, size, c.Query("sort"), adjustmentSorts, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	budgetIDs := make([]uint, 0, len(result.Items))
	for _, row := range result.Items {
		budgetIDs = append(budgetIDs, row.BudgetID)
	}
	subjects := map[uint]string{}
	if len(budgetIDs) > 0 {
		var budgets []model.Budget
		if err := h.DB.Select("id", "subject").Where("id IN ?", budgetIDs).Find(&budgets).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询预算科目失败"})
			return
		}
		for _, row := range budgets {
			subjects[row.ID] = row.Subject
		}
	}
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		items = append(items, adjustmentRow(row, subjects[row.BudgetID]))
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

func adjustmentRow(row model.BudgetAdjust, subject string) gin.H {
	return gin.H{
		"id": row.ID, "budget_id": row.BudgetID, "project_id": row.ProjectID,
		"subject": subject, "old_amount": row.OldAmount, "new_amount": row.NewAmount,
		"reason": row.Reason, "status": row.Status, "by_id": row.ByID,
		"approved_by": row.ApprovedBy, "decision_reason": row.DecisionReason,
		"decided_at": row.DecidedAt, "can_approve_adjust": row.Status == "pending",
		"created_at": row.CreatedAt,
	}
}

func (h *Handler) AdjustmentTimeline(c *gin.Context) {
	id, ok := budgetPathID(c, "aid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	var row model.BudgetAdjust
	if err := h.DB.First(&row, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "预算调整记录不存在"})
		return
	}
	if _, err := projectdomain.LoadVisibleProject(h.DB, user, row.ProjectID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "预算调整记录不存在"})
		return
	}
	var items []model.ApprovalRecord
	if err := h.DB.Preload("Actor").Where("kind = ? AND ref_id = ?", "budget_adjust", id).Order("id ASC").Find(&items).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询审批时间线失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID, "status": row.Status, "decision_reason": row.DecisionReason, "items": items})
}

func (h *Handler) DecideAdjustment(c *gin.Context) {
	id, ok := budgetPathID(c, "aid")
	if !ok {
		return
	}
	var req struct {
		Approve *bool  `json:"approve"`
		Reason  string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}
	approve := true
	if req.Approve != nil {
		approve = *req.Approve
	}
	reason := strings.TrimSpace(req.Reason)
	if !approve && reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "驳回必须填写意见"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var adjust model.BudgetAdjust
		if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&adjust, id).Error; err != nil {
			return err
		}
		if adjust.Status != "pending" {
			return errAdjustmentHandled
		}
		if _, err := projectdomain.LoadVisibleProject(tx, user, adjust.ProjectID); err != nil {
			return err
		}
		var budgetRow model.Budget
		if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).First(&budgetRow, adjust.BudgetID).Error; err != nil {
			return err
		}
		oldStatus := adjust.Status
		adjust.Status = "rejected"
		action := "reject"
		if approve {
			adjust.Status = "approved"
			budgetRow.Amount = adjust.NewAmount
			budgetRow.UpdatedAt = timeutil.NowDateTime()
			if err := tx.Save(&budgetRow).Error; err != nil {
				return err
			}
			action = "approve"
		}
		now := timeutil.NowDateTime()
		adjust.ApprovedBy = &user.ID
		adjust.DecisionReason = reason
		adjust.DecidedAt = &now
		if err := tx.Save(&adjust).Error; err != nil {
			return err
		}
		projectID := adjust.ProjectID
		if err := tx.Create(&model.ApprovalRecord{
			Kind: "budget_adjust", RefID: adjust.ID, ProjectID: &projectID,
			Action: action, FromStatus: oldStatus, ToStatus: adjust.Status,
			ActorID: &user.ID, Reason: reason, CreatedAt: now,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "decide_budget_adjust", "budget_adjusts", strconv.FormatUint(uint64(adjust.ID), 10), adjust.Status+" "+reason, c.ClientIP()); err != nil {
			return err
		}
		response = adjustmentRow(adjust, budgetRow.Subject)
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			c.JSON(http.StatusNotFound, gin.H{"detail": "预算调整记录不存在"})
		case errAdjustmentHandled:
			c.JSON(http.StatusConflict, gin.H{"detail": "预算调整已处理"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "审批预算调整失败"})
		}
		return
	}
	c.JSON(http.StatusOK, response)
}

var errAdjustmentHandled = errors.New("budget adjustment already handled")
