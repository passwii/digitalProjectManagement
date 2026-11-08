package contact

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func TestMaskIDCard(t *testing.T) {
	cases := []struct {
		value string
		want  string
	}{
		{"", ""},
		{"12345678", "********"},
		{"123456789012345", "123456*****2345"},
		{"110101199001011234", "110101********1234"},
	}
	for _, tc := range cases {
		if got := maskIDCard(tc.value); got != tc.want {
			t.Errorf("maskIDCard(%q) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestEmploymentStatusValidation(t *testing.T) {
	for _, status := range []string{"active", "probation", "leave"} {
		if !isEmploymentStatus(status) {
			t.Errorf("expected %q to be a supported status", status)
		}
	}
	if isEmploymentStatus("terminated") {
		t.Fatal("terminated must not be accepted as an employment status")
	}
}

func TestRegisterRoutesIncludesContactEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterRoutes(router.Group("/api/v1"), (*gorm.DB)(nil))

	routes := make(map[string]bool)
	for _, route := range router.Routes() {
		routes[route.Method+" "+route.Path] = true
	}
	for _, route := range []string{
		http.MethodGet + " /api/v1/contacts",
		http.MethodGet + " /api/v1/contacts/options",
		http.MethodPost + " /api/v1/contacts",
		http.MethodGet + " /api/v1/contacts/:cid",
		http.MethodPatch + " /api/v1/contacts/:cid",
		http.MethodGet + " /api/v1/contacts/:cid/attachments",
		http.MethodPost + " /api/v1/contacts/:cid/attachments",
		http.MethodGet + " /api/v1/contacts/:cid/attachments/:aid/download",
		http.MethodDelete + " /api/v1/contacts/:cid/attachments/:aid",
	} {
		if !routes[route] {
			t.Errorf("missing route %q", route)
		}
	}
}
