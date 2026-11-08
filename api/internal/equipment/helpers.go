package equipment

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/shopspring/decimal"
)

func normalizeHeaderKey(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var normalized strings.Builder
	for _, char := range value {
		if unicode.IsSpace(char) || char == '_' || strings.ContainsRune("（）()：:-/，,。", char) {
			continue
		}
		normalized.WriteRune(char)
	}
	return normalized.String()
}

func parseImportDate(value string) (*timeutil.Date, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return nil, nil
	}
	text = strings.NewReplacer("年", "-", "月", "-", "日", "", "/", "-", ".", "-").Replace(text)
	if index := strings.IndexAny(text, "T "); index >= 0 {
		text = text[:index]
	}
	parts := strings.Split(text, "-")
	if len(parts) != 3 {
		return nil, fmt.Errorf("采购日期格式错误，请填 2026-01-05 这类日期")
	}
	year, yearErr := strconv.Atoi(parts[0])
	month, monthErr := strconv.Atoi(parts[1])
	day, dayErr := strconv.Atoi(parts[2])
	if yearErr != nil || monthErr != nil || dayErr != nil {
		return nil, fmt.Errorf("采购日期格式错误，请填 2026-01-05 这类日期")
	}
	if year < 100 {
		year += 2000
	}
	if year < 1900 || year > 2100 {
		return nil, fmt.Errorf("采购日期年份须在 1900-2100 之间")
	}
	parsed := timeutil.NewDate(time.Date(year, time.Month(month), day, 0, 0, 0, 0, timeutil.Loc))
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day {
		return nil, fmt.Errorf("采购日期格式错误，请填 2026-01-05 这类日期")
	}
	return &parsed, nil
}

func parseImportPrice(value string) (*decimal.Decimal, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return nil, nil
	}
	text = strings.NewReplacer(",", "", "，", "", " ", "", "¥", "", "￥", "", "元", "", "RMB", "", "rmb", "").Replace(text)
	price, err := decimal.NewFromString(text)
	if err != nil || price.IsNegative() {
		return nil, fmt.Errorf("采购金额格式错误，请填非负数字")
	}
	maxPrice := decimal.NewFromInt(1000000000000)
	if price.GreaterThanOrEqual(maxPrice) {
		return nil, fmt.Errorf("采购金额超出范围（最大支持千亿级）")
	}
	return &price, nil
}

func transitionTarget(action, from string) (string, bool) {
	switch action {
	case "claim":
		return statusClaimed, from == statusAvailable
	case "borrow":
		return statusBorrowed, from == statusAvailable
	case "return":
		return statusAvailable, from == statusClaimed || from == statusBorrowed
	case "maintenance":
		return statusMaintenance, from == statusAvailable
	case "restore":
		return statusAvailable, from == statusMaintenance
	case "scrap":
		return statusScrapped, from == statusAvailable || from == statusMaintenance
	case "void":
		return statusVoid, from == statusAvailable || from == statusClaimed || from == statusBorrowed || from == statusMaintenance
	default:
		return "", false
	}
}

func safeCSVValue(value string) string {
	probe := value
	for len(probe) > 0 && probe[0] <= 32 {
		probe = probe[1:]
	}
	if strings.HasPrefix(probe, "=") || strings.HasPrefix(probe, "+") ||
		strings.HasPrefix(probe, "-") || strings.HasPrefix(probe, "@") {
		return "'" + value
	}
	return value
}
