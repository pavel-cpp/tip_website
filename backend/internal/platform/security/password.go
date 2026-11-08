// Package security implements password hashing (argon2id with a pepper), random password
// generation and the HS256 JWT issuer/verifier.
package security

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters (OWASP minimum profile): 19 MiB of memory, 2 passes, 1 lane.
const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonKeyLen    = 32
	argonSaltLen   = 16

	// maxConcurrentHashes bounds simultaneous argon2 computations: each one allocates 19 MiB,
	// and the production server has 2 GB of RAM.
	maxConcurrentHashes = 2

	minPepperLen = 32
)

// ErrInvalidHash is returned when a stored hash is not a PHC string this package understands.
var ErrInvalidHash = errors.New("invalid password hash")

// Hasher hashes and verifies passwords with argon2id over an HMAC-SHA256 pepper. The pepper
// is mixed in before hashing, so a leaked database alone cannot be attacked offline.
type Hasher struct {
	peppers map[int][]byte
	current int
	sem     chan struct{}
	// dummy is verified against when the user does not exist, to equalize response time.
	dummy string
}

// NewHasher creates a Hasher. pepper is the current secret with version `version` (>= 1);
// previous holds retired peppers by version so hashes made with them still verify (and
// report needsRehash) during a rotation.
func NewHasher(pepper string, version int, previous map[int]string) (*Hasher, error) {
	if len(pepper) < minPepperLen {
		return nil, errors.New("password pepper must be at least 32 bytes")
	}
	if version < 1 {
		return nil, errors.New("pepper version must be positive")
	}
	h := &Hasher{
		peppers: map[int][]byte{version: []byte(pepper)},
		current: version,
		sem:     make(chan struct{}, maxConcurrentHashes),
	}
	for v, p := range previous {
		if v == version {
			return nil, errors.New("previous pepper reuses the current version")
		}
		h.peppers[v] = []byte(p)
	}
	d, err := h.Hash(context.Background(), "dummy-password-for-timing")
	if err != nil {
		return nil, err
	}
	h.dummy = d
	return h, nil
}

func (h *Hasher) acquire(ctx context.Context) (release func(), err error) {
	select {
	case h.sem <- struct{}{}:
		return func() { <-h.sem }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("wait for hash slot: %w", ctx.Err())
	}
}

func (h *Hasher) key(password string, version int, salt []byte, m, t uint32, p uint8) ([]byte, bool) {
	pepper, ok := h.peppers[version]
	if !ok {
		return nil, false
	}
	mac := hmac.New(sha256.New, pepper)
	mac.Write([]byte(password))
	return argon2.IDKey(mac.Sum(nil), salt, t, m, p, argonKeyLen), true
}

// Hash returns a PHC string:
// $argon2id$v=19$m=19456,t=2,p=1,pv=<pepper version>$<salt>$<hash>.
func (h *Hasher) Hash(ctx context.Context, password string) (string, error) {
	release, err := h.acquire(ctx)
	if err != nil {
		return "", err
	}
	defer release()

	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	sum, _ := h.key(password, h.current, salt, argonMemoryKiB, argonTime, argonThreads)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d,pv=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads, h.current,
		enc.EncodeToString(salt), enc.EncodeToString(sum)), nil
}

type phc struct {
	m, t    uint32
	p       uint8
	pv      int
	salt    []byte
	hash    []byte
	version int
}

func parsePHC(s string) (phc, error) {
	parts := strings.Split(s, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return phc{}, ErrInvalidHash
	}
	var out phc
	if _, err := fmt.Sscanf(parts[2], "v=%d", &out.version); err != nil || out.version != argon2.Version {
		return phc{}, ErrInvalidHash
	}
	out.pv = 1
	for _, kv := range strings.Split(parts[3], ",") {
		k, v, ok := strings.Cut(kv, "=")
		n, err := strconv.ParseUint(v, 10, 32)
		if !ok || err != nil {
			return phc{}, ErrInvalidHash
		}
		switch k {
		case "m":
			out.m = uint32(n)
		case "t":
			out.t = uint32(n)
		case "p":
			if n > 255 {
				return phc{}, ErrInvalidHash
			}
			out.p = uint8(n)
		case "pv":
			out.pv = int(n)
		}
	}
	enc := base64.RawStdEncoding
	var err error
	if out.salt, err = enc.DecodeString(parts[4]); err != nil {
		return phc{}, ErrInvalidHash
	}
	if out.hash, err = enc.DecodeString(parts[5]); err != nil {
		return phc{}, ErrInvalidHash
	}
	// Bound the cost parameters so a corrupted row cannot make us allocate gigabytes.
	if out.m == 0 || out.m > 256*1024 || out.t == 0 || out.t > 10 || out.p == 0 ||
		len(out.salt) == 0 || len(out.hash) != argonKeyLen {
		return phc{}, ErrInvalidHash
	}
	return out, nil
}

// Verify checks password against a stored PHC hash in constant time. needsRehash is true
// when the hash uses outdated parameters or an older pepper; the caller should then store
// a fresh hash after a successful login. An empty hash (unknown user) burns the same CPU
// time as a real check and reports false.
func (h *Hasher) Verify(ctx context.Context, password, encoded string) (ok, needsRehash bool, err error) {
	if encoded == "" {
		_, _, err := h.Verify(ctx, password, h.dummy)
		return false, false, err
	}
	p, err := parsePHC(encoded)
	if err != nil {
		return false, false, err
	}
	release, err := h.acquire(ctx)
	if err != nil {
		return false, false, err
	}
	defer release()

	sum, known := h.key(password, p.pv, p.salt, p.m, p.t, p.p)
	if !known {
		return false, false, fmt.Errorf("%w: unknown pepper version %d", ErrInvalidHash, p.pv)
	}
	if subtle.ConstantTimeCompare(sum, p.hash) != 1 {
		return false, false, nil
	}
	return true, h.needsRehash(p), nil
}

// NeedsRehash reports whether a stored hash should be recomputed with current parameters.
func (h *Hasher) NeedsRehash(encoded string) bool {
	p, err := parsePHC(encoded)
	if err != nil {
		return true
	}
	return h.needsRehash(p)
}

func (h *Hasher) needsRehash(p phc) bool {
	return p.m != argonMemoryKiB || p.t != argonTime || p.p != argonThreads || p.pv != h.current
}
