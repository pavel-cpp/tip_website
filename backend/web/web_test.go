package web

import (
	"io/fs"
	"testing"
)

func TestFSIsRootedAtDist(t *testing.T) {
	fsys := FS()
	if _, err := fs.Stat(fsys, ".gitkeep"); err != nil {
		t.Fatalf("expected the dist root to hold .gitkeep: %v", err)
	}
	if _, err := fs.Stat(fsys, "dist"); err == nil {
		t.Fatal("FS must be rooted inside dist, not above it")
	}
}
