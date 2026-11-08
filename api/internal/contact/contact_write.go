package contact

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type contactInputError string

func (e contactInputError) Error() string { return string(e) }

type field[T any] struct {
	Value T
	Set   bool
}

func (f *field[T]) UnmarshalJSON(data []byte) error {
	f.Set = true
	return json.Unmarshal(data, &f.Value)
}

type contactInput struct {
	Name              field[string]         `json:"name"`
	Mobile            field[string]         `json:"mobile"`
	DeptID            field[*uint]          `json:"dept_id"`
	UserID            field[*uint]          `json:"user_id"`
	EmployeeNo        field[string]         `json:"employee_no"`
	Position          field[string]         `json:"position"`
	ManagerID         field[*uint]          `json:"manager_id"`
	EmploymentType    field[string]         `json:"employment_type"`
	EmploymentStatus  field[string]         `json:"employment_status"`
	HireDate          field[*timeutil.Date] `json:"hire_date"`
	RegularDate       field[*timeutil.Date] `json:"regular_date"`
	LeaveDate         field[*timeutil.Date] `json:"leave_date"`
	WorkEmail         field[string]         `json:"work_email"`
	OfficePhone       field[string]         `json:"office_phone"`
	WorkLocation      field[string]         `json:"work_location"`
	ContractType      field[string]         `json:"contract_type"`
	ContractStart     field[*timeutil.Date] `json:"contract_start"`
	ContractEnd       field[*timeutil.Date] `json:"contract_end"`
	Gender            field[string]         `json:"gender"`
	BirthDate         field[*timeutil.Date] `json:"birth_date"`
	IDCardNo          field[string]         `json:"id_card_no"`
	NativePlace       field[string]         `json:"native_place"`
	PoliticalStatus   field[string]         `json:"political_status"`
	MaritalStatus     field[string]         `json:"marital_status"`
	Address           field[string]         `json:"address"`
	HighestEducation  field[string]         `json:"highest_education"`
	School            field[string]         `json:"school"`
	Major             field[string]         `json:"major"`
	GraduationDate    field[*timeutil.Date] `json:"graduation_date"`
	Degree            field[string]         `json:"degree"`
	EmergencyContact  field[string]         `json:"emergency_contact"`
	EmergencyRelation field[string]         `json:"emergency_relation"`
	EmergencyPhone    field[string]         `json:"emergency_phone"`
	Remark            field[string]         `json:"remark"`
}

var (
	idCardPattern = regexp.MustCompile(`^(?:\d{15}|\d{17}[\dXx])$`)
	emailPattern  = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

var (
	employmentTypes = map[string]bool{
		"正式": true, "试用": true, "实习": true, "劳务": true, "兼职": true, "返聘": true,
	}
	employmentStatuses = map[string]bool{
		"active": true, "probation": true, "leave": true,
	}
	contractTypes = map[string]bool{
		"劳动合同": true, "劳务合同": true, "实习协议": true, "顾问协议": true, "其他": true,
	}
	genders = map[string]bool{"男": true, "女": true, "未填写": true}
)

type textUpdate struct {
	name  string
	value field[string]
	limit int
	dst   *string
}

func (h *Handler) createContact(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	var input contactInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	profile := model.ContactProfile{
		EmploymentType:   "正式",
		EmploymentStatus: "active",
		CreatedAt:        timeutil.NowDateTime(),
		UpdatedAt:        timeutil.NowDateTime(),
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := applyContactInput(tx, &profile, input, user.ID); err != nil {
			return err
		}
		if err := tx.Create(&profile).Error; err != nil {
			return err
		}
		if err := syncLinkedUser(tx, &profile); err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"create_contact",
			"contact_profiles",
			strconv.FormatUint(uint64(profile.ID), 10),
			profile.Name,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeContactError(c, err, "通讯录人员不存在")
		return
	}
	h.returnContact(c, profile.ID)
}

func (h *Handler) updateContact(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	id, ok := parsePathID(c, "cid")
	if !ok {
		return
	}
	var input contactInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var profile model.ContactProfile
		if err := tx.First(&profile, "id = ?", id).Error; err != nil {
			return err
		}
		if err := applyContactInput(tx, &profile, input, user.ID); err != nil {
			return err
		}
		profile.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&profile).Error; err != nil {
			return err
		}
		if err := syncLinkedUser(tx, &profile); err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"update_contact",
			"contact_profiles",
			strconv.FormatUint(uint64(profile.ID), 10),
			profile.Name,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeContactError(c, err, "通讯录人员不存在")
		return
	}
	h.returnContact(c, id)
}

