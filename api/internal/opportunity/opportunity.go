package opportunity

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
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
	"gorm.io/gorm/clause"
)

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	api := r.Group("/opportunities", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ModuleOpportunities))
	api.GET("", h.listOpportunities)
	api.POST("", h.createOpportunity)
	api.GET("/:oid", h.getOpportunity)
	api.PATCH("/:oid", h.updateOpportunity)
	api.DELETE("/:oid", h.deleteOpportunity)
}

type field[T any] struct {
	Value T
	Set   bool
}

func (f *field[T]) UnmarshalJSON(data []byte) error {
	f.Set = true
	return json.Unmarshal(data, &f.Value)
}

type opportunityInput struct {
	Code          field[string]         `json:"code"`
	Name          field[string]         `json:"name"`
	Client        field[string]         `json:"client"`
	OwnerID       field[*uint]          `json:"owner_id"`
	OwnerName     field[string]         `json:"owner_name"`
	BudgetTotal   field[*float64]       `json:"budget_total"`
	Stage         field[string]         `json:"stage"`
	ExpectedClose field[*timeutil.Date] `json:"expected_close"`
	Description   field[string]         `json:"description"`
}

type opportunityResponse struct {
	ID            uint           `json:"id"`
	Code          string         `json:"code"`
	Name          string         `json:"name"`
	Client        string         `json:"client"`
	OwnerID       *uint          `json:"owner_id"`
	OwnerName     string         `json:"owner_name"`
	BudgetTotal   float64        `json:"budget_total"`
	Stage         string         `json:"stage"`
	ExpectedClose *timeutil.Date `json:"expected_close"`
	Description   string         `json:"description"`
}

var opportunitySorts = map[string]string{
	"id":             "opportunities.id",
	"code":           "opportunities.code",
	"name":           "opportunities.name",
	"client":         "opportunities.client",
	"stage":          "opportunities.stage",
	"budget_total":   "opportunities.budget_total",
	"expected_close": "opportunities.expected_close",
	"created_at":     "opportunities.created_at",
}

var opportunityStages = map[string]bool{
	"new": true, "qualified": true, "proposal": true,
	"negotiation": true, "won": true, "lost": true,
}

func (h *Handler) listOpportunities(c *gin.Context) {
	page, ok := opportunityInt(c, "page", 1)
	if !ok {
		return
	}
	size, ok := opportunityInt(c, "size", paging.DefaultPageSize)
	if !ok {
		return
	}

	query := h.DB.Model(&model.Opportunity{}).Where("opportunities.deleted_at IS NULL")
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		like := "%" + keyword + "%"
		query = query.Where(
			"(opportunities.name ILIKE ? OR opportunities.code ILIKE ? OR opportunities.client ILIKE ? OR opportunities.description ILIKE ?)",
			like, like, like, like,
		)
	}
	if stage := strings.TrimSpace(c.Query("stage")); stage != "" {
		query = query.Where("opportunities.stage = ?", stage)
	}
	ownerName := strings.TrimSpace(c.Query("owner_name"))
	if ownerName == "" {
		ownerName = strings.TrimSpace(c.Query("owner"))
	}
	if ownerName != "" {
		query = query.Where("opportunities.owner_name = ?", ownerName)
	}

	env, err := paging.Paginate[model.Opportunity](
		query,
		page,
		size,
		c.Query("sort"),
		opportunitySorts,
		"-id",
	)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	items := make([]opportunityResponse, 0, len(env.Items))
	for _, item := range env.Items {
		items = append(items, serializeOpportunity(item))
	}
	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": items,
	})
}

