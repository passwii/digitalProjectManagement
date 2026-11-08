package expense

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/storage"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const maxVoucherSize = 20 << 20

var allowedVoucherExtensions = map[string]bool{
	".pdf": true, ".docx": true, ".xlsx": true,
	".png": true, ".jpg": true, ".jpeg": true,
}

func (h *Handler) UploadVoucher(c *gin.Context) {
	id, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	expenseRow, projectRow, err := loadExpense(h.DB, id, user, true)
	if err != nil {
		expenseError(c, err)
		return
	}
	if projectRow.Status == "archived" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
		return
	}
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请上传凭证文件"})
		return
	}
	defer file.Close()
	if header.Size <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "凭证文件为空"})
		return
	}
	if header.Size > maxVoucherSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"detail": "凭证不能超过 20 MiB"})
		return
	}
	filename := filepath.Base(header.Filename)
	extension := strings.ToLower(filepath.Ext(filename))
	if !allowedVoucherExtensions[extension] {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "凭证格式不支持"})
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxVoucherSize+1))
	if err != nil || len(data) == 0 || len(data) > maxVoucherSize {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "读取凭证文件失败或文件超限"})
		return
	}
	backend, err := voucherBackend("")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "初始化附件存储失败"})
		return
	}
	key := fmt.Sprintf("expenses/%d/%s%s", id, uuid.NewString(), extension)
	contentType := header.Header.Get("Content-Type")
	publicURL, etag, err := backend.Upload(c.Request.Context(), key, bytes.NewReader(data), int64(len(data)), contentType)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "保存凭证失败"})
		return
	}
	projectID := expenseRow.ProjectID
	attachment := model.Attachment{
		ProjectID: &projectID, Filename: filename, Path: publicURL,
		Size: int64(len(data)), ContentType: contentType, UploadedBy: &user.ID,
		UploadedAt: timeutil.NowDateTime(), RefType: "expense", RefID: &expenseRow.ID,
		Category: "expense", StorageBackend: backend.Name(), ObjectKey: key, ETag: etag,
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&attachment).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "upload_expense_voucher", "attachments", strconv.FormatUint(uint64(attachment.ID), 10), filename, c.ClientIP())
	})
	if err != nil {
		_ = backend.Delete(context.Background(), key)
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "保存凭证记录失败"})
		return
	}
	c.JSON(http.StatusCreated, voucherRow(attachment))
}

func (h *Handler) ListVouchers(c *gin.Context) {
	id, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	if _, _, err := loadExpense(h.DB, id, rbac.GetCurrentUser(c), false); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "支出不存在"})
		return
	}
	var rows []model.Attachment
	if err := h.DB.Where("ref_type = ? AND ref_id = ?", "expense", id).Order("id ASC").Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询支出凭证失败"})
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, voucherRow(row))
	}
	c.JSON(http.StatusOK, items)
}

func (h *Handler) DownloadVoucher(c *gin.Context) {
	expenseID, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	attachmentID, ok := expensePathID(c, "aid")
	if !ok {
		return
	}
	if _, _, err := loadExpense(h.DB, expenseID, rbac.GetCurrentUser(c), false); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "支出不存在"})
		return
	}
	var row model.Attachment
	if err := h.DB.Where("id = ? AND ref_type = ? AND ref_id = ?", attachmentID, "expense", expenseID).First(&row).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "凭证不存在"})
		return
	}
	backend, err := voucherBackend(row.StorageBackend)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "附件存储不可用"})
		return
	}
	downloadKey := row.ObjectKey
	if row.StorageBackend != "r2" && strings.TrimSpace(row.Path) != "" {
		downloadKey = row.Path
	}
	reader, size, contentType, err := backend.Download(c.Request.Context(), downloadKey)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "读取凭证失败"})
		return
	}
	defer reader.Close()
	user := rbac.GetCurrentUser(c)
	if err := audit.WriteAudit(h.DB, &user.ID, "download_expense_voucher", "attachments", strconv.FormatUint(uint64(row.ID), 10), row.Filename, c.ClientIP()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "写入下载审计失败"})
		return
	}
	if contentType == "" {
		contentType = row.ContentType
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": row.Filename})
	c.Header("Content-Disposition", disposition)
	c.DataFromReader(http.StatusOK, size, contentType, reader, nil)
}

func (h *Handler) DeleteVoucher(c *gin.Context) {
	expenseID, ok := expensePathID(c, "eid")
	if !ok {
		return
	}
	attachmentID, ok := expensePathID(c, "aid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	expenseRow, projectRow, err := loadExpense(h.DB, expenseID, user, true)
	if err != nil {
		expenseError(c, err)
		return
	}
	if projectRow.Status == "archived" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
		return
	}
	var row model.Attachment
	if err := h.DB.Where("id = ? AND ref_type = ? AND ref_id = ?", attachmentID, "expense", expenseID).First(&row).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "凭证不存在"})
		return
	}
	if (row.UploadedBy == nil || *row.UploadedBy != user.ID) && !user.IsSuperAdmin {
		c.JSON(http.StatusForbidden, gin.H{"detail": "仅上传者或超级管理员可删除凭证"})
		return
	}
	backend, err := voucherBackend(row.StorageBackend)
	if err != nil || func() error {
		delKey := row.ObjectKey
		if row.StorageBackend != "r2" && strings.TrimSpace(row.Path) != "" {
			delKey = row.Path
		}
		return backend.Delete(c.Request.Context(), delKey)
	}() != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": "删除凭证正文失败"})
		return
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_expense_voucher", "attachments", strconv.FormatUint(uint64(row.ID), 10), row.Filename, c.ClientIP())
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "删除凭证记录失败"})
		return
	}
	_ = expenseRow
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func voucherRow(row model.Attachment) gin.H {
	return gin.H{
		"id": row.ID, "filename": row.Filename, "size": row.Size,
		"content_type": row.ContentType, "uploaded_by": row.UploadedBy,
		"uploaded_at": row.UploadedAt,
	}
}

func voucherBackend(name string) (storage.StorageBackend, error) {
	if name != "" {
		if backend := storage.GetBackendForRow(name); backend != nil {
			return backend, nil
		}
	}
	if backend := storage.GetBackend(); backend != nil {
		return backend, nil
	}
	return storage.NewLocalBackend(os.Getenv("STORAGE_LOCAL_ROOT"))
}