func (h *Handler) returnContact(c *gin.Context, id uint) {
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

func applyContactInput(db *gorm.DB, profile *model.ContactProfile, input contactInput, actorID uint) error {
	if input.Name.Set {
		name := strings.TrimSpace(input.Name.Value)
		if name == "" {
			return contactInputError("姓名不能为空")
		}
		if utf8.RuneCountInString(name) > 64 {
			return contactInputError("姓名最多 64 个字符")
		}
		profile.Name = name
	} else if profile.ID == 0 && strings.TrimSpace(profile.Name) == "" {
		return contactInputError("姓名不能为空")
	}

	if input.DeptID.Set {
		profile.DeptID = input.DeptID.Value
		if profile.DeptID != nil {
			var count int64
			if err := db.Model(&model.Department{}).Where("id = ?", *profile.DeptID).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return contactInputError("部门不存在")
			}
		}
	}
	if input.UserID.Set {
		profile.UserID = input.UserID.Value
	}
	if input.EmployeeNo.Set {
		employeeNo := strings.TrimSpace(input.EmployeeNo.Value)
		if utf8.RuneCountInString(employeeNo) > 32 {
			return contactInputError("工号最多 32 个字符")
		}
		if employeeNo == "" {
			profile.EmployeeNo = nil
		} else {
			var count int64
			query := db.Model(&model.ContactProfile{}).Where("employee_no = ?", employeeNo)
			if profile.ID != 0 {
				query = query.Where("id <> ?", profile.ID)
			}
			if err := query.Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				return contactInputError("工号已存在")
			}
			profile.EmployeeNo = &employeeNo
		}
	}

	texts := []textUpdate{
		{"mobile", input.Mobile, 32, &profile.Mobile},
		{"position", input.Position, 64, &profile.Position},
		{"work_email", input.WorkEmail, 128, &profile.WorkEmail},
		{"office_phone", input.OfficePhone, 32, &profile.OfficePhone},
		{"work_location", input.WorkLocation, 128, &profile.WorkLocation},
		{"contract_type", input.ContractType, 32, &profile.ContractType},
		{"gender", input.Gender, 8, &profile.Gender},
		{"id_card_no", input.IDCardNo, 32, &profile.IDCardNo},
		{"native_place", input.NativePlace, 64, &profile.NativePlace},
		{"political_status", input.PoliticalStatus, 32, &profile.PoliticalStatus},
		{"marital_status", input.MaritalStatus, 16, &profile.MaritalStatus},
		{"address", input.Address, 255, &profile.Address},
		{"highest_education", input.HighestEducation, 32, &profile.HighestEducation},
		{"school", input.School, 128, &profile.School},
		{"major", input.Major, 128, &profile.Major},
		{"degree", input.Degree, 32, &profile.Degree},
		{"emergency_contact", input.EmergencyContact, 64, &profile.EmergencyContact},
		{"emergency_relation", input.EmergencyRelation, 32, &profile.EmergencyRelation},
		{"emergency_phone", input.EmergencyPhone, 32, &profile.EmergencyPhone},
		{"remark", input.Remark, 1000, &profile.Remark},
	}
	for _, update := range texts {
		if !update.value.Set {
			continue
		}
		value := strings.TrimSpace(update.value.Value)
		if utf8.RuneCountInString(value) > update.limit {
			return contactInputError(fmt.Sprintf("%s 最多 %d 个字符", update.name, update.limit))
		}
		*update.dst = value
	}

	if input.ManagerID.Set {
		profile.ManagerID = input.ManagerID.Value
		if profile.ManagerID != nil {
			if profile.ID != 0 && *profile.ManagerID == profile.ID {
				return contactInputError("直属上级不能选择本人")
			}
			var count int64
			if err := db.Model(&model.ContactProfile{}).Where("id = ?", *profile.ManagerID).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return contactInputError("直属上级不存在")
			}
		}
	}
	if input.EmploymentType.Set {
		value := strings.TrimSpace(input.EmploymentType.Value)
		if !employmentTypes[value] {
			return contactInputError("用工类型不合法")
		}
		profile.EmploymentType = value
	}
	if input.EmploymentStatus.Set {
		value := strings.TrimSpace(input.EmploymentStatus.Value)
		if !isEmploymentStatus(value) {
			return contactInputError("任职状态仅支持 active/probation/leave")
		}
		profile.EmploymentStatus = value
	}
	if input.ContractType.Set && profile.ContractType != "" && !contractTypes[profile.ContractType] {
		return contactInputError("合同类型不合法")
	}
	if input.Gender.Set && profile.Gender != "" && !genders[profile.Gender] {
		return contactInputError("性别仅支持 男/女/未填写")
	}

	if input.HireDate.Set {
		profile.HireDate = input.HireDate.Value
	}
	if input.RegularDate.Set {
		profile.RegularDate = input.RegularDate.Value
	}
	if input.LeaveDate.Set {
		profile.LeaveDate = input.LeaveDate.Value
	}
	if input.ContractStart.Set {
		profile.ContractStart = input.ContractStart.Value
	}
	if input.ContractEnd.Set {
		profile.ContractEnd = input.ContractEnd.Value
	}
	if input.BirthDate.Set {
		profile.BirthDate = input.BirthDate.Value
	}
	if input.GraduationDate.Set {
		profile.GraduationDate = input.GraduationDate.Value
	}

	today := timeutil.NewDate(timeutil.AppNow())
	if dateAfter(profile.BirthDate, &today) {
		return contactInputError("出生日期不能晚于今天")
	}
	if dateAfter(profile.HireDate, profile.RegularDate) {
		return contactInputError("入职日期不能晚于转正日期")
	}
	if dateAfter(profile.RegularDate, profile.LeaveDate) {
		return contactInputError("转正日期不能晚于离职日期")
	}
	if dateAfter(profile.HireDate, profile.LeaveDate) {
		return contactInputError("入职日期不能晚于离职日期")
	}
	if dateAfter(profile.ContractStart, profile.ContractEnd) {
		return contactInputError("合同开始日期不能晚于结束日期")
	}
	if profile.IDCardNo != "" && !idCardPattern.MatchString(profile.IDCardNo) {
		return contactInputError("身份证号须为 15 位或 18 位中国居民身份证格式")
	}
	profile.IDCardNo = strings.ToUpper(profile.IDCardNo)
	if profile.WorkEmail != "" && !emailPattern.MatchString(profile.WorkEmail) {
		return contactInputError("工作邮箱格式不正确")
	}

	if profile.UserID != nil {
		var account model.User
		if err := db.First(&account, "id = ?", *profile.UserID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return contactInputError("关联账号不存在")
			}
			return err
		}
		var count int64
		query := db.Model(&model.ContactProfile{}).Where("user_id = ?", *profile.UserID)
		if profile.ID != 0 {
			query = query.Where("id <> ?", profile.ID)
		}
		if err := query.Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return contactInputError("该账号已关联其他通讯录人员")
		}
	}

	profile.UpdatedBy = &actorID
	profile.UpdatedAt = timeutil.NowDateTime()
	return nil
}

func syncLinkedUser(db *gorm.DB, profile *model.ContactProfile) error {
	if profile.UserID == nil {
		return nil
	}
	return db.Model(&model.User{}).
		Where("id = ?", *profile.UserID).
		Updates(map[string]any{
			"real_name":  profile.Name,
			"dept_id":    profile.DeptID,
			"updated_at": timeutil.NowDateTime(),
		}).Error
}

func dateAfter(left, right *timeutil.Date) bool {
	return left != nil && right != nil && left.After(right.Time)
}

func isEmploymentStatus(status string) bool {
	return employmentStatuses[status]
}

func maskIDCard(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 8 {
		return strings.Repeat("*", len(value))
	}
	return value[:6] + strings.Repeat("*", len(value)-10) + value[len(value)-4:]
}
