package security

import (
	"errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

var (
	SecretKey      = "dev-secret-change-me"
	AccessMinutes  = 8 * 60
	RefreshDays    = 7
	ErrInvalidToken = errors.New("invalid token")
	ErrWrongKind   = errors.New("wrong token kind")
)

func Init(secret string) {
	if secret != "" {
		SecretKey = secret
	} else if env := os.Getenv("APP_SECRET"); env != "" {
		SecretKey = env
	}
}

type Claims struct {
	Sub            string `json:"sub"`
	Kind           string `json:"kind"`
	JTI            string `json:"jti"`
	SessionVersion int    `json:"session_version"`
	jwt.RegisteredClaims
}

func HashPassword(raw string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(raw), bcrypt.DefaultCost)
	return string(bytes), err
}

func VerifyPassword(raw, hashed string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hashed), []byte(raw))
	return err == nil
}

func CreateAccessToken(sub string, sessionVersion int) (string, error) {
	return createToken(sub, sessionVersion, time.Duration(AccessMinutes)*time.Minute, "access")
}

func CreateRefreshToken(sub string, sessionVersion int) (string, error) {
	return createToken(sub, sessionVersion, time.Duration(RefreshDays)*24*time.Hour, "refresh")
}

func createToken(sub string, sessionVersion int, ttl time.Duration, kind string) (string, error) {
	now := time.Now().UTC()
	claims := Claims{
		Sub:            sub,
		Kind:           kind,
		JTI:            uuid.New().String(),
		SessionVersion: sessionVersion,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(SecretKey))
}

func DecodeToken(tokenString string, expectedKind string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return []byte(SecretKey), nil
	})
	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}

	if expectedKind != "" && claims.Kind != expectedKind {
		return nil, ErrWrongKind
	}

	return claims, nil
}