func (h *Handler) createOpportunity(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	var input opportunityInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	var opportunity model.Opportunity
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		name := strings.TrimSpace(input.Name.Value)
		if name == "" {
			return opportunityInputError("商机名称必填")
		}
		if utf8.RuneCountInString(name) > 128 {
			return opportunityInputError("商机名称最多 128 个字符")
		}
		if err := ensureUniqueOpportunityName(tx, name, 0); err != nil {
			return err
		}

		code := strings.TrimSpace(input.Code.Value)
		if utf8.RuneCountInString(code) > 32 {
			return opportunityInputError("商机编号最多 32 个字符")
		}
		if code == "" {
			var err error
			code, err = generateOpportunityCode(tx, timeutil.AppNow().Year())
			if err != nil {
				return err
			}
		} else if err := ensureUniqueOpportunityCode(tx, code, 0); err != nil {
			return err
		}

		stage := "new"
		if input.Stage.Set {
			stage = strings.TrimSpace(input.Stage.Value)
		}
		if !isOpportunityStage(stage) {
			return opportunityInputError("商机阶段不合法")
		}
		amount := float64(0)
		if input.BudgetTotal.Set {
			if input.BudgetTotal.Value == nil || !validOpportunityAmount(*input.BudgetTotal.Value) {
				return opportunityInputError("预计金额须为大于等于 0 的有效数字")
			}
			amount = *input.BudgetTotal.Value
		}

		client := strings.TrimSpace(input.Client.Value)
		if utf8.RuneCountInString(client) > 128 {
			return opportunityInputError("客户名称最多 128 个字符")
		}
		ownerName := strings.TrimSpace(input.OwnerName.Value)
		if utf8.RuneCountInString(ownerName) > 64 {
			return opportunityInputError("负责人姓名最多 64 个字符")
		}
		ownerID, resolvedOwnerName, err := resolveOpportunityOwner(tx, input.OwnerID.Value, ownerName, user)
		if err != nil {
			return err
		}

		opportunity = model.Opportunity{
			Code:          code,
			Name:          name,
			Client:        client,
			OwnerID:       ownerID,
			OwnerName:     resolvedOwnerName,
			BudgetTotal:   amount,
			Stage:         stage,
			ExpectedClose: input.ExpectedClose.Value,
			Description:   strings.TrimSpace(input.Description.Value),
			CreatedBy:     &user.ID,
			CreatedAt:     timeutil.NowDateTime(),
			UpdatedAt:     timeutil.NowDateTime(),
		}
		if err := tx.Create(&opportunity).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"create_opportunity",
			"opportunities",
			strconv.FormatUint(uint64(opportunity.ID), 10),
			opportunity.Code,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeOpportunityError(c, err, "创建商机失败")
		return
	}
	c.JSON(http.StatusOK, serializeOpportunity(opportunity))
}

func (h *Handler) getOpportunity(c *gin.Context) {
	id, ok := parseOpportunityID(c)
	if !ok {
		return
	}
	opportunity, err := loadOpportunity(h.DB, id, false)
	if err != nil {
		writeOpportunityError(c, err, "商机不存在")
		return
	}
	c.JSON(http.StatusOK, serializeOpportunity(opportunity))
}

func (h *Handler) updateOpportunity(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	id, ok := parseOpportunityID(c)
	if !ok {
		return
	}
	var input opportunityInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	var opportunity model.Opportunity
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		opportunity, err = loadOpportunity(tx, id, true)
		if err != nil {
			return err
		}
		if err := applyOpportunityInput(tx, &opportunity, input, user); err != nil {
			return err
		}
		opportunity.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&opportunity).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"update_opportunity",
			"opportunities",
			strconv.FormatUint(uint64(opportunity.ID), 10),
			opportunity.Code,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeOpportunityError(c, err, "更新商机失败")
		return
	}
	c.JSON(http.StatusOK, serializeOpportunity(opportunity))
}

