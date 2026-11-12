package main

import "testing"

func TestVersionWithCommit(t *testing.T) {
	oldVersion, oldCommit := version, commit
	t.Cleanup(func() { version, commit = oldVersion, oldCommit })

	version, commit = "0.2.0+5", "09613d3aabbccddeeff00112233445566778899"
	if got := versionWithCommit(); got != "0.2.0+5 (09613d3)" {
		t.Errorf("got %q", got)
	}
	version, commit = "dev", "none"
	if got := versionWithCommit(); got != "dev" {
		t.Errorf("without a commit the version stays plain, got %q", got)
	}
}
