package http

import (
	"net/http/httptest"
	"testing"
)

func TestClientIP(t *testing.T) {
	cases := []struct {
		name, peer, xff, want string
	}{
		{"direct public peer ignores the header", "203.0.113.9:5555", "198.51.100.1", "203.0.113.9"},
		{"private peer without header", "172.18.0.5:4000", "", "172.18.0.5"},
		{"a further private hop behind the client is skipped", "172.18.0.5:4000", "198.51.100.7, 172.18.0.1", "198.51.100.7"},
		{"client-prepended junk is ignored", "172.18.0.5:4000", "1.2.3.4, 198.51.100.7, 172.18.0.1", "198.51.100.7"},
		{"only own hops falls back to the peer", "172.18.0.5:4000", "10.0.0.2, 172.18.0.1", "172.18.0.5"},
		{"malformed entry falls back to the peer", "172.18.0.5:4000", "not-an-ip, 172.18.0.1", "172.18.0.5"},
		{"ipv4-mapped ipv6", "[::ffff:172.18.0.5]:4000", "198.51.100.7", "198.51.100.7"},
		{"ipv6 client", "172.18.0.5:4000", "2001:db8::7", "2001:db8::7"},
		{"peer without port", "172.18.0.5", "198.51.100.7", "198.51.100.7"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = c.peer
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			if got := clientIP(r); got != c.want {
				t.Fatalf("clientIP = %q, want %q", got, c.want)
			}
		})
	}
}
