package client

// images_api.go — 适配标准的 OpenAI Images API:
//   POST {base}/v1/images/generations  (JSON,文生图)
//   POST {base}/v1/images/edits        (multipart/form-data,图生图)
//
// 与 Responses API 路径(client.go / sse.go)的最大区别:
//   - 一次性 JSON 响应,无 SSE,因此无法做流式保活;Cloudflare 524 风险更高
//   - 多图编辑能力受上游约束(OpenAI 官方仅接受 1 张 image,部分中转站允许 image[] 数组),
//     为最大兼容,这里默认只取第一张源图;如果上游支持多张,可后续扩展
//   - response_format 固定为 b64_json,这样和 Responses API 的下游处理保持一致

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type imagesAPIDatum struct {
	B64JSON       string `json:"b64_json"`
	URL           string `json:"url"`
	RevisedPrompt string `json:"revised_prompt"`
}

type imagesAPIResponse struct {
	Created int              `json:"created"`
	Data    []imagesAPIDatum `json:"data"`
	Error   *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error,omitempty"`
}

// RequestImagesAPI executes a single (no-retry) request against the standard
// OpenAI Images API and returns the parsed image. Raw response body is teed
// to rawSink so callers can dump it for debugging.
func RequestImagesAPI(
	ctx context.Context,
	opts Options,
	rawSink io.Writer,
	onProgress func(stage string, elapsedSeconds int, bytesReceived int64),
) (ImageResult, error) {
	if strings.TrimSpace(opts.APIKey) == "" {
		return ImageResult{}, ErrEmptyAPIKey
	}
	if strings.TrimSpace(opts.Prompt) == "" {
		return ImageResult{}, ErrEmptyPrompt
	}

	baseURL := strings.TrimSpace(opts.BaseURL)
	if baseURL == "" {
		return ImageResult{}, errors.New("未配置上游 BASE_URL,请在「设置 → 上游 BASE_URL」中填入兼容 OpenAI Images API 的中转站地址")
	}
	baseURL, err := ValidateBaseURL(baseURL)
	if err != nil {
		return ImageResult{}, err
	}

	model := opts.ImageModelID
	if model == "" {
		model = ImageModel
	}
	size := opts.Size
	if size == "" {
		size = DefaultSize
	}
	quality := opts.Quality
	if quality == "" {
		quality = DefaultQuality
	}
	outputFormat := opts.OutputFormat
	if outputFormat == "" {
		outputFormat = OutputFormat
	}

	var (
		url         string
		body        io.Reader
		contentType string
	)

	if opts.Mode == ModeEdit {
		paths := opts.imageSourcePathsForEdit()
		if len(paths) == 0 {
			return ImageResult{}, errors.New("图生图模式需要至少一张源图(请在面板里添加参考图)")
		}
		multipartBuf, mpType, err := buildEditsMultipart(paths, opts.MaskB64, opts.Prompt, model, size, quality, outputFormat, opts.NegativePrompt, opts.Seed)
		if err != nil {
			return ImageResult{}, err
		}
		url = baseURL + "/v1/images/edits"
		body = multipartBuf
		contentType = mpType
	} else {
		payload := map[string]any{
			"model":           model,
			"prompt":          opts.Prompt,
			"n":               1,
			"size":            size,
			"quality":         quality,
			"output_format":   outputFormat,
			"response_format": "b64_json",
		}
		if opts.Seed != 0 {
			payload["seed"] = opts.Seed
		}
		if strings.TrimSpace(opts.NegativePrompt) != "" {
			payload["negative_prompt"] = opts.NegativePrompt
		}
		b, err := json.Marshal(payload)
		if err != nil {
			return ImageResult{}, fmt.Errorf("marshal payload: %w", err)
		}
		url = baseURL + "/v1/images/generations"
		body = bytes.NewReader(b)
		contentType = "application/json"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return ImageResult{}, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+opts.APIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent)

	httpClient := &http.Client{
		Timeout: 8 * time.Minute,
	}

	startedAt := time.Now()
	// Progress ticker — Images API has no streaming so we just tick elapsed time.
	stopProgress := make(chan struct{})
	if onProgress != nil {
		go func() {
			tick := time.NewTicker(time.Duration(StatusIntervalSecond) * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-stopProgress:
					return
				case <-tick.C:
					onProgress("等待 Images API 返回(无 SSE 保活)", int(time.Since(startedAt).Seconds()), 0)
				}
			}
		}()
	}
	defer close(stopProgress)

	resp, err := httpClient.Do(req)
	if err != nil {
		return ImageResult{}, err
	}
	defer resp.Body.Close()

	preview := newCappedPreviewBuffer(4096)
	teeReader := io.TeeReader(resp.Body, io.MultiWriter(rawSink, preview))

	var parsed imagesAPIResponse
	dec := json.NewDecoder(teeReader)
	if err := dec.Decode(&parsed); err != nil {
		_, _ = io.Copy(io.MultiWriter(rawSink, preview), resp.Body)
		bodyPreview := preview.String()
		if len(bodyPreview) > 400 {
			bodyPreview = bodyPreview[:400] + "..."
		}
		if resp.StatusCode/100 != 2 {
			return ImageResult{}, fmt.Errorf("上游返回 HTTP %d: %s", resp.StatusCode, bodyPreview)
		}
		return ImageResult{}, fmt.Errorf("解析 Images API 响应失败:%w", err)
	}

	// Non-2xx with JSON body — decode has already captured the structured error.
	if resp.StatusCode/100 != 2 {
		if parsed.Error != nil {
			return ImageResult{}, fmt.Errorf("上游返回 %d:%s", resp.StatusCode, parsed.Error.Message)
		}
		bodyPreview := preview.String()
		if len(bodyPreview) > 400 {
			bodyPreview = bodyPreview[:400] + "..."
		}
		return ImageResult{}, fmt.Errorf("上游返回 HTTP %d: %s", resp.StatusCode, bodyPreview)
	}
	if parsed.Error != nil {
		return ImageResult{}, fmt.Errorf("上游返回错误:%s", parsed.Error.Message)
	}
	if len(parsed.Data) == 0 {
		return ImageResult{}, ErrNoImageInResponse
	}
	d := parsed.Data[0]
	if d.B64JSON == "" {
		// Some relays return URL only. We do not download URL responses to keep
		// behaviour predictable — surface a clear error so user can adjust the
		// upstream config.
		if d.URL != "" {
			return ImageResult{}, fmt.Errorf("上游返回 URL 而非 b64_json(不支持 response_format),请联系中转站启用 b64_json")
		}
		return ImageResult{}, ErrNoImageInResponse
	}
	return ImageResult{
		ImageB64:      d.B64JSON,
		RevisedPrompt: d.RevisedPrompt,
		SourceEvent:   "images_api",
	}, nil
}

