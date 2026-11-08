package timeutil

import (
	"database/sql/driver"
	"fmt"
	"strings"
	"time"
)

var Loc = time.FixedZone("Asia/Shanghai", 8*3600)

func AppNow() time.Time {
	return time.Now().In(Loc)
}

func AppToday() string {
	return AppNow().Format("2006-01-02")
}

func ISO(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.In(Loc).Format(time.RFC3339)
	return &s
}

// DateTime 专门处理带 +08:00 的 JSON 序列化与 PG 无时区时间戳转换
type DateTime struct {
	time.Time
}

func NewDateTime(t time.Time) DateTime {
	return DateTime{Time: t.In(Loc)}
}

func NowDateTime() DateTime {
	return DateTime{Time: AppNow()}
}

func (d DateTime) MarshalJSON() ([]byte, error) {
	if d.IsZero() {
		return []byte("null"), nil
	}
	return []byte(fmt.Sprintf("\"%s\"", d.In(Loc).Format(time.RFC3339))), nil
}

func (d *DateTime) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), "\"")
	if s == "" || s == "null" {
		d.Time = time.Time{}
		return nil
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, l := range layouts {
		if t, err := time.ParseInLocation(l, s, Loc); err == nil {
			d.Time = t.In(Loc)
			return nil
		}
	}
	return fmt.Errorf("invalid datetime format: %s", s)
}

func (d *DateTime) Scan(value interface{}) error {
	if value == nil {
		d.Time = time.Time{}
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		d.Time = time.Date(v.Year(), v.Month(), v.Day(), v.Hour(), v.Minute(), v.Second(), v.Nanosecond(), Loc)
		return nil
	case string:
		return d.UnmarshalJSON([]byte(fmt.Sprintf("\"%s\"", v)))
	case []byte:
		return d.UnmarshalJSON([]byte(fmt.Sprintf("\"%s\"", string(v))))
	default:
		return fmt.Errorf("cannot scan %T into DateTime", value)
	}
}

func (d DateTime) Value() (driver.Value, error) {
	if d.IsZero() {
		return nil, nil
	}
	// 存储 naive 北京时间到 timestamp without time zone 列
	return d.In(Loc).Format("2006-01-02 15:04:05.999999"), nil
}

// Date 处理 YYYY-MM-DD
type Date struct {
	time.Time
}

func NewDate(t time.Time) Date {
	return Date{Time: time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, Loc)}
}

func (d Date) MarshalJSON() ([]byte, error) {
	if d.IsZero() {
		return []byte("null"), nil
	}
	return []byte(fmt.Sprintf("\"%s\"", d.Format("2006-01-02"))), nil
}

func (d *Date) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), "\"")
	if s == "" || s == "null" {
		d.Time = time.Time{}
		return nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, Loc)
	if err != nil {
		return err
	}
	d.Time = t
	return nil
}

func (d *Date) Scan(value interface{}) error {
	if value == nil {
		d.Time = time.Time{}
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		d.Time = time.Date(v.Year(), v.Month(), v.Day(), 0, 0, 0, 0, Loc)
		return nil
	case string:
		return d.UnmarshalJSON([]byte(fmt.Sprintf("\"%s\"", v)))
	case []byte:
		return d.UnmarshalJSON([]byte(fmt.Sprintf("\"%s\"", string(v))))
	default:
		return fmt.Errorf("cannot scan %T into Date", value)
	}
}

func (d Date) Value() (driver.Value, error) {
	if d.IsZero() {
		return nil, nil
	}
	return d.Format("2006-01-02"), nil
}
