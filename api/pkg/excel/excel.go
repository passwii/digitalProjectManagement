package excel

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/xuri/excelize/v2"
)

// SafeCSVCell 防止 CSV 公式注入漏洞
func SafeCSVCell(val string) string {
	trimmed := strings.TrimSpace(val)
	if len(trimmed) > 0 {
		c := trimmed[0]
		if c == '=' || c == '+' || c == '-' || c == '@' {
			return "'" + val
		}
	}
	return val
}

// GenerateCSV 生成带 UTF-8 BOM 的 CSV 字节流
func GenerateCSV(headers []string, rows [][]string) ([]byte, error) {
	var buf bytes.Buffer
	// 写入 UTF-8 BOM
	buf.WriteString("\xEF\xBB\xBF")
	w := csv.NewWriter(&buf)

	safeHeaders := make([]string, len(headers))
	for i, h := range headers {
		safeHeaders[i] = SafeCSVCell(h)
	}
	if err := w.Write(safeHeaders); err != nil {
		return nil, err
	}

	for _, r := range rows {
		safeRow := make([]string, len(r))
		for i, cell := range r {
			safeRow[i] = SafeCSVCell(cell)
		}
		if err := w.Write(safeRow); err != nil {
			return nil, err
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// GenerateXLSX 生成 XLSX 字节流
func GenerateXLSX(sheetName string, headers []string, rows [][]string) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()

	if sheetName == "" {
		sheetName = "Sheet1"
	}
	f.SetSheetName("Sheet1", sheetName)

	// 写入表头
	for colIdx, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(colIdx+1, 1)
		f.SetCellStr(sheetName, cell, h)
	}

	// 写入行数据
	for rowIdx, r := range rows {
		for colIdx, cellVal := range r {
			cell, _ := excelize.CoordinatesToCellName(colIdx+1, rowIdx+2)
			f.SetCellStr(sheetName, cell, cellVal)
		}
	}

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ReadRows 读取 CSV 或 XLSX 所有行
func ReadRows(filename string, r io.Reader) ([][]string, error) {
	ext := strings.ToLower(filename)
	if strings.HasSuffix(ext, ".csv") {
		content, err := io.ReadAll(r)
		if err != nil {
			return nil, err
		}
		// 剥除 BOM
		content = bytes.TrimPrefix(content, []byte("\xEF\xBB\xBF"))
		reader := csv.NewReader(bytes.NewReader(content))
		return reader.ReadAll()
	}

	if strings.HasSuffix(ext, ".xlsx") || strings.HasSuffix(ext, ".xls") {
		f, err := excelize.OpenReader(r, excelize.Options{
			UnzipSizeLimit:    100 * 1024 * 1024,
			UnzipXMLSizeLimit: 50 * 1024 * 1024,
		})
		if err != nil {
			return nil, fmt.Errorf("无法打开 Excel 文件: %w", err)
		}
		defer f.Close()

		sheet := f.GetSheetName(0)
		if sheet == "" {
			return nil, errors.New("Excel 文件无工作表")
		}
		return f.GetRows(sheet)
	}

	return nil, fmt.Errorf("不支持的文件格式: %s", filename)
}
