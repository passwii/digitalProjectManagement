package partner

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strconv"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/attachment"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var partnerAttachmentCategories = map[string]string{
	"qual_cert":   "资质证书",
	"performance": "业绩证明",
	"contract":    "合同扫描",
	"other":       "其他",
}

type partnerAttachmentResponse struct {
	ID            uint              `json:"id"`
	Filename      string            `json:"filename"`
	Size          int64             `json:"size"`
	Category      string            `json:"category"`
	CategoryLabel string            `json:"category_label"`
	ContentType   string            `json:"content_type"`
	UploadedBy    *uint             `json:"uploaded_by"`
	UploadedAt    timeutil.DateTime `json:"uploaded_at"`
}

func (h *Handler) listAttachments(c *gin.Context) {
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	if err := partnerExists(h.DB, partnerID); err != nil {
		writePartnerError(c, err, "友商不存在")
		return
	}
	category := c.Query("category")
	if category != "" && !isPartnerAttachmentCategory(category) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "附件分类不支持"})
		return
	}
	rows, err := attachment.List(h.DB, "partner", partnerID, category)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件失败"})
		return
	}
	items := make([]partnerAttachmentResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, serializePartnerAttachment(row))
	}
	c.JSON(http.StatusOK, items)
}

func (h *Handler) uploadAttachment(c *gin.Context) {
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	if err := partnerExists(h.DB, partnerID); err != nil {
		writePartnerError(c, err, "友商不存在")
		return
	}

	c.Request.Body = http.MaxBytesReader(
		c.Writer,
		c.Request.Body,
		attachment.MaxUploadSize+(1<<20),
	)
	category := c.PostForm("category")
	if !isPartnerAttachmentCategory(category) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "附件分类不支持"})
		return
	}
	header, err := c.FormFile("file")
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writePartnerAttachmentError(c, attachment.ErrUploadTooLarge, "附件超过大小限制")
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请选择附件文件"})
		return
	}
	filename, err := attachment.ValidateUpload(header.Filename, header.Size)
	if err != nil {
		writePartnerAttachmentError(c, err, "附件校验失败")
		return
	}
	file, err := header.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "读取附件失败"})
		return
	}
	data, readErr := attachment.ReadLimited(file)
	closeErr := file.Close()
	if readErr != nil {
		writePartnerAttachmentError(c, readErr, "读取附件失败")
		return
	}
	if closeErr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "读取附件失败"})
		return
	}
	filename, err = attachment.ValidateUpload(filename, int64(len(data)))
	if err != nil {
		writePartnerAttachmentError(c, err, "附件校验失败")
		return
	}

	user := rbac.GetCurrentUser(c)
	row, err := attachment.Store(attachment.StoreInput{
		Context:     c.Request.Context(),
		DB:          h.DB,
		Filename:    filename,
		ContentType: header.Header.Get("Content-Type"),
		Data:        data,
		RefType:     "partner",
		RefID:       partnerID,
		Category:    category,
		ActorID:     user.ID,
		Action:      "upload_partner_attachment",
		IP:          c.ClientIP(),
	})
	if err != nil {
		writePartnerAttachmentError(c, err, "上传附件失败")
		return
	}
	c.JSON(http.StatusOK, serializePartnerAttachment(*row))
}

func (h *Handler) downloadAttachment(c *gin.Context) {
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	attachmentID, ok := parseID(c, "aid")
	if !ok {
		return
	}
	if err := partnerExists(h.DB, partnerID); err != nil {
		writePartnerError(c, err, "友商不存在")
		return
	}
	var row model.Attachment
	err := h.DB.Where(
		"project_id IS NULL AND ref_type = ? AND ref_id = ? AND id = ?",
		"partner",
		partnerID,
		attachmentID,
	).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "附件不存在"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件失败"})
		return
	}
	reader, size, contentType, err := attachment.Download(c.Request.Context(), row)
	if err != nil {
		writePartnerAttachmentError(c, err, "下载附件失败")
		return
	}
	defer reader.Close()
	user := rbac.GetCurrentUser(c)
	if err := audit.WriteAudit(
		h.DB,
		&user.ID,
		"download_partner_attachment",
		"attachments",
		strconv.FormatUint(uint64(row.ID), 10),
		fmt.Sprintf("%d:%s", partnerID, row.Filename),
		c.ClientIP(),
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": audit.AuditFailMsg})
		return
	}
	c.DataFromReader(
		http.StatusOK,
		size,
		contentType,
		reader,
		map[string]string{"Content-Disposition": attachment.ContentDisposition(row.Filename)},
	)
}

func (h *Handler) deleteAttachment(c *gin.Context) {
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	attachmentID, ok := parseID(c, "aid")
	if !ok {
		return
	}
	if err := partnerExists(h.DB, partnerID); err != nil {
		writePartnerError(c, err, "友商不存在")
		return
	}
	var row model.Attachment
	err := h.DB.Where(
		"project_id IS NULL AND ref_type = ? AND ref_id = ? AND id = ?",
		"partner",
		partnerID,
		attachmentID,
	).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "附件不存在"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询附件失败"})
		return
	}
	user := rbac.GetCurrentUser(c)
	err = attachment.Delete(
		h.DB,
		row,
		user.ID,
		"delete_partner_attachment",
		fmt.Sprintf("%d:%s", partnerID, row.Filename),
		c.ClientIP(),
	)
	if err != nil {
		writePartnerAttachmentError(c, err, "删除附件失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func serializePartnerAttachment(row model.Attachment) partnerAttachmentResponse {
	return partnerAttachmentResponse{
		ID:            row.ID,
		Filename:      row.Filename,
		Size:          row.Size,
		Category:      row.Category,
		CategoryLabel: partnerAttachmentCategories[row.Category],
		ContentType:   row.ContentType,
		UploadedBy:    row.UploadedBy,
		UploadedAt:    row.UploadedAt,
	}
}

func isPartnerAttachmentCategory(category string) bool {
	_, ok := partnerAttachmentCategories[category]
	return ok
}

func writePartnerAttachmentError(c *gin.Context, err error, fallback string) {
	if errors.Is(err, fs.ErrNotExist) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "附件文件已丢失，请联系管理员"})
		return
	}
	if errors.Is(err, attachment.ErrUploadTooLarge) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": attachment.ErrUploadTooLarge.Error()})
		return
	}
	if errors.Is(err, attachment.ErrFileType) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "仅允许 PDF、Office 文档和 JPG/PNG 图片"})
		return
	}
	var storageErr attachment.StorageError
	if errors.As(err, &storageErr) {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "文件存储不可用，请稍后重试"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": fallback})
}
