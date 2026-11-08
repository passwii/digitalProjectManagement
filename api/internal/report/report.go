package report

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/excel"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
)

const costReportNote = "成本为项目管理口径，与财务账存在差异"

type costProject struct {
	ID     uint
	Code   string
	Name   string
	DeptID uint
}

type costAmount struct {
	ProjectID   uint
	ProjectCode string
	ProjectName string
	DeptID      uint
	Subject     string
	Amount      float64
}

type costRow struct {
	ProjectID   uint    `json:"project_id"`
	ProjectCode string  `json:"project_code"`
	ProjectName string  `json:"project_name"`
	DeptID      *uint   `json:"dept_id"`
	Subject     string  `json:"subject"`
	Budget      float64 `json:"budget"`
	Spent       float64 `json:"spent"`
	Balance     float64 `json:"balance"`
	Rate        float64 `json:"rate"`
	Note        string  `json:"note"`
}

func aggregateCosts(projects []costProject, budgets, expenses []costAmount, month string) []costRow {
	_ = month
	type key struct {
		projectID uint
		subject   string
	}
	budgetMap, spentMap := map[key]float64{}, map[key]float64{}
	for _, row := range budgets {
		budgetMap[key{row.ProjectID, row.Subject}] += row.Amount
	}
	for _, row := range expenses {
		spentMap[key{row.ProjectID, row.Subject}] += row.Amount
	}
	rows := make([]costRow, 0)
	for _, project := range projects {
		subjectSet := map[string]bool{}
		for item := range budgetMap {
			if item.projectID == project.ID {
				subjectSet[item.subject] = true
			}
		}
		for item := range spentMap {
			if item.projectID == project.ID {
				subjectSet[item.subject] = true
			}
		}
		if len(subjectSet) == 0 {
			subjectSet[""] = true
		}
		subjects := make([]string, 0, len(subjectSet))
		for subject := range subjectSet {
			subjects = append(subjects, subject)
		}
		sort.Strings(subjects)
		for _, subject := range subjects {
			budgetAmount := round2(budgetMap[key{project.ID, subject}])
			spentAmount := round2(spentMap[key{project.ID, subject}])
			rate := float64(0)
			if budgetAmount != 0 {
				rate = round4(spentAmount / budgetAmount)
			}
			var deptID *uint
			if project.DeptID > 0 {
				value := project.DeptID
				deptID = &value
			}
			rows = append(rows, costRow{
				ProjectID: project.ID, ProjectCode: project.Code, ProjectName: project.Name,
				DeptID: deptID, Subject: subject, Budget: budgetAmount, Spent: spentAmount,
				Balance: round2(budgetAmount - spentAmount), Rate: rate, Note: costReportNote,
			})
		}
	}
	return rows
}

func (h *Handler) visibleProjects(user *model.User) ([]costProject, error) {
	var rows []model.Project
	if err := h.DB.Select("id", "code", "name", "dept_id").
		Where("id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user)).Find(&rows).Error; err != nil {
		return nil, err
	}
	result := make([]costProject, 0, len(rows))
	for _, row := range rows {
		departmentID := uint(0)
		if row.DeptID != nil {
			departmentID = *row.DeptID
		}
		result = append(result, costProject{ID: row.ID, Code: row.Code, Name: row.Name, DeptID: departmentID})
	}
	return result, nil
}

