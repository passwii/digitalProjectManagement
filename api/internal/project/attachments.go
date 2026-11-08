package project

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
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/storage"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const maxProjectAttachmentSize = 20 << 20

type uploadPayload struct {
	filename    string
	contentType string
	refType     string
	data        []byte
}

func readProjectUpload(c *gin.Context) (uploadPayload, error) {
	reader, err := c.Request.MultipartReader()
	if err != nil {
		return uploadPayload{}, err
	}
	var payload uploadPayload
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return payload, err
		}
		switch part.FormName() {
		case "file":
			if payload.filename != "" {
				part.Close()
				return payload, fmt.Errorf("只能上传一个文件")
			}
			payload.filename = filepath.Base(part.FileName())
			payload.contentType = part.Header.Get("Content-Type")
			payload.data, err = io.ReadAll(io.LimitReader(part, maxProjectAttachmentSize+1))
			part.Close()
			if err != nil {
				return payload, err
			}
			if len(payload.data) > maxProjectAttachmentSize {
				return payload, errAttachmentTooLarge
			}
		case "ref_type":
			value, readErr := io.ReadAll(io.LimitReader(part, 64))
			part.Close()
			if readErr != nil {
				return payload, readErr
			}
			payload.refType = string(value)
		default:
			part.Close()
		}
	}
	if payload.filename == "" {
		return payload, fmt.Errorf("缺少 file 文件")
	}
	if len(payload.data) == 0 {
		return payload, fmt.Errorf("附件文件为空")
	}
	return payload, nil
}

func attachmentBackend(name string) (storage.StorageBackend, error) {
	if name != "" {
		backend := storage.GetBackendForRow(name)
		if backend != nil {
			return backend, nil
		}
	}
	if backend := storage.GetBackend(); backend != nil {
		return backend, nil
	}
	return storage.NewLocalBackend(os.Getenv("STORAGE_LOCAL_ROOT"))
}

func (h *Handler) UploadAttachment(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := loadWritableProject(h.DB, user, id)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
		} else {
			writeError(c, http.StatusBadRequest, err.Error())
		}
		return
	}
	payload, err := readProjectUpload(c)
	if err != nil {
		if err == errAttachmentTooLarge {
			writeError(c, http.StatusRequestEntityTooLarge, "附件不能超过 20 MiB")
		} else {
			writeError(c, http.StatusBadRequest, "附件上传格式错误："+err.Error())
		}
		return
	}
	if payload.refType != "" && payload.refType != "contract" {
		writeError(c, http.StatusBadRequest, "附件类型不支持")
		return
	}
	extension := strings.ToLower(filepath.Ext(payload.filename))
	allowed := map[string]bool{".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".png": true, ".jpg": true, ".jpeg": true, ".txt": true, ".zip": true}
	if !allowed[extension] {
		writeError(c, http.StatusBadRequest, "附件格式不支持")
		return
	}
	backend, err := attachmentBackend("")
	if err != nil {
		writeError(c, http.StatusInternalServerError, "初始化附件存储失败")
		return
	}
	key := fmt.Sprintf("projects/%d/%s%s", id, uuid.NewString(), extension)
	publicURL, etag, err := backend.Upload(c.Request.Context(), key, bytes.NewReader(payload.data), int64(len(payload.data)), payload.contentType)
	if err != nil {
		writeError(c, http.StatusBadGateway, "保存附件失败")
		return
	}
	now := timeutil.NowDateTime()
	projectID := projectRow.ID
	attachment := model.Attachment{
		ProjectID: &projectID, Filename: payload.filename, Path: publicURL,
		Size: int64(len(payload.data)), ContentType: payload.contentType,
		UploadedBy: &user.ID, UploadedAt: now, RefType: payload.refType,
		Category: "project", StorageBackend: backend.Name(), ObjectKey: key, ETag: etag,
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&attachment).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "upload_attachment", "attachments", strconv.FormatUint(uint64(attachment.ID), 10), attachment.Filename, c.ClientIP())
	})
	if err != nil {
		_ = backend.Delete(context.Background(), key)
		writeError(c, http.StatusInternalServerError, "保存附件记录失败")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": attachment.ID, "filename": attachment.Filename, "size": attachment.Size})
}

