package paging

import (
	"fmt"
	"sort"
	"strings"

	"gorm.io/gorm"
)

const (
	DefaultPageSize = 20
	MaxPageSize     = 100
	MaxSortKeys     = 3
)

type Envelope[T any] struct {
	Total int64 `json:"total"`
	Page  int   `json:"page"`
	Size  int   `json:"size"`
	Items []T   `json:"items"`
}

func ValidatePage(page int) (int, error) {
	if page < 1 {
		return 1, fmt.Errorf("page 须为 ≥1 的整数，收到 %d", page)
	}
	return page, nil
}

func ValidateSize(size int, maximum ...int) (int, error) {
	max := MaxPageSize
	if len(maximum) > 0 && maximum[0] > 0 {
		max = maximum[0]
	}
	if size < 1 || size > max {
		return DefaultPageSize, fmt.Errorf("size 须为 1-%d 的整数，收到 %d", max, size)
	}
	return size, nil
}

func BuildOrderBy(sortParam string, allowed map[string]string, defaultSort string) ([]string, error) {
	raw := strings.TrimSpace(sortParam)
	if raw == "" {
		raw = defaultSort
	}
	parts := strings.Split(raw, ",")
	var keys []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			keys = append(keys, p)
		}
	}
	if len(keys) == 0 {
		keys = []string{defaultSort}
	}
	if len(keys) > MaxSortKeys {
		return nil, fmt.Errorf("sort 最多支持 %d 个字段", MaxSortKeys)
	}

	var clauses []string
	seen := make(map[string]bool)
	for _, key := range keys {
		desc := strings.HasPrefix(key, "-")
		name := strings.TrimPrefix(key, "-")
		col, ok := allowed[name]
		if !ok {
			var valid []string
			for k := range allowed {
				valid = append(valid, k)
			}
			sort.Strings(valid)
			return nil, fmt.Errorf("不支持的排序字段：'%s'（可选：%v）", name, valid)
		}
		if desc {
			clauses = append(clauses, col+" DESC")
		} else {
			clauses = append(clauses, col+" ASC")
		}
		seen[name] = true
	}

	// 稳定排序兜底：若未显式包含 id 且白名单支持 id，则追加 id ASC
	if !seen["id"] {
		if col, ok := allowed["id"]; ok {
			clauses = append(clauses, col+" ASC")
		}
	}
	return clauses, nil
}

func Paginate[T any](query *gorm.DB, page, size int, sortParam string, allowed map[string]string, defaultSort string) (*Envelope[T], error) {
	validPage, err := ValidatePage(page)
	if err != nil {
		return nil, err
	}
	validSize, err := ValidateSize(size)
	if err != nil {
		return nil, err
	}
	clauses, err := BuildOrderBy(sortParam, allowed, defaultSort)
	if err != nil {
		return nil, err
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, err
	}

	offset := (validPage - 1) * validSize
	var items []T
	for _, clause := range clauses {
		query = query.Order(clause)
	}
	if err := query.Offset(offset).Limit(validSize).Find(&items).Error; err != nil {
		return nil, err
	}

	if items == nil {
		items = []T{}
	}

	return &Envelope[T]{
		Total: total,
		Page:  validPage,
		Size:  validSize,
		Items: items,
	}, nil
}
