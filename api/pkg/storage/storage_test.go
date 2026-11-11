package storage

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	chineseObjectKey     = "合同/2026/采购合同-534万__a1b2c3d4.pdf"
	escapedChineseObject = "%E5%90%88%E5%90%8C%2F2026%2F%E9%87%87%E8%B4%AD%E5%90%88%E5%90%8C-534%E4%B8%87__a1b2c3d4.pdf"
)

func newLocalBackendForTest(t *testing.T, root string) *LocalBackend {
	t.Helper()
	backend, err := NewLocalBackend(root)
	if err != nil {
		t.Fatalf("NewLocalBackend(%q): %v", root, err)
	}
	return backend
}

func readAndClose(t *testing.T, rc io.ReadCloser) string {
	t.Helper()
	defer func() {
		if err := rc.Close(); err != nil {
			t.Errorf("close download stream: %v", err)
		}
	}()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read download stream: %v", err)
	}
	return string(data)
}

func resetGlobalBackend(t *testing.T) {
	t.Helper()
	previous := globalBackend
	globalBackend = nil
	t.Cleanup(func() { globalBackend = previous })
}

func TestLocalBackendUploadDownloadDelete(t *testing.T) {
	tests := []struct {
		name        string
		key         string
		body        string
		contentType string
	}{
		{name: "flat key", key: "report.pdf", body: "flat-body", contentType: "application/pdf"},
		{name: "nested key", key: "project/2026/contracts/agreement.pdf", body: "nested-body", contentType: "application/pdf"},
		{name: "unicode key", key: chineseObjectKey, body: "unicode-body", contentType: "application/pdf"},
		{name: "spaces in key", key: "hr/offer letter final.txt", body: "spaces-body", contentType: "text/plain"},
		{name: "empty body", key: "empty.bin", body: "", contentType: "application/octet-stream"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			backend := newLocalBackendForTest(t, root)
			wantPath := filepath.Join(root, tt.key)

			publicURL, etag, err := backend.Upload(ctx, tt.key, strings.NewReader(tt.body), int64(len(tt.body)), tt.contentType)
			if err != nil {
				t.Fatalf("Upload(%q): %v", tt.key, err)
			}
			if publicURL != wantPath {
				t.Fatalf("Upload public URL = %q, want %q", publicURL, wantPath)
			}
			if etag != "local-etag" {
				t.Fatalf("Upload etag = %q, want %q", etag, "local-etag")
			}

			// Nested keys must create their parent directories on disk.
			info, err := os.Stat(filepath.Dir(wantPath))
			if err != nil {
				t.Fatalf("stat parent directory: %v", err)
			}
			if !info.IsDir() {
				t.Fatalf("parent path %q is not a directory", filepath.Dir(wantPath))
			}
			onDisk, err := os.ReadFile(wantPath)
			if err != nil {
				t.Fatalf("read uploaded file %q: %v", wantPath, err)
			}
			if string(onDisk) != tt.body {
				t.Fatalf("uploaded content = %q, want %q", string(onDisk), tt.body)
			}

			rc, size, contentType, err := backend.Download(ctx, tt.key)
			if err != nil {
				t.Fatalf("Download(%q): %v", tt.key, err)
			}
			if got := readAndClose(t, rc); got != tt.body {
				t.Fatalf("Download body = %q, want %q", got, tt.body)
			}
			if size != int64(len(tt.body)) {
				t.Fatalf("Download size = %d, want %d", size, len(tt.body))
			}
			// The local backend always reports a generic content type.
			if contentType != "application/octet-stream" {
				t.Fatalf("Download content type = %q, want %q", contentType, "application/octet-stream")
			}

			// Upload returns an absolute path, so Download and Delete must also
			// accept absolute paths.
			rc, _, _, err = backend.Download(ctx, publicURL)
			if err != nil {
				t.Fatalf("Download(absolute %q): %v", publicURL, err)
			}
			if got := readAndClose(t, rc); got != tt.body {
				t.Fatalf("Download(absolute) body = %q, want %q", got, tt.body)
			}

			if got := backend.PublicURL(tt.key); got != wantPath {
				t.Fatalf("PublicURL(%q) = %q, want %q", tt.key, got, wantPath)
			}
			if got := backend.PublicURL(publicURL); got != publicURL {
				t.Fatalf("PublicURL(absolute) = %q, want %q", got, publicURL)
			}

			if err := backend.Delete(ctx, tt.key); err != nil {
				t.Fatalf("Delete(%q): %v", tt.key, err)
			}
			if _, err := os.Stat(wantPath); !os.IsNotExist(err) {
				t.Fatalf("file %q still exists after Delete, stat err = %v", wantPath, err)
			}
			if err := backend.Delete(ctx, tt.key); err != nil {
				t.Fatalf("Delete(%q) on missing file = %v, want nil", tt.key, err)
			}
			if _, _, _, err := backend.Download(ctx, tt.key); err == nil {
				t.Fatalf("Download(%q) after Delete succeeded, want error", tt.key)
			}

			// Delete also accepts the absolute path returned by Upload.
			if _, _, err := backend.Upload(ctx, tt.key, strings.NewReader(tt.body), int64(len(tt.body)), tt.contentType); err != nil {
				t.Fatalf("re-Upload(%q): %v", tt.key, err)
			}
			if err := backend.Delete(ctx, publicURL); err != nil {
				t.Fatalf("Delete(absolute %q): %v", publicURL, err)
			}
			if _, err := os.Stat(wantPath); !os.IsNotExist(err) {
				t.Fatalf("file %q still exists after Delete(absolute), stat err = %v", wantPath, err)
			}
		})
	}
}

