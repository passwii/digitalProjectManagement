package attachment

import (
	"strings"
	"testing"
)

func TestValidateUploadSanitizesFilenameAndAllowsSupportedExtensions(t *testing.T) {
	name, err := ValidateUpload(`..\private\employee.PDF`, 16)
	if err != nil {
		t.Fatal(err)
	}
	if name != "employee.PDF" {
		t.Fatalf("ValidateUpload returned filename %q", name)
	}
}

func TestValidateUploadRejectsUnsupportedAndOversizedFiles(t *testing.T) {
	if _, err := ValidateUpload("payload.exe", 1); err == nil {
		t.Fatal("unsupported file extension must be rejected")
	}
	if _, err := ValidateUpload("document.pdf", MaxUploadSize+1); err == nil ||
		!strings.Contains(err.Error(), "100MB") {
		t.Fatalf("oversized file must return the shared size limit error, got %v", err)
	}
}
