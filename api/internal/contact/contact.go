package contact

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	api := r.Group("/contacts", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ModuleContacts))
	api.GET("", h.listContacts)
	api.GET("/options", h.contactOptions)
	api.POST("", h.createContact)
	api.GET("/:cid/attachments/:aid/download", h.downloadAttachment)
	api.GET("/:cid/attachments", h.listAttachments)
	api.POST("/:cid/attachments", h.uploadAttachment)
	api.DELETE("/:cid/attachments/:aid", h.deleteAttachment)
	api.GET("/:cid", h.getContact)
	api.PATCH("/:cid", h.updateContact)
}

type contactResponse struct {
	ID                uint              `json:"id"`
	UserID            *uint             `json:"user_id"`
	Username          string            `json:"username"`
	RealName          string            `json:"real_name"`
	Name              string            `json:"name"`
	Mobile            string            `json:"mobile"`
	DeptID            *uint             `json:"dept_id"`
	DeptName          string            `json:"dept_name"`
	AccountStatus     string            `json:"account_status"`
	HasAccount        bool              `json:"has_account"`
	EmployeeNo        string            `json:"employee_no"`
	Position          string            `json:"position"`
	ManagerID         *uint             `json:"manager_id"`
	ManagerName       string            `json:"manager_name"`
	EmploymentType    string            `json:"employment_type"`
	EmploymentStatus  string            `json:"employment_status"`
	HireDate          *timeutil.Date    `json:"hire_date"`
	RegularDate       *timeutil.Date    `json:"regular_date"`
	LeaveDate         *timeutil.Date    `json:"leave_date"`
	WorkEmail         string            `json:"work_email"`
	OfficePhone       string            `json:"office_phone"`
	WorkLocation      string            `json:"work_location"`
	ContractType      string            `json:"contract_type"`
	ContractStart     *timeutil.Date    `json:"contract_start"`
	ContractEnd       *timeutil.Date    `json:"contract_end"`
	Gender            string            `json:"gender"`
	BirthDate         *timeutil.Date    `json:"birth_date"`
	IDCardNo          string            `json:"id_card_no"`
	IDCardMasked      string            `json:"id_card_masked"`
	NativePlace       string            `json:"native_place"`
	PoliticalStatus   string            `json:"political_status"`
	MaritalStatus     string            `json:"marital_status"`
	Address           string            `json:"address"`
	HighestEducation  string            `json:"highest_education"`
	School            string            `json:"school"`
	Major             string            `json:"major"`
	GraduationDate    *timeutil.Date    `json:"graduation_date"`
	Degree            string            `json:"degree"`
	EmergencyContact  string            `json:"emergency_contact"`
	EmergencyRelation string            `json:"emergency_relation"`
	EmergencyPhone    string            `json:"emergency_phone"`
	Remark            string            `json:"remark"`
	HasProfile        bool              `json:"has_profile"`
	AttachmentCount   int64             `json:"attachment_count"`
	UpdatedAt         timeutil.DateTime `json:"updated_at"`
}

type contactOption struct {
	ID       uint   `json:"id"`
	Name     string `json:"name"`
	DeptID   *uint  `json:"dept_id"`
	Position string `json:"position"`
}

var contactSorts = map[string]string{
	"id":                "contact_profiles.id",
	"name":              "contact_profiles.name",
	"mobile":            "contact_profiles.mobile",
	"dept_id":           "contact_profiles.dept_id",
	"employee_no":       "contact_profiles.employee_no",
	"position":          "contact_profiles.position",
	"employment_status": "contact_profiles.employment_status",
	"employment_type":   "contact_profiles.employment_type",
	"hire_date":         "contact_profiles.hire_date",
	"updated_at":        "contact_profiles.updated_at",
}