func TestLocalBackendPublicURL(t *testing.T) {
	root := t.TempDir()
	backend := newLocalBackendForTest(t, root)
	absoluteKey := filepath.Join(root, "absolute.pdf")

	tests := []struct {
		name string
		key  string
		want string
	}{
		{name: "relative key", key: "report.pdf", want: filepath.Join(root, "report.pdf")},
		{name: "nested key", key: "project/2026/report.pdf", want: filepath.Join(root, "project", "2026", "report.pdf")},
		{name: "unicode key", key: chineseObjectKey, want: filepath.Join(root, chineseObjectKey)},
		{name: "absolute key is returned unchanged", key: absoluteKey, want: absoluteKey},
		{name: "empty key resolves to root", key: "", want: root},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := backend.PublicURL(tt.key); got != tt.want {
				t.Fatalf("PublicURL(%q) = %q, want %q", tt.key, got, tt.want)
			}
		})
	}
}

func TestLocalBackendPresignUnsupported(t *testing.T) {
	backend := newLocalBackendForTest(t, t.TempDir())
	tests := []struct {
		name string
		ttl  time.Duration
	}{
		{name: "zero ttl", ttl: 0},
		{name: "one minute", ttl: time.Minute},
		{name: "one day", ttl: 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := backend.Presign(context.Background(), chineseObjectKey, tt.ttl)
			if err == nil {
				t.Fatal("Presign returned nil error, want presign-not-supported error")
			}
			if got != "" {
				t.Fatalf("Presign URL = %q, want empty string", got)
			}
			if err.Error() != "presign not supported on local backend" {
				t.Fatalf("Presign error = %q, want %q", err.Error(), "presign not supported on local backend")
			}
		})
	}
}

func TestR2BackendPublicURL(t *testing.T) {
	tests := []struct {
		name    string
		backend R2Backend
		key     string
		want    string
	}{
		{
			name:    "default endpoint with ascii nested key",
			backend: R2Backend{Bucket: "ziktech"},
			key:     "a/b.pdf",
			want:    "https://ziktech.r2.cloudflarestorage.com/a%2Fb.pdf",
		},
		{
			name:    "default endpoint escapes unicode key",
			backend: R2Backend{Bucket: "ziktech"},
			key:     chineseObjectKey,
			want:    "https://ziktech.r2.cloudflarestorage.com/" + escapedChineseObject,
		},
		{
			name:    "public prefix replaces endpoint",
			backend: R2Backend{Bucket: "ziktech", PublicURLPrefix: "https://cdn.example.com"},
			key:     "docs/a b.pdf",
			want:    "https://cdn.example.com/docs%2Fa%20b.pdf",
		},
		{
			name:    "public prefix escapes unicode key",
			backend: R2Backend{Bucket: "ziktech", PublicURLPrefix: "https://cdn.example.com"},
			key:     chineseObjectKey,
			want:    "https://cdn.example.com/" + escapedChineseObject,
		},
		{
			name:    "empty prefix falls back to bucket endpoint",
			backend: R2Backend{Bucket: "ziktech", PublicURLPrefix: ""},
			key:     "simple.pdf",
			want:    "https://ziktech.r2.cloudflarestorage.com/simple.pdf",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			backend := tt.backend
			got := backend.PublicURL(tt.key)
			if got != tt.want {
				t.Fatalf("PublicURL(%q) = %q, want %q", tt.key, got, tt.want)
			}
			if strings.Contains(got, "合同") || strings.Contains(got, "采购") {
				t.Fatalf("PublicURL(%q) = %q contains unescaped unicode", tt.key, got)
			}
		})
	}
}

