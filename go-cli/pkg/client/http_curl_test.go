package client

import (
	"slices"
	"strings"
	"testing"
)

func TestBuildCurlArgsRequiredFlags(t *testing.T) {
	args := BuildCurlArgs("https://gptcodex.top/v1/responses", "request.json", "headers.cfg")
	if !slices.Contains(args, "-N") {
		t.Errorf("missing -N flag for streaming")
	}
	if !slices.Contains(args, "--data-binary") {
		t.Errorf("missing --data-binary")
	}
	if !slices.Contains(args, "@request.json") {
		t.Errorf("body path arg missing")
	}
	if slices.Contains(args, "-o") {
		t.Errorf("must not redirect to file with -o (streaming to stdout required)")
	}
	if !slices.Contains(args, "--config") || !slices.Contains(args, "headers.cfg") {
		t.Fatalf("curl config file flag missing: %v", args)
	}
	for _, a := range args {
		if a == "Authorization: Bearer sk-test" {
			t.Fatalf("authorization header leaked into argv: %v", args)
		}
	}
	cfg := BuildCurlConfig("sk-test")
	if !slices.Contains(strings.Split(strings.TrimSpace(cfg), "\n"), `header = "Authorization: Bearer sk-test"`) {
		t.Fatalf("authorization header missing from curl config: %q", cfg)
	}
}
