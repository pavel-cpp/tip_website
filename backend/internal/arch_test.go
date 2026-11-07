package internal_test

import (
	"os/exec"
	"strings"
	"testing"
)

const modulePath = "github.com/pavel-cpp/tip_website/backend/"

// layerRule says which module packages (transitively) a layer may depend on. Third-party and
// standard library imports are governed by golangci-lint (depguard), not by this test.
type layerRule struct {
	pattern string   // go list pattern for the layer, relative to backend/
	allowed []string // allowed module-internal prefixes, relative to modulePath
	// stdlibOnly forbids every non-standard-library dependency outside the layer itself.
	stdlibOnly bool
}

var rules = []layerRule{
	{pattern: "./internal/domain/...", allowed: []string{"internal/domain"}, stdlibOnly: true},
	{pattern: "./internal/service/...", allowed: []string{"internal/service", "internal/domain"}, stdlibOnly: true},
	{pattern: "./internal/handler/...", allowed: []string{"internal/handler", "internal/service", "internal/domain", "internal/platform"}},
	{pattern: "./internal/repository/...", allowed: []string{"internal/repository", "internal/domain", "internal/platform"}},
	{pattern: "./internal/platform/...", allowed: []string{"internal/platform", "internal/domain"}},
}

type dep struct {
	path     string
	standard bool
}

func listDeps(t *testing.T, pattern string) []dep {
	t.Helper()
	cmd := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}} {{.Standard}}", pattern)
	cmd.Dir = ".." // the test runs in backend/internal
	out, err := cmd.CombinedOutput()
	if err != nil {
		for _, missing := range []string{"matched no packages", "no Go files", "cannot find", "no such file", "directory prefix"} {
			if strings.Contains(string(out), missing) {
				return nil
			}
		}
		t.Fatalf("go list %s: %v\n%s", pattern, err, out)
	}
	var deps []dep
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 {
			deps = append(deps, dep{path: f[0], standard: f[1] == "true"})
		}
	}
	return deps
}

func hasPrefix(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if path == modulePath+p || strings.HasPrefix(path, modulePath+p+"/") {
			return true
		}
	}
	return false
}

func TestLayering(t *testing.T) {
	for _, r := range rules {
		t.Run(r.pattern, func(t *testing.T) {
			deps := listDeps(t, r.pattern)
			if len(deps) == 0 {
				t.Skip("layer has no packages yet")
			}
			for _, d := range deps {
				switch {
				case d.standard:
				case strings.HasPrefix(d.path, modulePath):
					if !hasPrefix(d.path, r.allowed) {
						t.Errorf("%s: forbidden dependency %s", r.pattern, strings.TrimPrefix(d.path, modulePath))
					}
				case r.stdlibOnly:
					t.Errorf("%s: only the standard library is allowed, found %s", r.pattern, d.path)
				}
			}
		})
	}
}
