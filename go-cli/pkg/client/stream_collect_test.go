package client

import (
	"encoding/base64"
	"testing"
)

func TestResponseCollectorExtractsFinalAndPartial(t *testing.T) {
	t.Parallel()

	pngB64 := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfake"))

	t.Run("final", func(t *testing.T) {
		c := newResponseCollector(nil)
		_, err := c.Write([]byte("data: {\"type\":\"response.created\"}\n"))
		if err != nil {
			t.Fatal(err)
		}
		_, err = c.Write([]byte("data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"image_generation_call\",\"result\":\"" + pngB64 + "\"}}\n"))
		if err != nil {
			t.Fatal(err)
		}
		got, err := c.result()
		if err != nil {
			t.Fatalf("collector result: %v", err)
		}
		if got.ImageB64 != pngB64 || got.SourceEvent != "final" {
			t.Fatalf("unexpected final result: %+v", got)
		}
	})

	t.Run("partial fallback", func(t *testing.T) {
		c := newResponseCollector(nil)
		_, err := c.Write([]byte("data: {\"type\":\"response.image_generation_call.partial_image\",\"partial_image_b64\":\"" + pngB64 + "\"}\n"))
		if err != nil {
			t.Fatal(err)
		}
		got, err := c.result()
		if err != nil {
			t.Fatalf("collector result: %v", err)
		}
		if got.ImageB64 != pngB64 || got.SourceEvent != "partial" {
			t.Fatalf("unexpected partial result: %+v", got)
		}
	})
}
