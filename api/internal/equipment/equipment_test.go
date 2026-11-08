package equipment

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
)

func TestNormalizeHeaderKeySupportsChineseAndSnakeCase(t *testing.T) {
	tests := map[string]string{
		"设备名称":       "设备名称",
		" 资产_编号 ":    "资产编号",
		"采购日期（购买日期）": "采购日期购买日期",
	}

	for input, want := range tests {
		if got := normalizeHeaderKey(input); got != want {
			t.Errorf("normalizeHeaderKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseImportDateAcceptsSupportedChineseFormats(t *testing.T) {
	for _, input := range []string{"2026-01-05", "2026/1/5", "2026年1月5日", "1/5/26", "01/05/2026"} {
		got, err := parseImportDate(input)
		if err != nil {
			t.Fatalf("parseImportDate(%q): %v", input, err)
		}
		if got == nil || got.Format("2006-01-02") != "2026-01-05" {
			t.Errorf("parseImportDate(%q) = %v, want 2026-01-05", input, got)
		}
	}
}

func TestParseImportPriceAcceptsCurrencyAndRejectsNegativeValues(t *testing.T) {
	got, err := parseImportPrice("¥1,200.50")
	if err != nil {
		t.Fatalf("parseImportPrice currency value: %v", err)
	}
	if got == nil || got.String() != "1200.5" {
		t.Errorf("parseImportPrice currency value = %v, want 1200.5", got)
	}

	if _, err := parseImportPrice("-1"); err == nil {
		t.Fatal("parseImportPrice accepted a negative amount")
	}
}

func TestTransitionTargetEnforcesEquipmentStateMachine(t *testing.T) {
	if got, ok := transitionTarget("borrow", "available"); !ok || got != "borrowed" {
		t.Fatalf("available -> borrow = (%q, %v), want (borrowed, true)", got, ok)
	}
	if _, ok := transitionTarget("borrow", "maintenance"); ok {
		t.Fatal("maintenance equipment must not be borrowed")
	}
	if got, ok := transitionTarget("return", "claimed"); !ok || got != "available" {
		t.Fatalf("claimed -> return = (%q, %v), want (available, true)", got, ok)
	}
}

func TestSafeCSVValuePrefixesFormulaAfterControlCharacters(t *testing.T) {
	for _, input := range []string{"=1+1", " \t@SUM(A1:A2)", "\x00-1+1"} {
		got := safeCSVValue(input)
		if got != "'"+input {
			t.Errorf("safeCSVValue(%q) = %q, want apostrophe-prefixed value", input, got)
		}
	}
}

func TestReadImportCSVPreservesPhysicalRowNumbers(t *testing.T) {
	raw := []byte("设备名称,设备分类\n\n电脑,computer\n\"多行\n备注\",computer\n")
	rows, lineNumbers, err := readImportRows("assets.csv", raw)
	if err != nil {
		t.Fatalf("readImportRows: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("readImportRows returned %d records, want header and 2 data rows", len(rows))
	}
	if got, want := lineNumbers, []int{1, 3, 4}; !reflect.DeepEqual(got, want) {
		t.Errorf("CSV source lines = %v, want %v", got, want)
	}
}

func TestImportTemplateXLSXHasLedgerAndInstructionsSheets(t *testing.T) {
	headers := []string{"设备名称", "设备分类"}
	example := []string{"示例设备", "computer"}
	data, err := buildImportTemplateXLSX(headers, example, nil, nil)
	if err != nil {
		t.Fatalf("buildImportTemplateXLSX: %v", err)
	}
	book, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("open generated workbook: %v", err)
	}
	defer book.Close()
	if got, want := book.GetSheetList(), []string{"台账导入", "填写说明"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("template sheets = %v, want %v", got, want)
	}
	if got, _ := book.GetCellValue("台账导入", "A1"); got != "设备名称" {
		t.Errorf("import sheet header = %q, want 设备名称", got)
	}
	if got, _ := book.GetCellValue("填写说明", "A1"); got != "列名" {
		t.Errorf("instructions header = %q, want 列名", got)
	}
}

func TestRegisterRoutesIncludesEveryEquipmentEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterRoutes(router.Group("/api/v1"), nil)

	want := map[string]bool{
		"GET /api/v1/equipment-assets":                           true,
		"GET /api/v1/equipment-assets/overview":                  true,
		"GET /api/v1/equipment-assets/overdue":                   true,
		"GET /api/v1/equipment-assets/statistics":                true,
		"GET /api/v1/equipment-assets/categories":                true,
		"POST /api/v1/equipment-assets/categories":               true,
		"PATCH /api/v1/equipment-assets/categories/:code":        true,
		"DELETE /api/v1/equipment-assets/categories/:code":       true,
		"POST /api/v1/equipment-assets/inbound":                  true,
		"GET /api/v1/equipment-assets/batches":                   true,
		"GET /api/v1/equipment-assets/batches/:batch_id":         true,
		"PATCH /api/v1/equipment-assets/batches/:batch_id":       true,
		"DELETE /api/v1/equipment-assets/batches/:batch_id":      true,
		"POST /api/v1/equipment-assets/batches/:batch_id/accept": true,
		"POST /api/v1/equipment-assets":                          true,
		"GET /api/v1/equipment-assets/export":                    true,
		"GET /api/v1/equipment-assets/import-template":           true,
		"POST /api/v1/equipment-assets/import":                   true,
		"GET /api/v1/equipment-assets/outbounds":                 true,
		"GET /api/v1/equipment-assets/:asset_id":                 true,
		"PATCH /api/v1/equipment-assets/:asset_id":               true,
		"GET /api/v1/equipment-assets/:asset_id/events":          true,
		"GET /api/v1/equipment-assets/:asset_id/delete-check":    true,
		"DELETE /api/v1/equipment-assets/:asset_id":              true,
		"POST /api/v1/equipment-assets/:asset_id/claim":          true,
		"POST /api/v1/equipment-assets/:asset_id/borrow":         true,
		"POST /api/v1/equipment-assets/:asset_id/return":         true,
		"POST /api/v1/equipment-assets/:asset_id/maintenance":    true,
		"POST /api/v1/equipment-assets/:asset_id/restore":        true,
		"POST /api/v1/equipment-assets/:asset_id/scrap":          true,
		"POST /api/v1/equipment-assets/:asset_id/void":           true,
		"POST /api/v1/equipment-assets/:asset_id/outbound":       true,
	}

	routes := router.Routes()
	if len(routes) != len(want) {
		t.Fatalf("registered %d routes, want %d", len(routes), len(want))
	}
	for _, route := range routes {
		key := route.Method + " " + route.Path
		if !want[key] {
			t.Errorf("unexpected equipment route %q", key)
		}
		delete(want, key)
	}
	for route := range want {
		t.Errorf("missing equipment route %q", route)
	}
}