type cappedPreviewBuffer struct {
	buf []byte
	max int
}

func newCappedPreviewBuffer(max int) *cappedPreviewBuffer {
	return &cappedPreviewBuffer{max: max}
}

func (b *cappedPreviewBuffer) Write(p []byte) (int, error) {
	if len(b.buf) < b.max {
		remain := b.max - len(b.buf)
		if len(p) < remain {
			remain = len(p)
		}
		b.buf = append(b.buf, p[:remain]...)
	}
	return len(p), nil
}

func (b *cappedPreviewBuffer) String() string {
	return string(b.buf)
}

// imageSourcePathsForEdit picks the source-image paths for an Images API edit.
// Prefers ImagePaths (raw files, no decode needed). If only data URLs are
// provided, the caller is responsible for writing them to a temp file first
// — see writeDataURLToTemp below.
func (o Options) imageSourcePathsForEdit() []string {
	paths := make([]string, 0, len(o.ImagePaths)+1)
	for _, p := range o.ImagePaths {
		if strings.TrimSpace(p) != "" {
			paths = append(paths, p)
		}
	}
	if len(paths) > 0 {
		return paths
	}
	// Fallback: data URLs → temp files.
	for _, du := range o.EffectiveImageDataURLs() {
		if p, err := writeDataURLToTemp(du); err == nil {
			paths = append(paths, p)
		}
	}
	return paths
}

