package backend

import "strings"

// --- UI-facing types -------------------------------------------------------

// GenerateOptions is the request shape sent by the frontend.
// Fields mirror client.Options but with friendlier names for TS.
type GenerateOptions struct {
	APIKey  string `json:"apiKey"`
	Mode    string `json:"mode"` // "generate" | "edit"
	Prompt  string `json:"prompt"`
	Size    string `json:"size"`
	Quality string `json:"quality"`
	// OutputFormat:"png" | "jpeg" | "webp"。空时回退到 client.OutputFormat 默认("png")。
	OutputFormat string `json:"outputFormat"`

	// Multi-reference: zero or more source images for edit mode. Each is a
	// path on disk (frontend writes imports / generated PNGs to disk so we
	// can avoid pushing large base64 across the JSON bridge).
	ImagePaths []string `json:"imagePaths"`

	// Deprecated single-image path, kept for backward compat with older
	// frontend builds. Folded into ImagePaths when present.
	ImagePath string `json:"imagePath"`

	MaskB64        string `json:"maskB64"`        // optional, phase 3 reservation
	Seed           int64  `json:"seed"`           // 0 = random
	NegativePrompt string `json:"negativePrompt"` // optional
	BaseURL        string `json:"baseURL"`        // overrides the default upstream URL
	TextModelID    string `json:"textModelID"`    // overrides the default text model
	ImageModelID   string `json:"imageModelID"`   // overrides the default image model
	Transport      string `json:"transport"`      // "auto" | "native" | "curl"
	APIMode        string `json:"apiMode"`        // "responses" (default) | "images"
	// NoPromptRevision:true 时禁止 Responses API 文本模型改写 prompt;Images API 路径忽略。
	NoPromptRevision bool `json:"noPromptRevision"`
	// ConcurrencyLimit is enforced per APIMode. 0 means unlimited.
	ConcurrencyLimit int `json:"concurrencyLimit"`
}

// PromptOptimizeOptions is the request shape for one-click prompt revision.
type PromptOptimizeOptions struct {
	APIKey      string   `json:"apiKey"`
	Prompt      string   `json:"prompt"`
	Mode        string   `json:"mode"`
	BaseURL     string   `json:"baseURL"`
	TextModelID string   `json:"textModelID"`
	ImagePaths  []string `json:"imagePaths"`
	ImagePath   string   `json:"imagePath"`
}

func (o PromptOptimizeOptions) collectPaths() []string {
	paths := make([]string, 0, len(o.ImagePaths)+1)
	for _, p := range o.ImagePaths {
		if strings.TrimSpace(p) != "" {
			paths = append(paths, p)
		}
	}
	if strings.TrimSpace(o.ImagePath) != "" {
		paths = append(paths, o.ImagePath)
	}
	return paths
}

// JobStarted is the response to Generate/Edit.
type JobStarted struct {
	JobID string `json:"jobId"`
}

// ProgressPayload is emitted as `progress:<jobId>` events.
type ProgressPayload struct {
	Stage   string `json:"stage"`
	Elapsed int    `json:"elapsed"`
	Bytes   int64  `json:"bytes"`
}

// ResultPayload is emitted as `result:<jobId>`.
type ResultPayload struct {
	ImageB64      string `json:"imageB64"`
	RevisedPrompt string `json:"revisedPrompt"`
	SourceEvent   string `json:"sourceEvent"`
	SavedPath     string `json:"savedPath"` // absolute path in user config dir
	RawPath       string `json:"rawPath"`   // raw SSE dump location
	Mode          string `json:"mode"`
	Prompt        string `json:"prompt"`
}

// ErrorPayload is emitted as `error:<jobId>` when a run fails.
type ErrorPayload struct {
	Message string `json:"message"`
}

// SelectFileResponse is returned by OpenImageDialog.
type SelectFileResponse struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// ImportedImage describes a freshly imported (drag-dropped or pasted) image.
type ImportedImage struct {
	Path     string `json:"path"`
	ImageB64 string `json:"imageB64"`
}
