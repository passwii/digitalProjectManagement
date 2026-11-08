package task

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/excel"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var taskImportHeaders = []string{"层级", "名称", "负责人账号", "计划开始", "计划结束", "权重"}

func (h *Handler) Import(c *gin.Context) {
	projectID, ok := parseQueryID(c, "project_id")
	if !ok || projectID == 0 {
		if ok {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "project_id 必填"})
		}
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := loadTaskProject(h.DB, user, projectID, true)
	if err != nil {
		taskError(c, err)
		return
	}
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请上传 Excel 或 CSV 文件"})
		return
	}
	defer file.Close()
	if header.Size > 20<<20 {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"detail": "导入文件不能超过 20 MiB"})
		return
	}
	rows, err := excel.ReadRows(header.Filename, file)
	if err != nil || len(rows) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "Excel 解析失败或文件为空"})
		return
	}
	headerRow := paddedRow(rows[0], len(taskImportHeaders))
	for index, expected := range taskImportHeaders {
		if strings.TrimSpace(headerRow[index]) != expected {
			c.JSON(http.StatusBadRequest, gin.H{"created": 0, "errors": []string{fmt.Sprintf("第1行：表头须为 %v，实际为 %v", taskImportHeaders, headerRow)}})
			return
		}
	}

	created := 0
	rowErrors := make([]string, 0)
	parents := make(map[int]uint)
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		for index, raw := range rows[1:] {
			line := index + 2
			values := paddedRow(raw, len(taskImportHeaders))
			if strings.TrimSpace(strings.Join(values, "")) == "" {
				continue
			}
			level, parseErr := strconv.Atoi(strings.TrimSpace(values[0]))
			if parseErr != nil {
				level = 1
			}
			name := strings.TrimSpace(values[1])
			weight := 1.0
			if strings.TrimSpace(values[5]) != "" {
				if _, parseErr := fmt.Sscan(values[5], &weight); parseErr != nil {
					rowErrors = append(rowErrors, fmt.Sprintf("第%d行：权重须为数字", line))
					continue
				}
			}
			start, startErr := parseImportDate(values[3])
			end, endErr := parseImportDate(values[4])
			if name == "" || len([]rune(name)) > 128 || level < 1 || level > maxTaskLevel ||
				weight <= 0 || startErr != nil || endErr != nil {
				rowErrors = append(rowErrors, fmt.Sprintf("第%d行：任务名称、层级、日期或权重无效", line))
				continue
			}
			if err := checkTaskDates(start, end, projectRow); err != nil {
				rowErrors = append(rowErrors, fmt.Sprintf("第%d行：计划日期超出项目计划期", line))
				continue
			}
			var parentID *uint
			if level > 1 {
				parent, exists := parents[level-1]
				if !exists {
					rowErrors = append(rowErrors, fmt.Sprintf("第%d行：第%d 级任务缺少上一层父任务", line, level))
					continue
				}
				parentID = &parent
			}
			ownerID := user.ID
			if strings.TrimSpace(values[2]) != "" {
				var owner model.User
				if err := tx.Where("username = ?", strings.TrimSpace(values[2])).First(&owner).Error; err != nil {
					rowErrors = append(rowErrors, fmt.Sprintf("第%d行：负责人账号不存在", line))
					continue
				}
				ownerID = owner.ID
			}
			now := timeutil.NowDateTime()
			task := model.Task{
				ProjectID: projectID, ParentID: parentID, Level: level,
				Name: name, OwnerID: &ownerID, PlanStart: start, PlanEnd: end,
				Weight: weight, Status: "todo", CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(&task).Error; err != nil {
				return err
			}
			parents[level] = task.ID
			for childLevel := range parents {
				if childLevel > level {
					delete(parents, childLevel)
				}
			}
			created++
		}
		return audit.CommitAudited(tx, &user.ID, "import_tasks", "tasks", strconv.FormatUint(uint64(projectID), 10), fmt.Sprintf("created=%d", created), c.ClientIP())
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "导入任务失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"created": created, "errors": rowErrors})
}

func paddedRow(row []string, size int) []string {
	values := make([]string, size)
	copy(values, row)
	return values
}

func parseImportDate(raw string) (*timeutil.Date, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	for _, layout := range []string{"2006-01-02", "2006/01/02", time.RFC3339, "2006-01-02 15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, raw, timeutil.Loc); err == nil {
			value := timeutil.NewDate(parsed)
			return &value, nil
		}
	}
	return nil, fmt.Errorf("invalid date")
}
