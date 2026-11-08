package project

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) SetMembers(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	var request struct {
		UserIDs []uint `json:"user_ids"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || request.UserIDs == nil {
		writeError(c, http.StatusBadRequest, "user_ids 须为数组")
		return
	}
	user := rbac.GetCurrentUser(c)
	var response model.Project
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		row, err := loadWritableProject(tx, user, projectID)
		if err != nil {
			return err
		}
		wanted := map[uint]bool{}
		for _, id := range request.UserIDs {
			if id == 0 {
				continue
			}
			wanted[id] = true
		}
		if row.OwnerID != nil {
			wanted[*row.OwnerID] = true
		}
		for id := range wanted {
			var member model.User
			if err := tx.First(&member, id).Error; err != nil {
				return errInvalidMember
			}
		}
		var current []model.ProjectMember
		if err := tx.Where("project_id = ?", projectID).Find(&current).Error; err != nil {
			return err
		}
		oldIDs := make([]uint, 0, len(current))
		for _, member := range current {
			oldIDs = append(oldIDs, member.UserID)
		}
		sort.Slice(oldIDs, func(i, j int) bool { return oldIDs[i] < oldIDs[j] })
		if err := tx.Where("project_id = ?", projectID).Delete(&model.ProjectMember{}).Error; err != nil {
			return err
		}
		newIDs := make([]uint, 0, len(wanted))
		for id := range wanted {
			newIDs = append(newIDs, id)
		}
		sort.Slice(newIDs, func(i, j int) bool { return newIDs[i] < newIDs[j] })
		for _, id := range newIDs {
			if err := tx.Create(&model.ProjectMember{ProjectID: projectID, UserID: id}).Error; err != nil {
				return err
			}
		}
		now := timeutil.NowDateTime()
		if err := projectChange(tx, projectID, "members", joinIDs(oldIDs), joinIDs(newIDs), user.ID, now); err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "set_members", "projects", strconv.FormatUint(uint64(projectID), 10), joinIDs(oldIDs)+"->"+joinIDs(newIDs), c.ClientIP()); err != nil {
			return err
		}
		response = row
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			writeError(c, http.StatusNotFound, "项目不存在")
		case errProjectArchived:
			writeError(c, http.StatusBadRequest, "已归档项目只读")
		case errInvalidMember:
			writeError(c, http.StatusBadRequest, "项目成员不存在")
		default:
			writeError(c, http.StatusInternalServerError, "更新项目成员失败")
		}
		return
	}
	var members []model.ProjectMember
	if err := h.DB.Preload("User").Where("project_id = ?", projectID).Find(&members).Error; err == nil {
		response.Members = members
	}
	c.JSON(http.StatusOK, response)
}

func joinIDs(ids []uint) string {
	values := make([]string, 0, len(ids))
	for _, id := range ids {
		values = append(values, strconv.FormatUint(uint64(id), 10))
	}
	return strings.Join(values, ",")
}