func (h *Handler) deleteOpportunity(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	id, ok := parseOpportunityID(c)
	if !ok {
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		opportunity, err := loadOpportunity(tx, id, true)
		if err != nil {
			return err
		}
		now := timeutil.NowDateTime()
		if err := tx.Model(&model.Opportunity{}).
			Where("id = ? AND deleted_at IS NULL", id).
			Updates(map[string]any{
				"deleted_at": now,
				"updated_at": now,
			}).Error; err != nil {
			return err
		}
		opportunity.DeletedAt = &now
		opportunity.UpdatedAt = now
		return audit.CommitAudited(
			tx,
			&user.ID,
			"delete_opportunity",
			"opportunities",
			strconv.FormatUint(uint64(opportunity.ID), 10),
			opportunity.Code,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeOpportunityError(c, err, "删除商机失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func applyOpportunityInput(db *gorm.DB, opportunity *model.Opportunity, input opportunityInput, fallback *model.User) error {
	if input.Code.Set {
		code := strings.TrimSpace(input.Code.Value)
		if code == "" || utf8.RuneCountInString(code) > 32 {
			return opportunityInputError("商机编号必填且最多 32 个字符")
		}
		if err := ensureUniqueOpportunityCode(db, code, opportunity.ID); err != nil {
			return err
		}
		opportunity.Code = code
	}
	if input.Name.Set {
		name := strings.TrimSpace(input.Name.Value)
		if name == "" {
			return opportunityInputError("商机名称必填")
		}
		if utf8.RuneCountInString(name) > 128 {
			return opportunityInputError("商机名称最多 128 个字符")
		}
		if err := ensureUniqueOpportunityName(db, name, opportunity.ID); err != nil {
			return err
		}
		opportunity.Name = name
	}
	if input.Client.Set {
		client := strings.TrimSpace(input.Client.Value)
		if utf8.RuneCountInString(client) > 128 {
			return opportunityInputError("客户名称最多 128 个字符")
		}
		opportunity.Client = client
	}
	if input.OwnerName.Set && utf8.RuneCountInString(strings.TrimSpace(input.OwnerName.Value)) > 64 {
		return opportunityInputError("负责人姓名最多 64 个字符")
	}
	if input.BudgetTotal.Set {
		if input.BudgetTotal.Value == nil || !validOpportunityAmount(*input.BudgetTotal.Value) {
			return opportunityInputError("预计金额须为大于等于 0 的有效数字")
		}
		opportunity.BudgetTotal = *input.BudgetTotal.Value
	}
	if input.Stage.Set {
		stage := strings.TrimSpace(input.Stage.Value)
		if !isOpportunityStage(stage) {
			return opportunityInputError("商机阶段不合法")
		}
		opportunity.Stage = stage
	}
	if input.ExpectedClose.Set {
		opportunity.ExpectedClose = input.ExpectedClose.Value
	}
	if input.Description.Set {
		opportunity.Description = input.Description.Value
	}
	if input.OwnerID.Set || input.OwnerName.Set {
		ownerID := opportunity.OwnerID
		ownerName := opportunity.OwnerName
		if input.OwnerID.Set {
			ownerID = input.OwnerID.Value
		}
		if input.OwnerName.Set {
			ownerName = strings.TrimSpace(input.OwnerName.Value)
		}
		resolvedID, resolvedName, err := resolveOpportunityOwner(db, ownerID, ownerName, fallback)
		if err != nil {
			return err
		}
		opportunity.OwnerID = resolvedID
		opportunity.OwnerName = resolvedName
	}
	return nil
}

func resolveOpportunityOwner(db *gorm.DB, ownerID *uint, ownerName string, fallback *model.User) (*uint, string, error) {
	ownerName = strings.TrimSpace(ownerName)
	if ownerID != nil {
		var user model.User
		if err := db.First(&user, "id = ?", *ownerID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, "", opportunityInputError("商机负责人不存在")
			}
			return nil, "", err
		}
		if ownerName == "" {
			ownerName = user.RealName
			if ownerName == "" {
				ownerName = user.Username
			}
		}
		return ownerID, ownerName, nil
	}
	if ownerName != "" {
		var user model.User
		if err := db.Where("real_name = ?", ownerName).First(&user).Error; err == nil {
			return &user.ID, ownerName, nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, "", err
		}
	}
	if fallback != nil {
		if ownerName == "" {
			ownerName = fallback.RealName
		}
		if ownerName == "" {
			ownerName = fallback.Username
		}
		return &fallback.ID, ownerName, nil
	}
	return nil, ownerName, nil
}

func generateOpportunityCode(tx *gorm.DB, year int) (string, error) {
	lockKey := fmt.Sprintf("opportunity-code-%d", year)
	if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))", lockKey).Error; err != nil {
		return "", err
	}
	prefix := fmt.Sprintf("OPP-%d-", year)
	var codes []string
	if err := tx.Model(&model.Opportunity{}).
		Where("code LIKE ?", prefix+"%").
		Pluck("code", &codes).Error; err != nil {
		return "", err
	}
	return nextOpportunityCodeForCodes(year, codes), nil
}

