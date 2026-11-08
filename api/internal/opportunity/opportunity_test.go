package opportunity

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func TestNextOpportunityCode(t *testing.T) {
	cases := []struct {
		year int
		last string
		want string
	}{
		{2026, "", "OPP-2026-0001"},
		{2026, "OPP-2026-0009", "OPP-2026-0010"},
		{2027, "OPP-2026-0999", "OPP-2027-0001"},
		{2026, "OPP-2026-bad", "OPP-2026-0001"},
	}
	for _, tc := range cases {
		if got := nextOpportunityCode(tc.year, tc.last); got != tc.want {
			t.Errorf("nextOpportunityCode(%d, %q) = %q, want %q", tc.year, tc.last, got, tc.want)
		}
	}
}

func TestNextOpportunityCodeScansOnlyValidCodesForTheYear(t *testing.T) {
	codes := []string{
		"OPP-2026-0002",
		"OPP-2026-0011",
		"OPP-2026-invalid",
		"OPP-2025-9000",
	}
	if got := nextOpportunityCodeForCodes(2026, codes); got != "OPP-2026-0012" {
		t.Fatalf("nextOpportunityCodeForCodes returned %q", got)
	}
}

func TestOpportunityValidation(t *testing.T) {
	for _, stage := range []string{"new", "qualified", "proposal", "negotiation", "won", "lost"} {
		if !isOpportunityStage(stage) {
			t.Errorf("expected stage %q to be supported", stage)
		}
	}
	if isOpportunityStage("unknown") {
		t.Fatal("unknown stage must be rejected")
	}
	for _, amount := range []float64{0, 0.01, 10_000_000} {
		if !validOpportunityAmount(amount) {
			t.Errorf("expected amount %v to be accepted", amount)
		}
	}
	if validOpportunityAmount(-1) {
		t.Fatal("negative opportunity amounts must be rejected")
	}
}

func TestRegisterRoutesIncludesOpportunityEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterRoutes(router.Group("/api/v1"), (*gorm.DB)(nil))

	routes := make(map[string]bool)
	for _, route := range router.Routes() {
		routes[route.Method+" "+route.Path] = true
	}
	for _, route := range []string{
		http.MethodGet + " /api/v1/opportunities",
		http.MethodPost + " /api/v1/opportunities",
		http.MethodGet + " /api/v1/opportunities/:oid",
		http.MethodPatch + " /api/v1/opportunities/:oid",
		http.MethodDelete + " /api/v1/opportunities/:oid",
	} {
		if !routes[route] {
			t.Errorf("missing route %q", route)
		}
	}
}