func (h *Handler) buildCostRows(user *model.User, projectID, deptID uint, subject, month string) ([]costRow, error) {
	projects, err := h.visibleProjects(user)
	if err != nil {
		return nil, err
	}
	filtered := make([]costProject, 0, len(projects))
	allowedIDs := make([]uint, 0, len(projects))
	for _, project := range projects {
		if projectID > 0 && project.ID != projectID {
			continue
		}
		if deptID > 0 && project.DeptID != deptID {
			continue
		}
		filtered = append(filtered, project)
		allowedIDs = append(allowedIDs, project.ID)
	}
	if len(filtered) == 0 {
		return []costRow{}, nil
	}
	budgetQuery := h.DB.Model(&model.Budget{}).Select("project_id, subject, COALESCE(SUM(amount),0) AS amount").Where("project_id IN ?", allowedIDs)
	if subject != "" {
		budgetQuery = budgetQuery.Where("subject = ?", subject)
	}
	type groupedAmount struct {
		ProjectID uint    `gorm:"column:project_id"`
		Subject   string  `gorm:"column:subject"`
		Amount    float64 `gorm:"column:amount"`
	}
	var budgetGroups []groupedAmount
	if err := budgetQuery.Group("project_id, subject").Scan(&budgetGroups).Error; err != nil {
		return nil, err
	}
	budgets := make([]costAmount, 0, len(budgetGroups))
	for _, row := range budgetGroups {
		budgets = append(budgets, costAmount{ProjectID: row.ProjectID, Subject: row.Subject, Amount: row.Amount})
	}
	expenseQuery := h.DB.Model(&model.Expense{}).
		Select("project_id, subject, COALESCE(SUM(amount),0) AS amount").
		Where("project_id IN ? AND status IN ?", allowedIDs, []string{"approved", "exception"})
	if subject != "" {
		expenseQuery = expenseQuery.Where("subject = ?", subject)
	}
	if month != "" {
		monthStart, monthEnd, parseErr := monthRange(month)
		if parseErr != nil {
			return nil, parseErr
		}
		expenseQuery = expenseQuery.Where("exp_date >= ? AND exp_date < ?", monthStart, monthEnd)
	}
	var expenseGroups []groupedAmount
	if err := expenseQuery.Group("project_id, subject").Scan(&expenseGroups).Error; err != nil {
		return nil, err
	}
	expenses := make([]costAmount, 0, len(expenseGroups))
	for _, row := range expenseGroups {
		expenses = append(expenses, costAmount{ProjectID: row.ProjectID, Subject: row.Subject, Amount: row.Amount})
	}
	return aggregateCosts(filtered, budgets, expenses, month), nil
}

func (h *Handler) Cost(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectID, deptID, ok := reportFilters(c)
	if !ok {
		return
	}
	rows, err := h.buildCostRows(user, projectID, deptID, strings.TrimSpace(c.Query("subject")), strings.TrimSpace(c.Query("month")))
	if err != nil {
		if strings.Contains(err.Error(), "month") {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "month 格式须为 YYYY-MM"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成成本报表失败"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": rows, "note": costReportNote})
}

func (h *Handler) ExportCost(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectID, deptID, ok := reportFilters(c)
	if !ok {
		return
	}
	rows, err := h.buildCostRows(user, projectID, deptID, strings.TrimSpace(c.Query("subject")), strings.TrimSpace(c.Query("month")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "生成成本报表失败"})
		return
	}
	headers := []string{"项目编号", "项目名称", "部门ID", "科目", "预算", "已支出", "余额", "执行率"}
	values := make([][]string, 0, len(rows))
	for _, row := range rows {
		department := ""
		if row.DeptID != nil {
			department = strconv.FormatUint(uint64(*row.DeptID), 10)
		}
		values = append(values, []string{
			row.ProjectCode, row.ProjectName, department, row.Subject,
			fmt.Sprintf("%.2f", row.Budget), fmt.Sprintf("%.2f", row.Spent),
			fmt.Sprintf("%.2f", row.Balance), fmt.Sprintf("%.4f", row.Rate),
		})
	}
	data, err := excel.GenerateXLSX("成本报表", headers, values)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成成本报表文件失败"})
		return
	}
	c.Header("Content-Disposition", `attachment; filename="cost_report.xlsx"`)
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data)
}

func reportFilters(c *gin.Context) (uint, uint, bool) {
	projectID, ok := reportQueryID(c, "project_id")
	if !ok {
		return 0, 0, false
	}
	deptID, ok := reportQueryID(c, "dept_id")
	return projectID, deptID, ok
}

func reportQueryID(c *gin.Context, key string) (uint, bool) {
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

func monthRange(value string) (time.Time, time.Time, error) {
	parsed, err := time.ParseInLocation("2006-01", value, timeutil.Loc)
	if err != nil || parsed.Format("2006-01") != value {
		return time.Time{}, time.Time{}, fmt.Errorf("invalid month")
	}
	return parsed, parsed.AddDate(0, 1, 0), nil
}

func round2(value float64) float64 { return math.Round(value*100) / 100 }
func round4(value float64) float64 { return math.Round(value*10000) / 10000 }
