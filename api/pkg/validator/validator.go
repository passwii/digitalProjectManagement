package validator

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

func AsNumber(value interface{}, field string, required bool) (*float64, error) {
	if value == nil {
		if required {
			return nil, fmt.Errorf("%s必填", field)
		}
		return nil, nil
	}

	switch v := value.(type) {
	case bool:
		return nil, fmt.Errorf("%s须为数字", field)
	case int:
		f := float64(v)
		return &f, nil
	case int64:
		f := float64(v)
		return &f, nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("%s须为有效数字", field)
		}
		return &v, nil
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			if required {
				return nil, fmt.Errorf("%s必填", field)
			}
			return nil, nil
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("%s须为有效数字", field)
		}
		return &f, nil
	default:
		return nil, fmt.Errorf("%s须为数字", field)
	}
}

func CheckRange(value float64, field string, min, max *float64, exclusiveMin bool) error {
	if min != nil {
		if exclusiveMin && value <= *min {
			return fmt.Errorf("%s须大于 %g", field, *min)
		}
		if !exclusiveMin && value < *min {
			return fmt.Errorf("%s不能小于 %g", field, *min)
		}
	}
	if max != nil && value > *max {
		return fmt.Errorf("%s不能大于 %g", field, *max)
	}
	return nil
}

func CheckProgress(value interface{}, fieldName ...string) (float64, error) {
	fName := "进度"
	if len(fieldName) > 0 {
		fName = fieldName[0]
	}
	num, err := AsNumber(value, fName, true)
	if err != nil {
		return 0, err
	}
	min := 0.0
	max := 100.0
	if err := CheckRange(*num, fName, &min, &max, false); err != nil {
		return 0, err
	}
	return *num, nil
}

func CheckWeight(value interface{}, fieldName ...string) (float64, error) {
	fName := "权重"
	if len(fieldName) > 0 {
		fName = fieldName[0]
	}
	num, err := AsNumber(value, fName, true)
	if err != nil {
		return 0, err
	}
	min := 0.0
	if err := CheckRange(*num, fName, &min, nil, true); err != nil {
		return 0, err
	}
	return *num, nil
}

func CheckAmount(value interface{}, allowZero bool, fieldName ...string) (float64, error) {
	fName := "金额"
	if len(fieldName) > 0 {
		fName = fieldName[0]
	}
	num, err := AsNumber(value, fName, true)
	if err != nil {
		return 0, err
	}
	min := 0.0
	if err := CheckRange(*num, fName, &min, nil, !allowZero); err != nil {
		return 0, err
	}
	return *num, nil
}

func CheckDateRange(start, end *time.Time, startField, endField string) error {
	if start != nil && end != nil && start.After(*end) {
		return fmt.Errorf("%s不能早于%s", endField, startField)
	}
	return nil
}

func CheckChoice(value string, allowed []string, field string) error {
	for _, a := range allowed {
		if a == value {
			return nil
		}
	}
	sort.Strings(allowed)
	return fmt.Errorf("%s须为 %v 之一，收到 '%s'", field, allowed, value)
}