func (h *Handler) listContacts(c *gin.Context) {
	if status := strings.TrimSpace(c.Query("employment_status")); status != "" && !isEmploymentStatus(status) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "任职状态仅支持 active/probation/leave"})
		return
	}
	page, ok := queryInt(c, "page", 1)
	if !ok {
		return
	}
	size, ok := queryInt(c, "size", paging.DefaultPageSize)
	if !ok {
		return
	}
	deptID, ok := queryInt(c, "dept_id", 0)
	if !ok || deptID < 0 {
		if ok {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "dept_id 须为非负整数"})
		}
		return
	}

	query := h.DB.Model(&model.ContactProfile{}).
		Joins("LEFT JOIN users ON users.id = contact_profiles.user_id").
		Preload("User").
		Preload("Department").
		Preload("Manager")

	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		like := "%" + keyword + "%"
		query = query.Where(
			"(contact_profiles.name ILIKE ? OR contact_profiles.mobile ILIKE ? OR users.username ILIKE ? OR contact_profiles.employee_no ILIKE ? OR contact_profiles.position ILIKE ? OR contact_profiles.work_email ILIKE ?)",
			like, like, like, like, like, like,
		)
	}
	if deptID > 0 {
		query = query.Where("contact_profiles.dept_id = ?", deptID)
	}
	if status := strings.TrimSpace(c.Query("employment_status")); status != "" {
		query = query.Where("contact_profiles.employment_status = ?", status)
	}

	env, err := paging.Paginate[model.ContactProfile](
		query,
		page,
		size,
		c.Query("sort"),
		contactSorts,
		"id",
	)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	ids := make([]uint, 0, len(env.Items))
	for _, item := range env.Items {
		ids = append(ids, item.ID)
	}
	counts, err := attachmentCounts(h.DB, ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件数量失败"})
		return
	}

	items := make([]contactResponse, 0, len(env.Items))
	for i := range env.Items {
		items = append(items, serializeContact(env.Items[i], false, counts[env.Items[i].ID]))
	}
	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": items,
	})
}

func (h *Handler) contactOptions(c *gin.Context) {
	limit, ok := queryInt(c, "limit", 500)
	if !ok {
		return
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}

	query := h.DB.Model(&model.ContactProfile{}).Order("id ASC")
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		query = query.Where("name ILIKE ?", "%"+keyword+"%")
	}
	var rows []model.ContactProfile
	if err := query.Limit(limit).Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询直属上级选项失败"})
		return
	}

	options := make([]contactOption, 0, len(rows))
	for _, row := range rows {
		options = append(options, contactOption{
			ID:       row.ID,
			Name:     row.Name,
			DeptID:   row.DeptID,
			Position: row.Position,
		})
	}
	c.JSON(http.StatusOK, options)
}

func (h *Handler) getContact(c *gin.Context) {
	id, ok := parsePathID(c, "cid")
	if !ok {
		return
	}
	profile, err := loadContact(h.DB, id)
	if err != nil {
		writeContactError(c, err, "通讯录人员不存在")
		return
	}
	count, err := attachmentCount(h.DB, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件数量失败"})
		return
	}
	c.JSON(http.StatusOK, serializeContact(profile, true, count))
}

func loadContact(db *gorm.DB, id uint) (model.ContactProfile, error) {
	var profile model.ContactProfile
	err := db.Preload("User").Preload("Department").Preload("Manager").First(&profile, "id = ?", id).Error
	return profile, err
}

