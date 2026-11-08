package partner

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
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
	api := r.Group("/partners", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ModulePartners))
	api.GET("", h.listPartners)
	api.POST("", h.createPartner)
	api.GET("/:pid/contracts", h.listContracts)
	api.POST("/:pid/contracts", h.createContract)
	api.PATCH("/:pid/contracts/:cid", h.updateContract)
	api.DELETE("/:pid/contracts/:cid", h.deleteContract)
	api.GET("/:pid/attachments/:aid/download", h.downloadAttachment)
	api.GET("/:pid/attachments", h.listAttachments)
	api.POST("/:pid/attachments", h.uploadAttachment)
	api.DELETE("/:pid/attachments/:aid", h.deleteAttachment)
	api.GET("/:pid", h.getPartner)
	api.PATCH("/:pid", h.updatePartner)
	api.DELETE("/:pid", h.deletePartner)
}

type field[T any] struct {
	Value T
	Set   bool
}

func (f *field[T]) UnmarshalJSON(data []byte) error {
	f.Set = true
	return json.Unmarshal(data, &f.Value)
}

type partnerInput struct {
	Name        field[string] `json:"name"`
	ContactName field[string] `json:"contact_name"`
	Phone       field[string] `json:"phone"`
	Email       field[string] `json:"email"`
	Address     field[string] `json:"address"`
	Remark      field[string] `json:"remark"`
}

type partnerResponse struct {
	ID              uint                `json:"id"`
	Name            string              `json:"name"`
	ContactName     string              `json:"contact_name"`
	Phone           string              `json:"phone"`
	Email           string              `json:"email"`
	Address         string              `json:"address"`
	Remark          string              `json:"remark"`
	ContractCount   *int64              `json:"contract_count,omitempty"`
	Contracts       *[]contractResponse `json:"contracts,omitempty"`
	AttachmentCount int64               `json:"attachment_count"`
	CreatedAt       timeutil.DateTime   `json:"created_at"`
	UpdatedAt       timeutil.DateTime   `json:"updated_at"`
}

type contractResponse struct {
	ID          uint              `json:"id"`
	PartnerID   uint              `json:"partner_id"`
	ProjectName string            `json:"project_name"`
	Amount      float64           `json:"amount"`
	SignedDate  *timeutil.Date    `json:"signed_date"`
	Remark      string            `json:"remark"`
	CreatedAt   timeutil.DateTime `json:"created_at"`
}

var partnerSorts = map[string]string{
	"id":         "partners.id",
	"name":       "partners.name",
	"updated_at": "partners.updated_at",
}

var partnerEmailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

func (h *Handler) listPartners(c *gin.Context) {
	page, ok := queryInt(c, "page", 1)
	if !ok {
		return
	}
	size, ok := queryInt(c, "size", paging.DefaultPageSize)
	if !ok {
		return
	}
	query := h.DB.Model(&model.Partner{})
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		query = query.Where("partners.name ILIKE ?", "%"+keyword+"%")
	}
	env, err := paging.Paginate[model.Partner](query, page, size, c.Query("sort"), partnerSorts, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	ids := make([]uint, 0, len(env.Items))
	for _, item := range env.Items {
		ids = append(ids, item.ID)
	}
	contractCounts, err := groupedPartnerCounts(h.DB, "partner_contracts", "partner_id", ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询业绩合同数量失败"})
		return
	}
	attachmentCounts, err := groupedPartnerCountsForAttachments(h.DB, ids)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件数量失败"})
		return
	}
	items := make([]partnerResponse, 0, len(env.Items))
	for _, item := range env.Items {
		count := contractCounts[item.ID]
		items = append(items, serializePartner(item, &count, attachmentCounts[item.ID], nil))
	}
	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": items,
	})
}

func (h *Handler) createPartner(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	var input partnerInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	var partner model.Partner
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		partner = model.Partner{}
		if err := applyPartnerInput(tx, &partner, input, user.ID, true); err != nil {
			return err
		}
		partner.CreatedBy = &user.ID
		if err := tx.Create(&partner).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"create_partner",
			"partners",
			strconv.FormatUint(uint64(partner.ID), 10),
			partner.Name,
			c.ClientIP(),
		)
	})
	if err != nil {
		writePartnerError(c, err, "创建友商失败")
		return
	}
	h.returnPartner(c, partner.ID)
}

func (h *Handler) getPartner(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	h.returnPartner(c, id)
}

func (h *Handler) returnPartner(c *gin.Context, id uint) {
	var partner model.Partner
	err := h.DB.Preload("Contracts", func(db *gorm.DB) *gorm.DB {
		return db.Order("id ASC")
	}).First(&partner, "id = ?", id).Error
	if err != nil {
		writePartnerError(c, err, "友商不存在")
		return
	}
	attachments, err := groupedPartnerCountsForAttachments(h.DB, []uint{id})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件数量失败"})
		return
	}
	contracts := make([]contractResponse, 0, len(partner.Contracts))
	for _, row := range partner.Contracts {
		contracts = append(contracts, serializeContract(row))
	}
	c.JSON(http.StatusOK, serializePartner(partner, nil, attachments[id], &contracts))
}