func TestNewR2BackendRejectsIncompleteConfig(t *testing.T) {
	tests := []struct {
		name      string
		endpoint  string
		accessKey string
		secretKey string
		bucket    string
	}{
		{name: "missing endpoint", endpoint: "", accessKey: "placeholder-key-id", secretKey: "placeholder-secret", bucket: "ziktech"},
		{name: "missing access key", endpoint: "https://account123.r2.cloudflarestorage.com", accessKey: "", secretKey: "placeholder-secret", bucket: "ziktech"},
		{name: "missing secret key", endpoint: "https://account123.r2.cloudflarestorage.com", accessKey: "placeholder-key-id", secretKey: "", bucket: "ziktech"},
		{name: "missing bucket", endpoint: "https://account123.r2.cloudflarestorage.com", accessKey: "placeholder-key-id", secretKey: "placeholder-secret", bucket: ""},
		{name: "missing everything", endpoint: "", accessKey: "", secretKey: "", bucket: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			backend, err := NewR2Backend(tt.endpoint, tt.accessKey, tt.secretKey, tt.bucket, "auto", "https://cdn.example.com")
			if backend != nil {
				t.Fatalf("NewR2Backend returned backend %+v, want nil", backend)
			}
			if err == nil {
				t.Fatal("NewR2Backend returned nil error, want incomplete-config error")
			}
			if err.Error() != "incomplete R2 credentials" {
				t.Fatalf("NewR2Backend error = %q, want %q", err.Error(), "incomplete R2 credentials")
			}
		})
	}
}

func TestBackendNames(t *testing.T) {
	tests := []struct {
		name    string
		backend StorageBackend
		want    string
	}{
		{name: "local", backend: newLocalBackendForTest(t, t.TempDir()), want: "local"},
		{name: "r2", backend: &R2Backend{Bucket: "ziktech"}, want: "r2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.backend.Name(); got != tt.want {
				t.Fatalf("Name() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestInitGlobalAndGetBackend(t *testing.T) {
	resetGlobalBackend(t)

	if got := GetBackend(); got != nil {
		t.Fatalf("GetBackend() before InitGlobal = %v, want nil", got)
	}

	first := &R2Backend{Bucket: "ziktech"}
	InitGlobal(first)
	if got := GetBackend(); got != first {
		t.Fatalf("GetBackend() = %v, want the initialized R2 backend", got)
	}
	if got := GetBackend().Name(); got != "r2" {
		t.Fatalf("GetBackend().Name() = %q, want %q", got, "r2")
	}

	second := newLocalBackendForTest(t, t.TempDir())
	InitGlobal(second)
	if got := GetBackend(); got != second {
		t.Fatalf("GetBackend() = %v, want the replaced local backend", got)
	}
	if got := GetBackend().Name(); got != "local" {
		t.Fatalf("GetBackend().Name() = %q, want %q", got, "local")
	}
}

func TestGetBackendForRow(t *testing.T) {
	localRoot := t.TempDir()
	t.Setenv("STORAGE_LOCAL_ROOT", localRoot)
	globalR2 := &R2Backend{Bucket: "ziktech"}
	globalLocal := newLocalBackendForTest(t, t.TempDir())

	tests := []struct {
		name          string
		global        StorageBackend
		rowBackend    string
		wantNil       bool
		wantGlobal    bool
		wantLocalRoot string
	}{
		{name: "local row without global", global: nil, rowBackend: "local", wantLocalRoot: localRoot},
		{name: "non-local row without global", global: nil, rowBackend: "r2", wantNil: true},
		{name: "local row ignores matching global", global: globalR2, rowBackend: "local", wantLocalRoot: localRoot},
		{name: "r2 row uses matching global", global: globalR2, rowBackend: "r2", wantGlobal: true},
		{name: "unknown row falls back to global", global: globalR2, rowBackend: "s3", wantGlobal: true},
		{name: "empty row falls back to global", global: globalR2, rowBackend: "", wantGlobal: true},
		{name: "local row creates dedicated backend even with local global", global: globalLocal, rowBackend: "local", wantLocalRoot: localRoot},
		{name: "empty row with local global falls back", global: globalLocal, rowBackend: "", wantGlobal: true},
		{name: "r2 row with local global falls back", global: globalLocal, rowBackend: "r2", wantGlobal: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetGlobalBackend(t)
			if tt.global != nil {
				InitGlobal(tt.global)
			}

			got := GetBackendForRow(tt.rowBackend)
			switch {
			case tt.wantNil:
				if got != nil {
					t.Fatalf("GetBackendForRow(%q) = %v, want nil", tt.rowBackend, got)
				}
			case tt.wantGlobal:
				if got != tt.global {
					t.Fatalf("GetBackendForRow(%q) = %v, want the global backend", tt.rowBackend, got)
				}
			default:
				if got == nil {
					t.Fatalf("GetBackendForRow(%q) returned nil", tt.rowBackend)
				}
				if got == tt.global {
					t.Fatalf("GetBackendForRow(%q) returned the global backend, want a dedicated local backend", tt.rowBackend)
				}
				local, ok := got.(*LocalBackend)
				if !ok {
					t.Fatalf("GetBackendForRow(%q) returned %T, want *LocalBackend", tt.rowBackend, got)
				}
				if local.RootDir != tt.wantLocalRoot {
					t.Fatalf("local RootDir = %q, want %q", local.RootDir, tt.wantLocalRoot)
				}
				if local.Name() != "local" {
					t.Fatalf("local Name() = %q, want %q", local.Name(), "local")
				}
			}
		})
	}
}