func serializeContact(profile model.ContactProfile, sensitive bool, attachmentCount int64) contactResponse {
	name := strings.TrimSpace(profile.Name)
	username, accountStatus, hasAccount := "", "none", false
	if profile.User != nil {
		username = profile.User.Username
		accountStatus = profile.User.Status
		hasAccount = true
		if name == "" {
			name = strings.TrimSpace(profile.User.RealName)
		}
		if name == "" {
			name = username
		}
	}
	idCard := profile.IDCardNo
	displayIDCard := maskIDCard(idCard)
	if sensitive {
		displayIDCard = idCard
	}
	mobile := profile.Mobile
	if mobile == "" && profile.User != nil {
		mobile = profile.User.Username
	}
	deptName, managerName := "", ""
	if profile.Department != nil {
		deptName = profile.Department.Name
	}
	if profile.Manager != nil {
		managerName = profile.Manager.Name
	}

	return contactResponse{
		ID:                profile.ID,
		UserID:            profile.UserID,
		Username:          username,
		RealName:          name,
		Name:              name,
		Mobile:            mobile,
		DeptID:            profile.DeptID,
		DeptName:          deptName,
		AccountStatus:     accountStatus,
		HasAccount:        hasAccount,
		EmployeeNo:        stringPointerValue(profile.EmployeeNo),
		Position:          profile.Position,
		ManagerID:         profile.ManagerID,
		ManagerName:       managerName,
		EmploymentType:    defaultString(profile.EmploymentType, "正式"),
		EmploymentStatus:  defaultString(profile.EmploymentStatus, "active"),
		HireDate:          profile.HireDate,
		RegularDate:       profile.RegularDate,
		LeaveDate:         profile.LeaveDate,
		WorkEmail:         profile.WorkEmail,
		OfficePhone:       profile.OfficePhone,
		WorkLocation:      profile.WorkLocation,
		ContractType:      profile.ContractType,
		ContractStart:     profile.ContractStart,
		ContractEnd:       profile.ContractEnd,
		Gender:            profile.Gender,
		BirthDate:         profile.BirthDate,
		IDCardNo:          displayIDCard,
		IDCardMasked:      maskIDCard(idCard),
		NativePlace:       profile.NativePlace,
		PoliticalStatus:   profile.PoliticalStatus,
		MaritalStatus:     profile.MaritalStatus,
		Address:           profile.Address,
		HighestEducation:  profile.HighestEducation,
		School:            profile.School,
		Major:             profile.Major,
		GraduationDate:    profile.GraduationDate,
		Degree:            profile.Degree,
		EmergencyContact:  profile.EmergencyContact,
		EmergencyRelation: profile.EmergencyRelation,
		EmergencyPhone:    profile.EmergencyPhone,
		Remark:            profile.Remark,
		HasProfile:        true,
		AttachmentCount:   attachmentCount,
		UpdatedAt:         profile.UpdatedAt,
	}
}

func attachmentCount(db *gorm.DB, contactID uint) (int64, error) {
	var count int64
	err := db.Model(&model.Attachment{}).
		Where("project_id IS NULL AND ref_type = ? AND ref_id = ?", "contact", contactID).
		Count(&count).Error
	return count, err
}

func attachmentCounts(db *gorm.DB, contactIDs []uint) (map[uint]int64, error) {
	counts := make(map[uint]int64, len(contactIDs))
	if len(contactIDs) == 0 {
		return counts, nil
	}
	var rows []struct {
		RefID uint
		Count int64
	}
	err := db.Model(&model.Attachment{}).
		Select("ref_id, COUNT(*) AS count").
		Where("project_id IS NULL AND ref_type = ? AND ref_id IN ?", "contact", contactIDs).
		Group("ref_id").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		counts[row.RefID] = row.Count
	}
	return counts, nil
}

func queryInt(c *gin.Context, key string, fallback int) (int, bool) {
	raw, exists := c.GetQuery(key)
	if !exists {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": fmt.Sprintf("%s 须为整数", key)})
		return 0, false
	}
	return value, true
}

func parsePathID(c *gin.Context, key string) (uint, bool) {
	value, err := strconv.ParseUint(c.Param(key), 10, 64)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "无效的资源 ID"})
		return 0, false
	}
	return uint(value), true
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func writeContactError(c *gin.Context, err error, notFound string) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": notFound})
		return
	}
	var inputErr contactInputError
	if errors.As(err, &inputErr) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": inputErr.Error()})
		return
	}
	if isUniqueViolation(err) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "工号或关联账号已存在"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": "通讯录操作失败"})
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") ||
		strings.Contains(message, "duplicate key") ||
		strings.Contains(message, "violates unique")
}
