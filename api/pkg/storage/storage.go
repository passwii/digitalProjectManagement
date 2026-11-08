package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type StorageBackend interface {
	Upload(ctx context.Context, key string, body io.Reader, size int64, contentType string) (string, string, error) // returns publicURL, etag, error
	Download(ctx context.Context, key string) (io.ReadCloser, int64, string, error)
	Delete(ctx context.Context, key string) error
	Presign(ctx context.Context, key string, ttl time.Duration) (string, error)
	PublicURL(key string) string
	Name() string
}

type LocalBackend struct {
	RootDir string
}

func NewLocalBackend(rootDir string) (*LocalBackend, error) {
	if rootDir == "" {
		rootDir = filepath.Join(os.TempDir(), "pm-staging-files")
	}
	if err := os.MkdirAll(rootDir, 0755); err != nil {
		return nil, err
	}
	return &LocalBackend{RootDir: rootDir}, nil
}

func (l *LocalBackend) Name() string { return "local" }

func (l *LocalBackend) Upload(ctx context.Context, key string, body io.Reader, size int64, contentType string) (string, string, error) {
	target := filepath.Join(l.RootDir, key)
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return "", "", err
	}
	f, err := os.Create(target)
	if err != nil {
		return "", "", err
	}
	defer f.Close()

	if _, err := io.Copy(f, body); err != nil {
		return "", "", err
	}
	return target, "local-etag", nil
}

func (l *LocalBackend) Download(ctx context.Context, key string) (io.ReadCloser, int64, string, error) {
	target := key
	if !filepath.IsAbs(target) {
		target = filepath.Join(l.RootDir, key)
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, 0, "", err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, "", err
	}
	return f, fi.Size(), "application/octet-stream", nil
}

func (l *LocalBackend) Delete(ctx context.Context, key string) error {
	target := key
	if !filepath.IsAbs(target) {
		target = filepath.Join(l.RootDir, key)
	}
	_ = os.Remove(target)
	return nil
}

func (l *LocalBackend) Presign(ctx context.Context, key string, ttl time.Duration) (string, error) {
	return "", errors.New("presign not supported on local backend")
}

func (l *LocalBackend) PublicURL(key string) string {
	if filepath.IsAbs(key) {
		return key
	}
	return filepath.Join(l.RootDir, key)
}

type R2Backend struct {
	Client    *s3.Client
	Presigner *s3.PresignClient
	Bucket    string
	PublicURLPrefix string
}

func NewR2Backend(endpoint, accessKey, secretKey, bucket, region, publicURLPrefix string) (*R2Backend, error) {
	if endpoint == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil, errors.New("incomplete R2 credentials")
	}
	if region == "" {
		region = "auto"
	}

	customResolver := aws.EndpointResolverWithOptionsFunc(func(service, reg string, options ...interface{}) (aws.Endpoint, error) {
		return aws.Endpoint{
			URL:               endpoint,
			SigningRegion:     region,
			HostnameImmutable: true,
		}, nil
	})

	cfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
		awsconfig.WithEndpointResolverWithOptions(customResolver),
		awsconfig.WithRegion(region),
	)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
	})
	presigner := s3.NewPresignClient(client)

	return &R2Backend{
		Client:          client,
		Presigner:       presigner,
		Bucket:          bucket,
		PublicURLPrefix: strings.TrimRight(publicURLPrefix, "/"),
	}, nil
}

func (r *R2Backend) Name() string { return "r2" }

func (r *R2Backend) Upload(ctx context.Context, key string, body io.Reader, size int64, contentType string) (string, string, error) {
	input := &s3.PutObjectInput{
		Bucket:        aws.String(r.Bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	}
	out, err := r.Client.PutObject(ctx, input)
	if err != nil {
		return "", "", err
	}
	etag := ""
	if out.ETag != nil {
		etag = strings.Trim(*out.ETag, "\"")
	}
	return r.PublicURL(key), etag, nil
}

func (r *R2Backend) Download(ctx context.Context, key string) (io.ReadCloser, int64, string, error) {
	input := &s3.GetObjectInput{
		Bucket: aws.String(r.Bucket),
		Key:    aws.String(key),
	}
	out, err := r.Client.GetObject(ctx, input)
	if err != nil {
		return nil, 0, "", err
	}
	var size int64
	if out.ContentLength != nil {
		size = *out.ContentLength
	}
	cType := "application/octet-stream"
	if out.ContentType != nil && *out.ContentType != "" {
		cType = *out.ContentType
	}
	return out.Body, size, cType, nil
}

func (r *R2Backend) Delete(ctx context.Context, key string) error {
	input := &s3.DeleteObjectInput{
		Bucket: aws.String(r.Bucket),
		Key:    aws.String(key),
	}
	_, err := r.Client.DeleteObject(ctx, input)
	return err
}

func (r *R2Backend) Presign(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := r.Presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(r.Bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (r *R2Backend) PublicURL(key string) string {
	if r.PublicURLPrefix != "" {
		return fmt.Sprintf("%s/%s", r.PublicURLPrefix, url.PathEscape(key))
	}
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s", r.Bucket, url.PathEscape(key))
}

var globalBackend StorageBackend

func InitGlobal(backend StorageBackend) {
	globalBackend = backend
}

func GetBackend() StorageBackend {
	return globalBackend
}

func GetBackendForRow(backendName string) StorageBackend {
	if backendName == "local" {
		loc, _ := NewLocalBackend(os.Getenv("STORAGE_LOCAL_ROOT"))
		return loc
	}
	if globalBackend != nil && globalBackend.Name() == backendName {
		return globalBackend
	}
	return globalBackend
}
