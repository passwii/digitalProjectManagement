package attachment

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/storage"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const MaxUploadSize int64 = 100 * 1024 * 1024

var allowedExtensions = map[string]bool{
	".pdf": true, ".doc": true, ".docx": true, ".xls": true,
	".xlsx": true, ".png": true, ".jpg": true, ".jpeg": true,
}

var (
	ErrUploadTooLarge = errors.New("单文件最大 100MB")
	ErrFileType       = errors.New("文件类型不支持")
)

type StorageError struct {
	Err error
}

func (e StorageError) Error() string { return e.Err.Error() }
func (e StorageError) Unwrap() error { return e.Err }

func ValidateUpload(filename string, size int64) (string, error) {
	if size < 0 || size > MaxUploadSize {
		return "", ErrUploadTooLarge
	}
	filename = filepath.Base(strings.ReplaceAll(filename, "\\", "/"))
	if filename == "." || filename == string(filepath.Separator) || filename == "" {
		filename = "attachment"
	}
	if !allowedExtensions[strings.ToLower(filepath.Ext(filename))] {
		return "", ErrFileType
	}
	if len([]byte(filename)) > 255 {
		return "", errors.New("文件名最多 255 个字节")
	}
	return filename, nil
}

func ReadLimited(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxUploadSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxUploadSize {
		return nil, ErrUploadTooLarge
	}
	return data, nil
}

type StoreInput struct {
	Context     context.Context
	DB          *gorm.DB
	Filename    string
	ContentType string
	Data        []byte
	RefType     string
	RefID       uint
	Category    string
	ActorID     uint
	Action      string
	IP          string
}

func Store(input StoreInput) (*model.Attachment, error) {
	if input.DB == nil {
		return nil, errors.New("附件数据库未初始化")
	}
	filename, err := ValidateUpload(input.Filename, int64(len(input.Data)))
	if err != nil {
		return nil, err
	}
	if input.Context == nil {
		input.Context = context.Background()
	}
	backend, err := uploadBackend()
	if err != nil {
		return nil, StorageError{Err: err}
	}

	key := fmt.Sprintf("%s/%d/%s%s", input.RefType, input.RefID, uuid.NewString(), strings.ToLower(filepath.Ext(filename)))
	publicURL, etag, err := backend.Upload(
		input.Context,
		key,
		bytes.NewReader(input.Data),
		int64(len(input.Data)),
		input.ContentType,
	)
	if err != nil {
		return nil, StorageError{Err: err}
	}

	actorID := input.ActorID
	row := &model.Attachment{
		Filename:       filename,
		Path:           publicURL,
		Size:           int64(len(input.Data)),
		ContentType:    input.ContentType,
		UploadedBy:     &actorID,
		UploadedAt:     timeutil.NowDateTime(),
		RefType:        input.RefType,
		RefID:          &input.RefID,
		Category:       input.Category,
		StorageBackend: backend.Name(),
		ObjectKey:      key,
		ETag:           etag,
	}
	err = input.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&actorID,
			input.Action,
			"attachments",
			strconv.FormatUint(uint64(row.ID), 10),
			fmt.Sprintf("%d:%s:%s", input.RefID, input.Category, filename),
			input.IP,
		)
	})
	if err != nil {
		_ = backend.Delete(input.Context, key)
		return nil, err
	}
	return row, nil
}

func List(db *gorm.DB, refType string, refID uint, category string) ([]model.Attachment, error) {
	var rows []model.Attachment
	err := db.Where(
		"project_id IS NULL AND ref_type = ? AND ref_id = ?",
		refType,
		refID,
	).Scopes(func(tx *gorm.DB) *gorm.DB {
		if category != "" {
			return tx.Where("category = ?", category)
		}
		return tx
	}).Order("id DESC").Find(&rows).Error
	if rows == nil {
		rows = []model.Attachment{}
	}
	return rows, err
}

func Download(ctx context.Context, row model.Attachment) (io.ReadCloser, int64, string, error) {
	backend, key, err := backendForRow(row)
	if err != nil {
		return nil, 0, "", StorageError{Err: err}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	reader, size, contentType, err := backend.Download(ctx, key)
	if err != nil {
		return nil, 0, "", StorageError{Err: err}
	}
	if row.ContentType != "" {
		contentType = row.ContentType
	}
	return reader, size, contentType, nil
}

func DeleteBlob(ctx context.Context, row model.Attachment) error {
	backend, key, err := backendForRow(row)
	if err != nil {
		return StorageError{Err: err}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := backend.Delete(ctx, key); err != nil {
		return StorageError{Err: err}
	}
	return nil
}

func Delete(db *gorm.DB, row model.Attachment, actorID uint, action, detail, ip string) error {
	if err := DeleteBlob(context.Background(), row); err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.Attachment{}, row.ID).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&actorID,
			action,
			"attachments",
			strconv.FormatUint(uint64(row.ID), 10),
			detail,
			ip,
		)
	})
}

func ContentDisposition(filename string) string {
	return "attachment; filename*=UTF-8''" + url.PathEscape(filename)
}

func uploadBackend() (storage.StorageBackend, error) {
	configured := strings.TrimSpace(os.Getenv("STORAGE_BACKEND"))
	if backend := storage.GetBackend(); backend != nil {
		if configured != "" && !strings.EqualFold(configured, backend.Name()) {
			return nil, fmt.Errorf("配置的存储后端 %q 与已初始化后端 %q 不一致", configured, backend.Name())
		}
		return backend, nil
	}
	if strings.EqualFold(configured, "r2") {
		return nil, errors.New("R2 存储尚未初始化")
	}
	return storage.NewLocalBackend(os.Getenv("STORAGE_LOCAL_ROOT"))
}

func backendForRow(row model.Attachment) (storage.StorageBackend, string, error) {
	backendName := strings.ToLower(strings.TrimSpace(row.StorageBackend))
	if backendName == "" {
		backendName = "local"
	}
	backend := storage.GetBackendForRow(backendName)
	if backend != nil && backend.Name() != backendName {
		return nil, "", fmt.Errorf("附件记录需要 %q 后端，当前初始化的是 %q", backendName, backend.Name())
	}
	if backend == nil {
		if backendName != "local" {
			return nil, "", fmt.Errorf("附件存储后端 %q 不可用", backendName)
		}
		local, err := storage.NewLocalBackend(os.Getenv("STORAGE_LOCAL_ROOT"))
		if err != nil {
			return nil, "", err
		}
		backend = local
	}

	key := row.ObjectKey
	if backend.Name() == "local" && key == "" {
		key = row.Path
	}
	if key == "" {
		return nil, "", errors.New("附件存储路径为空")
	}
	return backend, key, nil
}