func nextOpportunityCode(year int, last string) string {
	return nextOpportunityCodeForCodes(year, []string{last})
}

func nextOpportunityCodeForCodes(year int, codes []string) string {
	prefix := fmt.Sprintf("OPP-%d-", year)
	maxNumber := 0
	for _, code := range codes {
		if !strings.HasPrefix(code, prefix) {
			continue
		}
		number, err := strconv.Atoi(strings.TrimPrefix(code, prefix))
		if err == nil && number > maxNumber {
			maxNumber = number
		}
	}
	return fmt.Sprintf("%s%04d", prefix, maxNumber+1)
}

func loadOpportunity(db *gorm.DB, id uint, lock bool) (model.Opportunity, error) {
	var opportunity model.Opportunity
	query := db
	if lock {
		query = query.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate})
	}
	err := query.Where("deleted_at IS NULL").First(&opportunity, "id = ?", id).Error
	return opportunity, err
}

func ensureUniqueOpportunityCode(db *gorm.DB, code string, exceptID uint) error {
	query := db.Model(&model.Opportunity{}).Where("code = ?", code)
	if exceptID != 0 {
		query = query.Where("id <> ?", exceptID)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return opportunityInputError("商机编号已存在")
	}
	return nil
}

func ensureUniqueOpportunityName(db *gorm.DB, name string, exceptID uint) error {
	query := db.Model(&model.Opportunity{}).
		Where("name = ? AND deleted_at IS NULL", name)
	if exceptID != 0 {
		query = query.Where("id <> ?", exceptID)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return opportunityInputError("商机名称已存在")
	}
	return nil
}

func serializeOpportunity(opportunity model.Opportunity) opportunityResponse {
	return opportunityResponse{
		ID:            opportunity.ID,
		Code:          opportunity.Code,
		Name:          opportunity.Name,
		Client:        opportunity.Client,
		OwnerID:       opportunity.OwnerID,
		OwnerName:     opportunity.OwnerName,
		BudgetTotal:   opportunity.BudgetTotal,
		Stage:         opportunity.Stage,
		ExpectedClose: opportunity.ExpectedClose,
		Description:   opportunity.Description,
	}
}

func isOpportunityStage(stage string) bool {
	return opportunityStages[stage]
}

func validOpportunityAmount(amount float64) bool {
	return !math.IsNaN(amount) && !math.IsInf(amount, 0) && amount >= 0
}

func opportunityInt(c *gin.Context, key string, fallback int) (int, bool) {
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

func parseOpportunityID(c *gin.Context) (uint, bool) {
	value, err := strconv.ParseUint(c.Param("oid"), 10, 64)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "无效的商机 ID"})
		return 0, false
	}
	return uint(value), true
}

type opportunityInputError string

func (e opportunityInputError) Error() string { return string(e) }

func writeOpportunityError(c *gin.Context, err error, fallback string) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "商机不存在"})
		return
	}
	var inputErr opportunityInputError
	if errors.As(err, &inputErr) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": inputErr.Error()})
		return
	}
	if isOpportunityUniqueViolation(err) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "商机编号或名称已存在"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": fallback})
}

func isOpportunityUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") ||
		strings.Contains(message, "duplicate key") ||
		strings.Contains(message, "violates unique")
}