func (h *Handler) ListAttachments(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	if _, err := LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), id); err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
		} else {
			writeError(c, http.StatusInternalServerError, "查询项目失败")
		}
		return
	}
	refType := strings.TrimSpace(c.Query("ref_type"))
	if refType != "" && refType != "contract" {
		writeError(c, http.StatusBadRequest, "附件类型不支持")
		return
	}
	q := h.DB.Model(&model.Attachment{}).Where("project_id = ?", id)
	if refType != "" {
		q = q.Where("ref_type = ?", refType)
	} else {
		q = q.Where("COALESCE(ref_type, '') = ''")
	}
	var rows []model.Attachment
	if err := q.Order("id ASC").Find(&rows).Error; err != nil {
		writeError(c, http.StatusInternalServerError, "查询项目附件失败")
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, gin.H{
			"id": row.ID, "filename": row.Filename, "size": row.Size,
			"ref_type": row.RefType, "content_type": row.ContentType,
			"uploaded_by": row.UploadedBy, "uploaded_at": timeText(&row.UploadedAt),
		})
	}
	c.JSON(http.StatusOK, items)
}

func (h *Handler) attachment(c *gin.Context, projectID uint, attachmentID uint) (model.Attachment, bool) {
	var row model.Attachment
	err := h.DB.Where("id = ? AND project_id = ? AND COALESCE(ref_type, '') IN ?", attachmentID, projectID, []string{"", "contract"}).First(&row).Error
	if err != nil {
		writeError(c, http.StatusNotFound, "附件不存在")
		return row, false
	}
	return row, true
}

func (h *Handler) DownloadAttachment(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	attachmentID, ok := parseID(c, "aid")
	if !ok {
		return
	}
	if _, err := LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), projectID); err != nil {
		writeError(c, http.StatusNotFound, "项目不存在")
		return
	}
	row, ok := h.attachment(c, projectID, attachmentID)
	if !ok {
		return
	}
	backend, err := attachmentBackend(row.StorageBackend)
	if err != nil {
		writeError(c, http.StatusBadGateway, "附件存储不可用")
		return
	}
	downloadKey := row.ObjectKey
	if row.StorageBackend != "r2" && strings.TrimSpace(row.Path) != "" {
		downloadKey = row.Path
	}
	reader, size, contentType, err := backend.Download(c.Request.Context(), downloadKey)
	if err != nil {
		writeError(c, http.StatusBadGateway, "读取附件失败")
		return
	}
	defer reader.Close()
	user := rbac.GetCurrentUser(c)
	if err := audit.WriteAudit(h.DB, &user.ID, "download_attachment", "attachments", strconv.FormatUint(uint64(row.ID), 10), row.Filename, c.ClientIP()); err != nil {
		writeError(c, http.StatusInternalServerError, "写入下载审计失败")
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

func (h *Handler) DeleteAttachment(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	attachmentID, ok := parseID(c, "aid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := loadWritableProject(h.DB, user, projectID)
	if err != nil {
		writeError(c, http.StatusNotFound, "项目不存在")
		return
	}
	row, ok := h.attachment(c, projectID, attachmentID)
	if !ok {
		return
	}
	if (row.UploadedBy == nil || *row.UploadedBy != user.ID) && !user.IsSuperAdmin {
		writeError(c, http.StatusForbidden, "仅上传者或超级管理员可删除附件")
		return
	}
	backend, err := attachmentBackend(row.StorageBackend)
	if err != nil || func() error {
		delKey := row.ObjectKey
		if row.StorageBackend != "r2" && strings.TrimSpace(row.Path) != "" {
			delKey = row.Path
		}
		return backend.Delete(c.Request.Context(), delKey)
	}() != nil {
		writeError(c, http.StatusBadGateway, "删除附件正文失败")
		return
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.Attachment{}, row.ID).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_attachment", "attachments", strconv.FormatUint(uint64(row.ID), 10), row.Filename, c.ClientIP())
	})
	if err != nil {
		writeError(c, http.StatusInternalServerError, "删除附件记录失败")
		return
	}
	_ = projectRow
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

var errAttachmentTooLarge = fmt.Errorf("attachment too large")

func attachmentAge(now time.Time) string {
	return now.Format(time.RFC3339)
}
