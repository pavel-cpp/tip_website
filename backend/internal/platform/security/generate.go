package security

import (
	"crypto/rand"
	"fmt"
	"math/big"
)

// tempPasswordAlphabet omits look-alike characters (0/O, 1/l/I) because temporary passwords
// are read from a screen and typed by hand.
const (
	tempPasswordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	tempPasswordLen      = 16
)

// GeneratePassword returns a random 16 character password drawn from an unambiguous alphabet
// using crypto/rand with uniform (bias-free) selection.
func GeneratePassword() (string, error) {
	limit := big.NewInt(int64(len(tempPasswordAlphabet)))
	out := make([]byte, tempPasswordLen)
	for i := range out {
		n, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", fmt.Errorf("generate password: %w", err)
		}
		out[i] = tempPasswordAlphabet[n.Int64()]
	}
	return string(out), nil
}

// RandomPassword adapts GeneratePassword to the generator interface used by services.
type RandomPassword struct{}

// NewPassword returns a fresh temporary password.
func (RandomPassword) NewPassword() (string, error) { return GeneratePassword() }
