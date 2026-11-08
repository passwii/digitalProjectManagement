package model

import (
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/shopspring/decimal"
)

type EquipmentBatch struct {
	ID               uint              `gorm:"primaryKey" json:"id"`
	Name             string            `gorm:"size:128;not null" json:"name"`
	Source           string            `gorm:"size:255;not null;default:''" json:"source"`
	Supplier         string            `gorm:"size:255;not null;default:''" json:"supplier"`
	PurchaseOrderNo  string            `gorm:"size:128;not null;default:''" json:"purchase_order_no"`
	InvoiceNo        string            `gorm:"size:128;not null;default:''" json:"invoice_no"`
	AcceptanceStatus string            `gorm:"size:24;not null;default:'accepted'" json:"acceptance_status"`
	Note             string            `gorm:"type:text;not null;default:''" json:"note"`
	CreatedBy        uint              `gorm:"not null" json:"created_by"`
	CreatedAt        timeutil.DateTime `gorm:"not null" json:"created_at"`
	Assets           []EquipmentAsset  `gorm:"foreignKey:BatchID" json:"assets,omitempty"`
}

func (EquipmentBatch) TableName() string { return "equipment_batches" }

type EquipmentAsset struct {
	ID                uint              `gorm:"primaryKey" json:"id"`
	Code              string            `gorm:"size:40;unique;not null;index" json:"code"`
	Name              string            `gorm:"size:128;not null" json:"name"`
	CategoryCode      string            `gorm:"size:32;not null;index" json:"category_code"`
	SerialNumber      *string           `gorm:"size:128;unique" json:"serial_number"`
	Brand             string            `gorm:"size:128;not null;default:''" json:"brand"`
	Model             string            `gorm:"size:128;not null;default:''" json:"model"`
	Location          string            `gorm:"size:128;not null;default:''" json:"location"`
	Note              string            `gorm:"type:text;not null;default:''" json:"note"`
	PurchaseDate      *timeutil.Date    `json:"purchase_date"`
	PurchasePrice     *decimal.Decimal  `gorm:"type:numeric(14,2)" json:"purchase_price"`
	Status            string            `gorm:"size:20;not null;default:'available';index" json:"status"`
	HolderID          *uint             `gorm:"index" json:"holder_id"`
	Holder            *User             `gorm:"foreignKey:HolderID" json:"holder,omitempty"`
	DueDate           *timeutil.Date    `json:"due_date"`
	BatchID           *uint             `gorm:"index" json:"batch_id"`
	Batch             *EquipmentBatch   `gorm:"foreignKey:BatchID" json:"batch,omitempty"`
	Quantity          int               `gorm:"not null;default:1" json:"quantity"`
	AvailableQuantity int               `gorm:"not null;default:1" json:"available_quantity"`
	InventoryManaged  bool              `gorm:"not null;default:false" json:"inventory_managed"`
	CreatedBy         uint              `gorm:"not null" json:"created_by"`
	CreatedAt         timeutil.DateTime `gorm:"not null" json:"created_at"`
	UpdatedAt         timeutil.DateTime `gorm:"not null" json:"updated_at"`
}

func (EquipmentAsset) TableName() string { return "equipment_assets" }

type EquipmentEvent struct {
	ID          uint               `gorm:"primaryKey" json:"id"`
	AssetID     uint               `gorm:"not null;index" json:"asset_id"`
	BatchID     *uint              `json:"batch_id"`
	Action      string             `gorm:"size:24;not null" json:"action"`
	FromStatus  *string            `gorm:"size:20" json:"from_status"`
	ToStatus    string             `gorm:"size:20;not null" json:"to_status"`
	ActorID     uint               `gorm:"not null" json:"actor_id"`
	Actor       *User              `gorm:"foreignKey:ActorID" json:"actor,omitempty"`
	HolderID    *uint              `json:"holder_id"`
	Holder      *User              `gorm:"foreignKey:HolderID" json:"holder,omitempty"`
	DueDate     *timeutil.Date     `json:"due_date"`
	Note        string             `gorm:"type:text;not null;default:''" json:"note"`
	Quantity    *int               `json:"quantity"`
	Customer    *string            `gorm:"size:255" json:"customer"`
	Destination *string            `gorm:"size:255" json:"destination"`
	ShippedAt   *timeutil.DateTime `gorm:"index:ix_equipment_events_outbound_time,priority:2" json:"shipped_at"`
	CreatedAt   timeutil.DateTime  `gorm:"not null;index" json:"created_at"`
}

func (EquipmentEvent) TableName() string { return "equipment_events" }
