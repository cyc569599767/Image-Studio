// Package backend exposes the GUI-facing bindings for the Wails app.
// All gptcodex-specific logic lives in github.com/yuanhua/image-gptcodex/pkg/client;
// this package only wires it into Wails (context, events, file dialogs).
//
// File layout:
//
//	service.go   — Service struct, lifecycle, generation orchestration (Generate / Edit / Cancel)
//	types.go     — JSON-bound structs shared with the TS frontend
//	dialogs.go   — file picker / save / open URL / read image / import-export history
//	imports.go   — drag-drop / paste import + filename sanitisation
//	imageops.go  — rotate / flip / crop on disk via Go image stdlib
//	paths.go     — output / import dir resolution + filename helpers
//	open.go      — cross-platform "open in OS" shell-out
package backend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/yuanhua/image-gptcodex/pkg/client"
)

// Service is the Wails-bound struct. Methods on it are exposed to the frontend
// via runtime/window/bindings.
type Service struct {
	ctx context.Context

	mu        sync.Mutex
	jobs      map[string]*job
	outputDir string // 用户自定义输出目录;空时回退到 defaultOutputDir()
	apiKeys   apiKeyStore

	trustedOutputRoots map[string]struct{}
}

type job struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// NewService constructs a fresh Service ready to be passed to wails.Run Bind.
func NewService() *Service {
	return &Service{
		jobs:               map[string]*job{},
		apiKeys:            keyringAPIKeyStore{},
		trustedOutputRoots: map[string]struct{}{},
	}
}

// Startup is wired into wails.Options OnStartup; persists the runtime context.
func (s *Service) Startup(ctx context.Context) {
	s.ctx = ctx
}

// resolvedOutputDir 返回当前生效的输出目录:用户自定义优先,否则默认。
// 不存在则尝试创建。
func (s *Service) resolvedOutputDir() (string, error) {
	s.mu.Lock()
	custom := s.outputDir
	s.mu.Unlock()
	if custom != "" {
		if err := os.MkdirAll(custom, secureDirMode); err != nil {
			return "", fmt.Errorf("无法创建输出目录 %s: %w", custom, err)
		}
		s.addTrustedOutputRoot(custom)
		return custom, nil
	}
	root, err := defaultOutputDir()
	if err == nil {
		s.addTrustedOutputRoot(root)
	}
	return root, err
}

// SetOutputDir 由前端调用以应用用户选择的输出目录。空串表示恢复默认。
// 路径会被 MkdirAll 兜底创建;创建失败则不接受。
func (s *Service) SetOutputDir(path string) error {
	if strings.TrimSpace(path) == "" {
		s.mu.Lock()
		s.outputDir = ""
		s.mu.Unlock()
		return nil
	}
	clean, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("路径无效:%w", err)
	}
	if err := os.MkdirAll(clean, secureDirMode); err != nil {
		return fmt.Errorf("无法创建输出目录 %s: %w", clean, err)
	}
	s.mu.Lock()
	s.outputDir = clean
	s.mu.Unlock()
	s.addTrustedOutputRoot(clean)
	return nil
}

// ChooseOutputDir 弹出系统目录选择对话框,选中后立刻应用并返回新路径。
// 用户取消时返回空串(不报错)。
func (s *Service) ChooseOutputDir() (string, error) {
	if s.ctx == nil {
		return "", errors.New("服务未启动")
	}
	chosen, err := runtime.OpenDirectoryDialog(s.ctx, runtime.OpenDialogOptions{
		Title: "选择生成图片的保存目录",
	})
	if err != nil {
		return "", err
	}
	if chosen == "" {
		return "", nil // 用户取消
	}
	if err := s.SetOutputDir(chosen); err != nil {
		return "", err
	}
	return chosen, nil
}

// --- Generation entry points -----------------------------------------------

// Generate starts a text-to-image job and returns its ID immediately. Progress
// and final result arrive as Wails events.
func (s *Service) Generate(opts GenerateOptions) (JobStarted, error) {
	opts.Mode = "generate"
	return s.startJob(opts)
}

// Edit starts an image-to-image job. opts.ImagePaths must list one or more
// existing local files (the frontend writes imports/generated PNGs to disk
// so we never push raw base64 across the JSON bridge for large files).
func (s *Service) Edit(opts GenerateOptions) (JobStarted, error) {
	opts.Mode = "edit"
	if len(opts.collectPaths()) == 0 {
		return JobStarted{}, errors.New("edit 模式必须提供至少一张源图片")
	}
	return s.startJob(opts)
}

// OptimizePrompt uses the configured LLM to rewrite the current prompt into a
// cleaner image prompt. If edit source images are provided, they are included
// as visual context. The original prompt is not mutated by the backend.
func (s *Service) OptimizePrompt(opts PromptOptimizeOptions) (string, error) {
	if s.ctx == nil {
		return "", errors.New("服务未启动")
	}
	if strings.TrimSpace(opts.APIKey) == "" {
		return "", errors.New("API Key 不能为空")
	}
	if strings.TrimSpace(opts.Prompt) == "" {
		return "", errors.New("提示词不能为空")
	}
	baseURL, err := client.ValidateBaseURL(opts.BaseURL)
	if err != nil {
		return "", err
	}
	refPaths, cleanup, err := prepareUploadSourcePaths(opts.collectPaths())
	if err != nil {
		return "", err
	}
	defer cleanup()
	modelID := strings.TrimSpace(opts.TextModelID)
	if modelID == "" {
		modelID = client.TextModel
	}
	return optimizePromptWithLLM(s.ctx, baseURL, opts.APIKey, modelID, opts.Mode, opts.Prompt, refPaths)
}