func (h *Handler) updatePartner(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	var input partnerInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var partner model.Partner
		if err := tx.First(&partner, "id = ?", id).Error; err != nil {
			return err
		}
		if err := applyPartnerInput(tx, &partner, input, user.ID, false); err != nil {
			return err
		}
		partner.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&partner).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"update_partner",
			"partners",
			strconv.FormatUint(uint64(partner.ID), 10),
			partner.Name,
			c.ClientIP(),
		)
	})
	if err != nil {
		writePartnerError(c, err, "更新友商失败")
		return
	}
	h.returnPartner(c, id)
}

func applyPartnerInput(db *gorm.DB, partner *model.Partner, input partnerInput, actorID uint, creating bool) error {
	if input.Name.Set || creating {
		name := strings.TrimSpace(input.Name.Value)
		if name == "" {
			return partnerInputError("友商名称不能为空")
		}
		if utf8.RuneCountInString(name) > 128 {
			return partnerInputError("友商名称最多 128 个字符")
		}
		var count int64
		query := db.Model(&model.Partner{}).Where("name = ?", name)
		if partner.ID != 0 {
			query = query.Where("id <> ?", partner.ID)
		}
		if err := query.Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return partnerInputError("友商名称已存在")
		}
		partner.Name = name
	}

	texts := []struct {
		name  string
		value field[string]
		limit int
		dst   *string
	}{
		{"contact_name", input.ContactName, 64, &partner.ContactName},
		{"phone", input.Phone, 64, &partner.Phone},
		{"email", input.Email, 128, &partner.Email},
		{"address", input.Address, 255, &partner.Address},
		{"remark", input.Remark, 1000, &partner.Remark},
	}
	for _, text := range texts {
		if !text.value.Set {
			continue
		}
		value := strings.TrimSpace(text.value.Value)
		if utf8.RuneCountInString(value) > text.limit {
			return partnerInputError(text.name + " 超出长度限制")
		}
		*text.dst = value
	}
	if partner.Email != "" && !partnerEmailPattern.MatchString(partner.Email) {
		return partnerInputError("邮箱格式不正确")
	}
	partner.UpdatedBy = &actorID
	return nil
}

func serializePartner(partner model.Partner, contractCount *int64, attachmentCount int64, contracts *[]contractResponse) partnerResponse {
	return partnerResponse{
		ID:              partner.ID,
		Name:            partner.Name,
		ContactName:     partner.ContactName,
		Phone:           partner.Phone,
		Email:           partner.Email,
		Address:         partner.Address,
		Remark:          partner.Remark,
		ContractCount:   contractCount,
		Contracts:       contracts,
		AttachmentCount: attachmentCount,
		CreatedAt:       partner.CreatedAt,
		UpdatedAt:       partner.UpdatedAt,
	}
}

func serializeContract(contract model.PartnerContract) contractResponse {
	return contractResponse{
		ID:          contract.ID,
		PartnerID:   contract.PartnerID,
		ProjectName: contract.ProjectName,
		Amount:      contract.Amount,
		SignedDate:  contract.SignedDate,
		Remark:      contract.Remark,
		CreatedAt:   contract.CreatedAt,
	}
}

func groupedPartnerCounts(db *gorm.DB, table, column string, ids []uint) (map[uint]int64, error) {
	counts := make(map[uint]int64, len(ids))
	if len(ids) == 0 {
		return counts, nil
	}
	var rows []struct {
		PartnerID uint
		Count     int64
	}
	err := db.Table(table).
		Select(column+" AS partner_id, COUNT(*) AS count").
		Where(column+" IN ?", ids).
		Group(column).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		counts[row.PartnerID] = row.Count
	}
	return counts, nil
}

func groupedPartnerCountsForAttachments(db *gorm.DB, ids []uint) (map[uint]int64, error) {
	counts := make(map[uint]int64, len(ids))
	if len(ids) == 0 {
		return counts, nil
	}
	var rows []struct {
		RefID uint
		Count int64
	}
	err := db.Model(&model.Attachment{}).
		Select("ref_id, COUNT(*) AS count").
		Where("project_id IS NULL AND ref_type = ? AND ref_id IN ?", "partner", ids).
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
		c.JSON(http.StatusBadRequest, gin.H{"detail": key + " 须为整数"})
		return 0, false
	}
	return value, true
}

func parseID(c *gin.Context, key string) (uint, bool) {
	value, err := strconv.ParseUint(c.Param(key), 10, 64)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "无效的资源 ID"})
		return 0, false
	}
	return uint(value), true
}

type partnerInputError string

func (e partnerInputError) Error() string { return string(e) }

func writePartnerError(c *gin.Context, err error, fallback string) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "友商不存在"})
		return
	}
	var inputErr partnerInputError
	if errors.As(err, &inputErr) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": inputErr.Error()})
		return
	}
	if isPartnerUniqueViolation(err) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "友商名称已存在"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": fallback})
}

func isPartnerUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") ||
		strings.Contains(message, "duplicate key") ||
		strings.Contains(message, "violates unique")
}
