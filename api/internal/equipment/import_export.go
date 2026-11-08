package equipment

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/excel"
	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
	"gorm.io/gorm"
)

var fieldLabels = map[string]string{
	"code": "资产编号", "name": "设备名称", "category_code": "设备分类",
	"serial_number": "序列号", "brand": "品牌", "model": "型号",
	"location": "存放位置", "note": "备注", "purchase_date": "采购日期",
	"purchase_price": "采购金额", "status": "设备状态", "holder_id": "使用人",
	"due_date": "归还日期", "batch_id": "所属批次",
}

var exportFields = []string{
	"code", "name", "category_code", "serial_number", "brand", "model", "location",
	"purchase_date", "purchase_price", "status", "holder_id", "due_date", "batch_id", "note",
}

var importFields = []string{
	"name", "category_code", "serial_number", "brand", "model", "location",
	"purchase_date", "purchase_price", "note",
}

var importIgnoredFields = []string{"code", "status", "holder_id", "due_date", "batch_id"}

var fieldHints = map[string]string{
	"name":           "必填。设备名称。",
	"category_code":  "必填。填分类名称（如「电脑」），也接受分类编码（如 computer）。",
	"serial_number":  "选填。厂商序列号，填了则全库不可重复。",
	"brand":          "选填。品牌。",
	"model":          "选填。型号。",
	"location":       "选填。存放位置。",
	"purchase_date":  "选填。支持 2026-01-05、2026/1/5、2026年1月5日。",
	"purchase_price": "选填。填数字即可，支持 ¥1,200.00，不能为负数。",
	"note":           "选填。备注。",
}

var exportStatusLabels = map[string]string{
	statusPendingAcceptance: "待验收", statusAvailable: "可用",
	statusClaimed: "已领用", statusBorrowed: "借用中",
	statusMaintenance: "维修中", statusScrapped: "已报废", statusVoid: "已作废",
}

var importHeaderAliases = buildImportHeaderAliases()

type importRowError struct {
	Row     int    `json:"row"`
	Message string `json:"message"`
}

type parsedImportRow struct {
	Asset assetInput
	Row   int
}

func buildImportHeaderAliases() map[string]string {
	aliases := make(map[string]string, len(fieldLabels)*2)
	for field, label := range fieldLabels {
		aliases[normalizeHeaderKey(field)] = field
		aliases[normalizeHeaderKey(label)] = field
	}
	for alias, field := range map[string]string{
		"分类": "category_code", "分类名称": "category_code", "分类编码": "category_code", "资产分类": "category_code",
		"名称": "name", "设备": "name", "物品名称": "name",
		"编号": "code", "资产编码": "code",
		"购买日期": "purchase_date", "购入日期": "purchase_date", "购置日期": "purchase_date",
		"金额": "purchase_price", "价格": "purchase_price", "购置金额": "purchase_price",
		"序号": "serial_number", "持有人": "holder_id", "使用人姓名": "holder_id",
		"状态": "status", "备注信息": "note",
	} {
		aliases[normalizeHeaderKey(alias)] = field
	}
	return aliases
}

func exportDisposition(stem, extension string) string {
	encoded := strings.ReplaceAll(url.QueryEscape(stem+"."+extension), "+", "%20")
	return fmt.Sprintf("attachment; filename=equipment_assets.%s; filename*=UTF-8''%s", extension, encoded)
}

func exportCell(asset model.EquipmentAsset, field string, categories map[string]string, users map[uint]string, batches map[uint]string) string {
	switch field {
	case "category_code":
		if label := categories[asset.CategoryCode]; label != "" {
			return label
		}
		return asset.CategoryCode
	case "serial_number":
		if asset.SerialNumber != nil {
			return *asset.SerialNumber
		}
	case "brand":
		return asset.Brand
	case "model":
		return asset.Model
	case "location":
		return asset.Location
	case "note":
		return asset.Note
	case "purchase_date":
		if asset.PurchaseDate != nil && !asset.PurchaseDate.IsZero() {
			return asset.PurchaseDate.Format("2006-01-02")
		}
	case "purchase_price":
		if asset.PurchasePrice != nil {
			return asset.PurchasePrice.String()
		}
	case "status":
		if label := exportStatusLabels[asset.Status]; label != "" {
			return label
		}
		return asset.Status
	case "holder_id":
		if asset.HolderID != nil {
			return users[*asset.HolderID]
		}
	case "due_date":
		if asset.DueDate != nil && !asset.DueDate.IsZero() {
			return asset.DueDate.Format("2006-01-02")
		}
	case "batch_id":
		if asset.BatchID != nil {
			return batches[*asset.BatchID]
		}
	default:
		if field == "code" {
			return asset.Code
		}
		if field == "name" {
			return asset.Name
		}
	}
	return ""
}

