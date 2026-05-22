package backend

import (
	"errors"
	"fmt"
	"strings"

	keyring "github.com/zalando/go-keyring"
)

const keyringServiceName = "Image Studio"

type apiKeyStore interface {
	Get(mode string) (string, error)
	Set(mode, value string) error
	Delete(mode string) error
}

type keyringAPIKeyStore struct{}

func (keyringAPIKeyStore) Get(mode string) (string, error) {
	value, err := keyring.Get(keyringServiceName, keyringUser(mode))
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return value, err
}

func (keyringAPIKeyStore) Set(mode, value string) error {
	return keyring.Set(keyringServiceName, keyringUser(mode), value)
}

func (keyringAPIKeyStore) Delete(mode string) error {
	err := keyring.Delete(keyringServiceName, keyringUser(mode))
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

func keyringUser(mode string) string {
	return "api-key:" + mode
}

func normalizeAPIMode(mode string) (string, error) {
	switch strings.TrimSpace(mode) {
	case "responses", "images":
		return strings.TrimSpace(mode), nil
	default:
		return "", fmt.Errorf("unknown api mode: %s", mode)
	}
}

func (s *Service) GetStoredAPIKey(mode string) (string, error) {
	normalized, err := normalizeAPIMode(mode)
	if err != nil {
		return "", err
	}
	return s.apiKeys.Get(normalized)
}

func (s *Service) SetStoredAPIKey(mode, value string) error {
	normalized, err := normalizeAPIMode(mode)
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return s.apiKeys.Delete(normalized)
	}
	return s.apiKeys.Set(normalized, trimmed)
}