// writeDataURLToTemp materialises a `data:...;base64,...` URL to a temp file
// and returns its path. Caller is responsible for cleanup; we leave it for the
// OS temp sweeper since these are small and we want them to survive retries.
func writeDataURLToTemp(dataURL string) (string, error) {
	idx := strings.Index(dataURL, ",")
	if !strings.HasPrefix(dataURL, "data:") || idx < 0 {
		return "", errors.New("not a data URL")
	}
	header := dataURL[5:idx] // e.g. "image/png;base64"
	payload := dataURL[idx+1:]
	if !strings.Contains(header, "base64") {
		return "", errors.New("data URL not base64")
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", err
	}
	ext := ".png"
	if strings.HasPrefix(header, "image/jpeg") {
		ext = ".jpg"
	} else if strings.HasPrefix(header, "image/webp") {
		ext = ".webp"
	}
	f, err := os.CreateTemp("", "image-studio-edit-*"+ext)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return f.Name(), nil
}

// buildEditsMultipart constructs the multipart/form-data body for /v1/images/edits.
// 多张源图按 image[] / image[1] / ... 形式串联 —— 不同中转站对多图编辑支持不一,
// 仅第一张是 OpenAI 官方接受的最小可用形态,其余作为兼容性 best-effort。
func buildEditsMultipart(
	paths []string, maskB64, prompt, model, size, quality, outputFormat, negativePrompt string, seed int64,
) (*bytes.Buffer, string, error) {
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)

	for i, p := range paths {
		fieldName := "image"
		if i > 0 {
			// Some relays accept multiple `image` fields, others want image[] —
			// we send both to maximise compatibility. The extra field is cheap.
			fieldName = "image[]"
		}
		if err := writeMultipartFile(w, fieldName, p); err != nil {
			return nil, "", fmt.Errorf("attach %s: %w", filepath.Base(p), err)
		}
	}

	if strings.TrimSpace(maskB64) != "" {
		raw, err := base64.StdEncoding.DecodeString(maskB64)
		if err == nil && len(raw) > 0 {
			fw, _ := w.CreateFormFile("mask", "mask.png")
			fw.Write(raw)
		}
	}

	_ = w.WriteField("prompt", prompt)
	_ = w.WriteField("model", model)
	_ = w.WriteField("n", "1")
	_ = w.WriteField("size", size)
	_ = w.WriteField("quality", quality)
	if strings.TrimSpace(outputFormat) != "" {
		_ = w.WriteField("output_format", outputFormat)
	}
	_ = w.WriteField("response_format", "b64_json")
	if seed != 0 {
		_ = w.WriteField("seed", fmt.Sprintf("%d", seed))
	}
	if strings.TrimSpace(negativePrompt) != "" {
		_ = w.WriteField("negative_prompt", negativePrompt)
	}

	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return buf, w.FormDataContentType(), nil
}

func writeMultipartFile(w *multipart.Writer, fieldName, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() > MaxInputImageBytes {
		return fmt.Errorf("源图过大(%dB > %dB 上限)", st.Size(), MaxInputImageBytes)
	}
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, fieldName, filepath.Base(path)))
	h.Set("Content-Type", mimeForPath(path))
	fw, err := w.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = io.Copy(fw, f)
	return err
}

func mimeForPath(p string) string {
	ext := strings.ToLower(filepath.Ext(p))
	if m, ok := SupportedImageMime[ext]; ok {
		return m
	}
	return "application/octet-stream"
}