func (h *Handler) exportAssets(c *gin.Context) {
	format := strings.ToLower(strings.TrimSpace(c.DefaultQuery("format", "csv")))
	if format != "csv" && format != "xlsx" {
		badRequest(c, "仅支持 csv 或 xlsx")
		return
	}
	var assets []model.EquipmentAsset
	if err := h.DB.Order("id ASC").Find(&assets).Error; err != nil {
		internalError(c, "设备台账导出失败")
		return
	}

	var categoryRows []model.Dict
	if err := h.DB.Where("type = ?", "equipment_category").Find(&categoryRows).Error; err != nil {
		internalError(c, "设备分类查询失败")
		return
	}
	categories := make(map[string]string, len(categoryRows))
	for _, row := range categoryRows {
		categories[row.Code] = row.Label
	}
	holderIDs := make([]uint, 0)
	batchIDs := make([]uint, 0)
	holderSeen := make(map[uint]bool)
	batchSeen := make(map[uint]bool)
	for _, asset := range assets {
		if asset.HolderID != nil && !holderSeen[*asset.HolderID] {
			holderIDs = append(holderIDs, *asset.HolderID)
			holderSeen[*asset.HolderID] = true
		}
		if asset.BatchID != nil && !batchSeen[*asset.BatchID] {
			batchIDs = append(batchIDs, *asset.BatchID)
			batchSeen[*asset.BatchID] = true
		}
	}
	users := make(map[uint]string, len(holderIDs))
	if len(holderIDs) > 0 {
		var rows []model.User
		if err := h.DB.Where("id IN ?", holderIDs).Find(&rows).Error; err != nil {
			internalError(c, "设备持有人查询失败")
			return
		}
		for _, row := range rows {
			users[row.ID] = row.RealName
		}
	}
	batches := make(map[uint]string, len(batchIDs))
	if len(batchIDs) > 0 {
		var rows []model.EquipmentBatch
		if err := h.DB.Where("id IN ?", batchIDs).Find(&rows).Error; err != nil {
			internalError(c, "设备批次查询失败")
			return
		}
		for _, row := range rows {
			batches[row.ID] = fmt.Sprintf("%s · 批次 #%d", row.Name, row.ID)
		}
	}

	headers := make([]string, 0, len(exportFields))
	for _, field := range exportFields {
		headers = append(headers, fieldLabels[field])
	}
	rows := make([][]string, 0, len(assets))
	for _, asset := range assets {
		row := make([]string, 0, len(exportFields))
		for _, field := range exportFields {
			row = append(row, exportCell(asset, field, categories, users, batches))
		}
		rows = append(rows, row)
	}

	var (
		content       []byte
		contentType   string
		generationErr error
	)
	if format == "csv" {
		for rowIndex := range rows {
			for columnIndex := range rows[rowIndex] {
				rows[rowIndex][columnIndex] = safeCSVValue(rows[rowIndex][columnIndex])
			}
		}
		content, generationErr = excel.GenerateCSV(headers, rows)
		contentType = "text/csv; charset=utf-8"
	} else {
		content, generationErr = excel.GenerateXLSX("设备台账", headers, rows)
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	if generationErr != nil || content == nil {
		internalError(c, "设备台账文件生成失败")
		return
	}
	user := currentUser(c)
	if user == nil {
		return
	}
	if err := audit.WriteAudit(h.DB, &user.ID, "export_equipment", "equipment_assets", "",
		fmt.Sprintf("count=%d,format=%s", len(rows), format), c.ClientIP()); err != nil {
		internalError(c, errAudit.Error())
		return
	}
	c.Header("Content-Disposition", exportDisposition("设备台账", format))
	c.Data(http.StatusOK, contentType, content)
}

func exampleImportRow() map[string]string {
	return map[string]string{
		"name":           "示例笔记本电脑（导入前请删除本行）",
		"category_code":  "",
		"serial_number":  "SN-EXAMPLE-0001",
		"brand":          "示例品牌",
		"model":          "Model-A",
		"location":       "总部 3 楼",
		"purchase_date":  "",
		"purchase_price": "6800",
		"note":           "示例行",
	}
}

func (h *Handler) importTemplate(c *gin.Context) {
	format := strings.ToLower(strings.TrimSpace(c.DefaultQuery("format", "xlsx")))
	if format != "csv" && format != "xlsx" {
		badRequest(c, "仅支持 csv 或 xlsx")
		return
	}
	var categories []model.Dict
	if err := h.DB.Where("type = ?", "equipment_category").Order("sort ASC").Order("id ASC").Find(&categories).Error; err != nil {
		internalError(c, "设备分类查询失败")
		return
	}
	categoryLabels := make([]string, 0, len(categories))
	for _, category := range categories {
		categoryLabels = append(categoryLabels, category.Label)
	}
	example := exampleImportRow()
	if len(categories) == 0 {
		example["category_code"] = "（请先在「分类维护」中创建分类）"
	}
	headers := make([]string, 0, len(importFields))
	exampleRow := make([]string, 0, len(importFields))
	for _, field := range importFields {
		headers = append(headers, fieldLabels[field])
		exampleRow = append(exampleRow, example[field])
	}

	var (
		content       []byte
		contentType   string
		generationErr error
	)
	if format == "csv" {
		content, generationErr = excel.GenerateCSV(headers, [][]string{exampleRow})
		contentType = "text/csv; charset=utf-8"
	} else {
		content, generationErr = buildImportTemplateXLSX(headers, exampleRow, categories, categoryLabels)
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	if generationErr != nil || content == nil {
		internalError(c, "设备导入模板生成失败")
		return
	}
	user := currentUser(c)
	if user == nil {
		return
	}
	if err := audit.WriteAudit(h.DB, &user.ID, "download_equipment_template", "equipment_assets", "",
		"format="+format, c.ClientIP()); err != nil {
		internalError(c, errAudit.Error())
		return
	}
	c.Header("Content-Disposition", exportDisposition("设备台账导入模板", format))
	c.Data(http.StatusOK, contentType, content)
}

func buildImportTemplateXLSX(headers, example []string, categories []model.Dict, categoryLabels []string) ([]byte, error) {
	book := excelize.NewFile()
	defer book.Close()
	if err := book.SetSheetName("Sheet1", "台账导入"); err != nil {
		return nil, err
	}
	if err := book.SetSheetRow("台账导入", "A1", &headers); err != nil {
		return nil, err
	}
	if err := book.SetSheetRow("台账导入", "A2", &example); err != nil {
		return nil, err
	}
	for column, width := range map[string]float64{
		"A": 12, "B": 30, "C": 18, "D": 14, "E": 18,
		"F": 18, "G": 16, "H": 16, "I": 30,
	} {
		if err := book.SetColWidth("台账导入", column, column, width); err != nil {
			return nil, err
		}
	}
	if err := book.SetPanes("台账导入", &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2"}); err != nil {
		return nil, err
	}

	_, err := book.NewSheet("填写说明")
	if err != nil {
		return nil, err
	}
	if err := book.SetSheetRow("填写说明", "A1", &[]string{"列名", "是否必填", "填写说明"}); err != nil {
		return nil, err
	}
	for index, field := range importFields {
		required := "选填"
		if field == "name" || field == "category_code" {
			required = "必填"
		}
		row := []any{fieldLabels[field], required, fieldHints[field]}
		cell, _ := excelize.CoordinatesToCellName(1, index+2)
		if err := book.SetSheetRow("填写说明", cell, &row); err != nil {
			return nil, err
		}
	}
	row := []any{"", "", "导入时按表头识别列，列顺序随意，多余的列会被忽略。"}
	if err := book.SetSheetRow("填写说明", "A11", &row); err != nil {
		return nil, err
	}
	categoryRow := []any{"设备分类可选值", "", strings.Join(categoryLabels, "、")}
	if len(categories) == 0 {
		categoryRow[2] = "（暂无，请先到「分类维护」创建）"
	}
	if err := book.SetSheetRow("填写说明", "A12", &categoryRow); err != nil {
		return nil, err
	}
	for column, width := range map[string]float64{"A": 20, "B": 12, "C": 64} {
		if err := book.SetColWidth("填写说明", column, column, width); err != nil {
			return nil, err
		}
	}
	var buffer bytes.Buffer
	if err := book.Write(&buffer); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func readImportRows(filename string, raw []byte) ([][]string, []int, error) {
	if strings.EqualFold(filepath.Ext(filename), ".csv") {
		reader := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(raw, []byte("\xEF\xBB\xBF"))))
		reader.FieldsPerRecord = -1
		var rows [][]string
		var lineNumbers []int
		for {
			row, err := reader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, nil, err
			}
			line, _ := reader.FieldPos(0)
			rows = append(rows, row)
			lineNumbers = append(lineNumbers, line)
		}
		return rows, lineNumbers, nil
	}
	rows, err := excel.ReadRows(filename, bytes.NewReader(raw))
	if err != nil {
		return nil, nil, err
	}
	lineNumbers := make([]int, len(rows))
	for index := range rows {
		lineNumbers[index] = index + 1
	}
	return rows, lineNumbers, nil
}

