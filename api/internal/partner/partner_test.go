package partner

import (
	"math"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func TestPartnerAttachmentCategories(t *testing.T) {
	for _, category := range []string{"qual_cert", "performance", "contract", "other"} {
		if !isPartnerAttachmentCategory(category) {
			t.Errorf("expected %q to be a supported partner attachment category", category)
		}
	}
	if isPartnerAttachmentCategory("id_card") {
		t.Fatal("id_card is not a partner attachment category")
	}
}

func TestPartnerContractAmountValidation(t *testing.T) {
	for _, amount := range []float64{0, 0.01, 1_000_000} {
		if !validPartnerAmount(amount) {
			t.Errorf("expected amount %v to be accepted", amount)
		}
	}
	for _, amount := range []float64{-0.01, math.Inf(1), math.NaN()} {
		if validPartnerAmount(amount) {
			t.Errorf("expected amount %v to be rejected", amount)
		}
	}
}

func TestRegisterRoutesIncludesPartnerEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterRoutes(router.Group("/api/v1"), (*gorm.DB)(nil))

	routes := make(map[string]bool)
	for _, route := range router.Routes() {
		routes[route.Method+" "+route.Path] = true
	}
	for _, route := range []string{
		http.MethodGet + " /api/v1/partners",
		http.MethodPost + " /api/v1/partners",
		http.MethodGet + " /api/v1/partners/:pid",
		http.MethodPatch + " /api/v1/partners/:pid",
		http.MethodDelete + " /api/v1/partners/:pid",
		http.MethodGet + " /api/v1/partners/:pid/contracts",
		http.MethodPost + " /api/v1/partners/:pid/contracts",
		http.MethodPatch + " /api/v1/partners/:pid/contracts/:cid",
		http.MethodDelete + " /api/v1/partners/:pid/contracts/:cid",
		http.MethodGet + " /api/v1/partners/:pid/attachments",
		http.MethodPost + " /api/v1/partners/:pid/attachments",
		http.MethodGet + " /api/v1/partners/:pid/attachments/:aid/download",
		http.MethodDelete + " /api/v1/partners/:pid/attachments/:aid",
	} {
		if !routes[route] {
			t.Errorf("missing route %q", route)
		}
	}
}
