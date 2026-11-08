package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func TestFinanceHeadersAllowedByCORSPreflight(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(cors.New(buildCORSConfig([]string{"https://frontend.example"})))
	router.POST("/api/v1/finance/periods/:id/close", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/finance/periods/1/close", nil)
	req.Header.Set("Origin", "https://frontend.example")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	req.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type, X-Account-Book, If-Match, X-Reopen-Period")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want %d; body=%s", recorder.Code, http.StatusNoContent, recorder.Body.String())
	}
	allowed := strings.ToLower(recorder.Header().Get("Access-Control-Allow-Headers"))
	for _, header := range []string{"authorization", "content-type", "x-account-book", "if-match", "x-reopen-period"} {
		if !strings.Contains(allowed, header) {
			t.Fatalf("Access-Control-Allow-Headers = %q, missing %q", allowed, header)
		}
	}
}
