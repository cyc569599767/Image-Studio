package client

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// CurlTransport shells out to curl/curl.exe (parity with the original Python script).
// Useful when the user's machine has TLS/network quirks the Go stdlib can't navigate.
type CurlTransport struct {
	Binary string // path to curl binary, set by PickTransport
}

// BuildCurlConfig returns a curl config snippet carrying sensitive headers.
// It is written to a private temp file so the API key does not appear in argv.
func BuildCurlConfig(apiKey string) string {
	headers := []string{
		"Accept: */*",
		"Content-Type: application/json",
		"Authorization: Bearer " + apiKey,
		"User-Agent: " + UserAgent,
	}
	var b strings.Builder
	for _, header := range headers {
		fmt.Fprintf(&b, "header = %q\n", header)
	}
	return b.String()
}

// BuildCurlArgs returns the curl arguments mirroring Python build_curl_command.
// Exported for testing — tests assert -N, --data-binary @file presence and absence of -o.
func BuildCurlArgs(url, bodyPath, configPath string) []string {
	return []string{
		"-sS",
		"--no-progress-meter",
		"-N",
		"--http1.1",
		"--ssl-no-revoke",
		"--connect-timeout", "30",
		"--max-time", "600",
		"-X", "POST",
		url,
		"--config", configPath,
		"--data-binary", "@" + bodyPath,
	}
}

func (t *CurlTransport) Stream(ctx context.Context, req Request, rawSink io.Writer, progress chan<- string) error {
	if t.Binary == "" {
		bin, err := locateCurl()
		if err != nil {
			return err
		}
		t.Binary = bin
	}

	// Write request body to a temp file (curl's --data-binary @file pattern).
	tmpFile, err := os.CreateTemp("", "gptcodex-request-*.json")
	if err != nil {
		return fmt.Errorf("create temp body: %w", err)
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.Write(req.Payload); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp body: %w", err)
	}
	tmpFile.Close()
	defer os.Remove(tmpPath)

	cfgFile, err := os.CreateTemp("", "gptcodex-curl-*.cfg")
	if err != nil {
		return fmt.Errorf("create curl config: %w", err)
	}
	cfgPath := cfgFile.Name()
	if _, err := cfgFile.WriteString(BuildCurlConfig(req.APIKey)); err != nil {
		cfgFile.Close()
		os.Remove(cfgPath)
		return fmt.Errorf("write curl config: %w", err)
	}
	cfgFile.Close()
	_ = os.Chmod(cfgPath, 0o600)
	defer os.Remove(cfgPath)

	args := BuildCurlArgs(req.URL, tmpPath, cfgPath)
	cmd := exec.CommandContext(ctx, t.Binary, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start curl: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	const initial = 1 << 20
	const max = 8 << 20
	scanner.Buffer(make([]byte, 0, initial), max)
	for scanner.Scan() {
		line := scanner.Bytes()
		if _, err := rawSink.Write(line); err != nil {
			_ = cmd.Process.Kill()
			return fmt.Errorf("write raw: %w", err)
		}
		if _, err := rawSink.Write([]byte("\n")); err != nil {
			_ = cmd.Process.Kill()
			return fmt.Errorf("write raw: %w", err)
		}
		if progress != nil {
			if summary := SummarizeSSELine(string(line)); summary != "" {
				select {
				case progress <- summary:
				default:
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		_ = cmd.Wait()
		return fmt.Errorf("read curl stdout: %w", err)
	}
	if err := cmd.Wait(); err != nil {
		stderrTxt := strings.TrimSpace(stderrBuf.String())
		if stderrTxt == "" {
			stderrTxt = "curl 未返回错误详情"
		}
		return fmt.Errorf("curl 请求失败:%s", stderrTxt)
	}
	return nil
}

// EnsureTempDir returns a directory suitable for stashing temp request bodies
// near a known output directory (so user can collect them when debugging).
// Unused right now but reserved for future debug toggles.
func EnsureTempDir(near string) (string, error) {
	if near == "" {
		return os.TempDir(), nil
	}
	abs, err := filepath.Abs(near)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return "", err
	}
	return abs, nil
}