// Cancel terminates a running job. Safe to call with unknown IDs.
func (s *Service) Cancel(jobID string) error {
	s.mu.Lock()
	j, ok := s.jobs[jobID]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	j.cancel()
	return nil
}

// collectPaths merges legacy ImagePath into ImagePaths and drops blanks.
func (o GenerateOptions) collectPaths() []string {
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

// --- Internal job lifecycle ------------------------------------------------

func (s *Service) startJob(opts GenerateOptions) (JobStarted, error) {
	if strings.TrimSpace(opts.APIKey) == "" {
		return JobStarted{}, errors.New("API Key 不能为空")
	}
	if strings.TrimSpace(opts.Prompt) == "" {
		return JobStarted{}, errors.New("提示词/修改要求不能为空")
	}

	jobID, err := newJobID()
	if err != nil {
		return JobStarted{}, err
	}

	ctx, cancel := context.WithCancel(s.ctx)
	done := make(chan struct{})

	s.mu.Lock()
	s.jobs[jobID] = &job{cancel: cancel, done: done}
	s.mu.Unlock()

	go s.runJob(ctx, jobID, opts, done)

	return JobStarted{JobID: jobID}, nil
}

func (s *Service) runJob(ctx context.Context, jobID string, opts GenerateOptions, done chan struct{}) {
	defer close(done)
	defer func() {
		s.mu.Lock()
		delete(s.jobs, jobID)
		s.mu.Unlock()
	}()

	mode := client.ModeGenerate
	if opts.Mode == "edit" {
		mode = client.ModeEdit
	}

	apiMode := client.APIMode(opts.APIMode)
	if apiMode == "" {
		apiMode = client.APIModeResponses
	}

	clientOpts := client.Options{
		APIKey:           opts.APIKey,
		Prompt:           opts.Prompt,
		Mode:             mode,
		Size:             opts.Size,
		Quality:          opts.Quality,
		OutputFormat:     opts.OutputFormat,
		MaskB64:          opts.MaskB64,
		Seed:             opts.Seed,
		NegativePrompt:   opts.NegativePrompt,
		BaseURL:          opts.BaseURL,
		TextModelID:      opts.TextModelID,
		ImageModelID:     opts.ImageModelID,
		Transport:        client.TransportKind(opts.Transport),
		APIMode:          apiMode,
		NoPromptRevision: opts.NoPromptRevision,
	}
	if mode == client.ModeEdit {
		paths, cleanup, prepErr := prepareUploadSourcePaths(opts.collectPaths())
		if prepErr != nil {
			s.emitError(jobID, prepErr)
			return
		}
		defer cleanup()
		clientOpts.ImagePaths = paths
		// Responses API 仍需 data URL(走 input_image 形态);
		// Images API 直接 multipart 上传文件,跳过 base64 编码节省往返开销。
		if apiMode == client.APIModeResponses {
			urls := make([]string, 0, len(paths))
			for _, p := range paths {
				dataURL, err := client.ImageFileToDataURL(p)
				if err != nil {
					s.emitError(jobID, fmt.Errorf("加载源图片 %s 失败:%w", filepath.Base(p), err))
					return
				}
				urls = append(urls, dataURL)
			}
			clientOpts.ImageDataURLs = urls
		}
	}

	transport, err := client.PickTransport(clientOpts.Transport)
	if err != nil {
		s.emitError(jobID, err)
		return
	}

	rootDir, err := s.resolvedOutputDir()
	if err != nil {
		s.emitError(jobID, err)
		return
	}
	// 拆 PNG 和 raw response 到两个子目录,避免单目录文件混杂。
	imagesDir := imagesSubdir(rootDir)
	logDir := logSubdir(rootDir)
	if err := os.MkdirAll(imagesDir, secureDirMode); err != nil {
		s.emitError(jobID, err)
		return
	}
	if err := os.MkdirAll(logDir, secureDirMode); err != nil {
		s.emitError(jobID, err)
		return
	}

	timestamp := time.Now().Format("20060102-150405")
	logFn := func(msg string) {
		runtime.EventsEmit(s.ctx, "log:"+jobID, msg)
	}
	progressFn := func(stage string, elapsed int, bytes int64) {
		runtime.EventsEmit(s.ctx, "progress:"+jobID, ProgressPayload{
			Stage: stage, Elapsed: elapsed, Bytes: bytes,
		})
	}

	// raw response(SSE 文本 / Images API JSON)落到 log 子目录;PNG 落到 images 子目录。
	result, rawPath, err := client.RequestAndExtractWithRetries(
		ctx, transport, clientOpts, logDir, timestamp, logFn, progressFn,
	)
	if err != nil {
		s.emitError(jobID, err)
		return
	}

	imageName := buildImageName(mode, opts.Prompt, timestamp, opts.OutputFormat)
	savedPath := filepath.Join(imagesDir, imageName)
	if abs, werr := writeBase64PNG(result.ImageB64, savedPath); werr == nil {
		savedPath = abs
	}
	absRaw, _ := filepath.Abs(rawPath)

	runtime.EventsEmit(s.ctx, "result:"+jobID, ResultPayload{
		ImageB64:      result.ImageB64,
		RevisedPrompt: result.RevisedPrompt,
		SourceEvent:   result.SourceEvent,
		SavedPath:     savedPath,
		RawPath:       absRaw,
		Mode:          string(mode),
		Prompt:        opts.Prompt,
	})
}

func (s *Service) emitError(jobID string, err error) {
	runtime.EventsEmit(s.ctx, "error:"+jobID, ErrorPayload{Message: err.Error()})
}

func newJobID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
