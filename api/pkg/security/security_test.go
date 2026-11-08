package security

import (
	"testing"
	"github.com/golang-jwt/jwt/v5"
)

func TestSecurity(t *testing.T) {
	Init("test-secret-key-123")
	hash, err := HashPassword("admin123456")
	if err != nil {
		t.Fatalf("hash failed: %v", err)
	}
	if !VerifyPassword("admin123456", hash) {
		t.Fatalf("password verify failed")
	}
	if VerifyPassword("wrong-password", hash) {
		t.Fatalf("wrong password should not verify")
	}

	token, err := CreateAccessToken("42", 1)
	if err != nil {
		t.Fatalf("create token failed: %v", err)
	}
	claims, err := DecodeToken(token, "access")
	if err != nil {
		t.Fatalf("decode token failed: %v", err)
	}
	if claims.Sub != "42" || claims.SessionVersion != 1 {
		t.Fatalf("claims mismatch: %+v", claims)
	}
}

func TestRejectNonHS256Token(t *testing.T) {
	Init("test-secret-key-123")
	// 用不同方法伪造
	claims := Claims{
		Sub:  "1",
		Kind: "access",
		JTI:  "fake",
	}
	token := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	tokenStr, _ := token.SignedString(jwt.UnsafeAllowNoneSignatureType)

	_, err := DecodeToken(tokenStr, "access")
	if err == nil {
		t.Fatalf("expected error for non-HS256 token")
	}
}