func (h *Handler) importAssets(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		badRequest(c, "请选择 CSV 或 XLSX 文件")
		return
	}
	opened, err := file.Open()
	if err != nil {
		badRequest(c, "文件无法读取")
		return
	}
	defer opened.Close()
	raw, err := io.ReadAll(io.LimitReader(opened, 5_000_001))
	if err != nil {
		badRequest(c, "文件无法读取")
		return
	}
	if len(raw) > 5_000_000 {
		badRequest(c, "文件超过 5 MB")
		return
	}
	filename := filepath.Base(strings.ReplaceAll(file.Filename, "\\", "/"))
	extension := strings.ToLower(filepath.Ext(filename))
	if extension != ".csv" && extension != ".xlsx" {
		badRequest(c, "仅支持 csv 或 xlsx")
		return
	}
	rows, lineNumbers, err := readImportRows(filename, raw)
	if err != nil {
		badRequest(c, "文件无法读取")
		return
	}
	if len(rows) < 2 {
		badRequest(c, "文件没有任何数据行，请确认已按模板填写并保存")
		return
	}

	var categories []model.Dict
	if err := h.DB.Where("type = ?", "equipment_category").Find(&categories).Error; err != nil {
		internalError(c, "设备分类查询失败")
		return
	}
	categoryNames := make(map[string]string, len(categories))
	for _, category := range categories {
		categoryNames[category.Code] = category.Label
	}

	columns := make(map[string]int)
	unknown := make([]string, 0)
	for index, title := range rows[0] {
		title = strings.TrimSpace(title)
		if title == "" {
			continue
		}
		field, ok := importHeaderAliases[normalizeHeaderKey(title)]
		if !ok {
			unknown = append(unknown, title)
			continue
		}
		if _, exists := columns[field]; !exists {
			columns[field] = index
		}
	}
	for _, required := range []string{"name", "category_code"} {
		if _, ok := columns[required]; !ok {
			badRequest(c, fmt.Sprintf("文件缺少必需列「%s」，请下载「设备台账导入模板」后按中文表头填写", fieldLabels[required]))
			return
		}
	}

	getCell := func(row []string, field string) string {
		index, ok := columns[field]
		if !ok || index >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[index])
	}
	rowErrors := make([]importRowError, 0)
	parsed := make([]parsedImportRow, 0, len(rows)-1)
	seenSerials := make(map[string]struct{})
	for index, row := range rows[1:] {
		rowNumber := lineNumbers[index+1]
		nonEmpty := false
		for _, value := range row {
			if strings.TrimSpace(value) != "" {
				nonEmpty = true
				break
			}
		}
		if !nonEmpty {
			continue
		}
		input := assetInput{
			Name:         strings.TrimSpace(getCell(row, "name")),
			CategoryCode: resolveImportCategory(getCell(row, "category_code"), categoryNames),
			SerialNumber: getCell(row, "serial_number"),
			Brand:        getCell(row, "brand"), Model: getCell(row, "model"),
			Location: getCell(row, "location"), Note: getCell(row, "note"),
		}
		if input.Name == "" {
			rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: "设备名称必填"})
			continue
		}
		if input.CategoryCode == "" {
			rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: "设备分类必填"})
			continue
		}
		date, parseErr := parseImportDate(getCell(row, "purchase_date"))
		if parseErr != nil {
			rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: parseErr.Error()})
			continue
		}
		price, parseErr := parseImportPrice(getCell(row, "purchase_price"))
		if parseErr != nil {
			rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: parseErr.Error()})
			continue
		}
		input.PurchaseDate = date
		input.PurchasePrice = price
		input.Quantity = 1
		if input.SerialNumber != "" {
			if _, exists := seenSerials[input.SerialNumber]; exists {
				rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: "文件中设备序列号重复"})
				continue
			}
		}
		message, validationErr := validateAssetInput(h.DB, &input, nil)
		if validationErr != nil {
			if apiErr, ok := validationErr.(*equipmentError); ok {
				rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: apiErr.detail})
			} else {
				internalError(c, "设备导入资料校验失败")
				return
			}
			continue
		}
		if message != "" {
			rowErrors = append(rowErrors, importRowError{Row: rowNumber, Message: message})
			continue
		}
		if input.SerialNumber != "" {
			seenSerials[input.SerialNumber] = struct{}{}
		}
		parsed = append(parsed, parsedImportRow{Asset: input, Row: rowNumber})
	}
	if len(rowErrors) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": gin.H{
			"errors": rowErrors, "message": fmt.Sprintf("共 %d 行导入失败，请修正后重新导入", len(rowErrors)),
		}})
		return
	}
	if len(parsed) == 0 {
		badRequest(c, "文件中没有可导入的设备行")
		return
	}

	batchID, err := parseOptionalID(c.PostForm("batch_id"), "batch_id")
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	batchName := strings.TrimSpace(c.PostForm("batch_name"))
	if (batchID != nil && batchName != "") || (batchID == nil && batchName == "") {
		badRequest(c, "请选择已有批次，或填写新批次名称")
		return
	}
	acceptanceStatus := batchAccepted
	if batchID == nil {
		acceptanceStatus, err = validateAcceptanceStatus(strings.TrimSpace(c.DefaultPostForm("acceptance_status", batchAccepted)))
		if err != nil {
			badRequest(c, err.Error())
			return
		}
	}
	batchInput := inboundInput{
		Name: batchName, BatchID: batchID, Source: strings.TrimSpace(c.PostForm("source")),
		Supplier:         strings.TrimSpace(c.PostForm("supplier")),
		PurchaseOrderNo:  strings.TrimSpace(c.PostForm("purchase_order_no")),
		InvoiceNo:        strings.TrimSpace(c.PostForm("invoice_no")),
		AcceptanceStatus: acceptanceStatus, Note: strings.TrimSpace(c.PostForm("note")),
	}
	if batchInput.Source == "" && batchID == nil {
		batchInput.Source = "导入 " + filename
	}

	user := currentUser(c)
	if user == nil {
		return
	}
	var batch model.EquipmentBatch
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if batchID != nil {
			batch, err = findBatch(tx, *batchID, true)
			if err != nil {
				return err
			}
			if err := checkBatchType(tx, batch.ID, false); err != nil {
				return err
			}
		} else {
			batch, err = createBatch(tx, user.ID, &batchInput)
			if err != nil {
				return err
			}
		}
		status := statusAvailable
		if batch.AcceptanceStatus == batchPendingAcceptance {
			status = statusPendingAcceptance
		}
		for _, row := range parsed {
			if _, err := createAssetRecord(tx, row.Asset, user.ID, &batch.ID, status, "import"); err != nil {
				return err
			}
		}
		return auditCommit(tx, c, user.ID, "import_equipment", "equipment_batches",
			strconv.FormatUint(uint64(batch.ID), 10), fmt.Sprintf("count=%d", len(parsed)))
	})
	if err != nil {
		writeEquipmentError(c, err, "设备导入失败")
		return
	}

	result := gin.H{"batch_id": batch.ID, "batch_name": batch.Name, "created": len(parsed)}
	ignored := make([]string, 0)
	for _, field := range importIgnoredFields {
		if _, exists := columns[field]; exists {
			ignored = append(ignored, fieldLabels[field])
		}
	}
	if len(unknown) > 0 || len(ignored) > 0 {
		result["ignored_columns"] = gin.H{"未识别": unknown, "仅导出用(导入时忽略)": ignored}
	}
	c.JSON(http.StatusOK, result)
}

func resolveImportCategory(value string, categories map[string]string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if _, ok := categories[value]; ok {
		return value
	}
	for code, label := range categories {
		if label == value {
			return code
		}
	}
	return value
}

func parseOptionalID(raw, field string) (*uint, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	id, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || id == 0 {
		return nil, fmt.Errorf("%s 须为正整数", field)
	}
	value := uint(id)
	return &value, nil
}
