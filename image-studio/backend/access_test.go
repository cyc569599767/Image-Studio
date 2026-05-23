package backend

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureManagedReadablePath(t *testing.T) {
	t.Parallel()

	svc := NewService()
	root := t.TempDir()
	svc.addTrustedOutputRoot(root)

	imagesDir := imagesSubdir(root)
	logDir := logSubdir(root)
	if err := os.MkdirAll(imagesDir, secureDirMode); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(logDir, secureDirMode); err != nil {
		t.Fatal(err)
	}

	imagePath := filepath.Join(imagesDir, "a.png")
	if err := os.WriteFile(imagePath, []byte("png"), secureFileMode); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(logDir, "a.txt")
	if err := os.WriteFile(logPath, []byte("log"), secureFileMode); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), secureFileMode); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ensureManagedReadablePath(imagePath, managedImageFile); err != nil {
		t.Fatalf("expected managed image path to pass: %v", err)
	}
	if _, err := svc.ensureManagedReadablePath(logPath, managedRawLogFile); err != nil {
		t.Fatalf("expected managed log path to pass: %v", err)
	}
	if _, err := svc.ensureManagedReadablePath(outside, managedImageFile); err == nil {
		t.Fatalf("expected outside image path to be rejected")
	}
	if _, err := svc.ensureManagedReadablePath(outside, managedRawLogFile); err == nil {
		t.Fatalf("expected outside log path to be rejected")
	}
}
