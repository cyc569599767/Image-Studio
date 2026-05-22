package backend

import (
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "image/jpeg" // register JPEG decoder for image.Decode
)

// ImageTransformResult is the shape returned by the rotation / flip / crop
// bindings. Path is an absolute path under UserConfigDir/imports.
type ImageTransformResult struct {
	Path string `json:"path"`
}

// RotateImage rotates the image at `path` by `degrees` (multiples of 90 only)
// clockwise and writes the result to imports/ as a new file. Original is left
// untouched.
func (s *Service) RotateImage(path string, degrees int) (ImageTransformResult, error) {
	deg := ((degrees % 360) + 360) % 360
	if deg != 0 && deg != 90 && deg != 180 && deg != 270 {
		return ImageTransformResult{}, errors.New("rotation must be a multiple of 90 degrees")
	}
	allowed, err := s.ensureManagedReadablePath(path, managedImageFile)
	if err != nil {
		return ImageTransformResult{}, err
	}
	src, err := loadImage(allowed)
	if err != nil {
		return ImageTransformResult{}, err
	}
	rotated := rotate(src, deg)
	out, err := saveTransform(rotated, allowed, fmt.Sprintf("rot%d", deg))
	return ImageTransformResult{Path: out}, err
}

// FlipImage flips horizontally (true) or vertically (false).
func (s *Service) FlipImage(path string, horizontal bool) (ImageTransformResult, error) {
	allowed, err := s.ensureManagedReadablePath(path, managedImageFile)
	if err != nil {
		return ImageTransformResult{}, err
	}
	src, err := loadImage(allowed)
	if err != nil {
		return ImageTransformResult{}, err
	}
	flipped := flip(src, horizontal)
	suffix := "fliph"
	if !horizontal {
		suffix = "flipv"
	}
	out, err := saveTransform(flipped, allowed, suffix)
	return ImageTransformResult{Path: out}, err
}

// CropImage crops a rectangle (x,y,w,h in source pixels) and writes a new file.
func (s *Service) CropImage(path string, x, y, w, h int) (ImageTransformResult, error) {
	if w <= 0 || h <= 0 {
		return ImageTransformResult{}, errors.New("crop rect must have positive size")
	}
	allowed, err := s.ensureManagedReadablePath(path, managedImageFile)
	if err != nil {
		return ImageTransformResult{}, err
	}
	src, err := loadImage(allowed)
	if err != nil {
		return ImageTransformResult{}, err
	}
	b := src.Bounds()
	rect := image.Rect(b.Min.X+x, b.Min.Y+y, b.Min.X+x+w, b.Min.Y+y+h).Intersect(b)
	if rect.Empty() {
		return ImageTransformResult{}, errors.New("crop rect lies outside the image")
	}
	dst := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(dst, dst.Bounds(), src, rect.Min, draw.Src)
	out, err := saveTransform(dst, allowed, "crop")
	return ImageTransformResult{Path: out}, err
}

// --- internal helpers ------------------------------------------------------

func loadImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", filepath.Base(path), err)
	}
	return img, nil
}

// rotate rotates clockwise by deg (0/90/180/270).
func rotate(src image.Image, deg int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if deg == 0 {
		return src
	}
	var dst *image.RGBA
	if deg == 180 {
		dst = image.NewRGBA(image.Rect(0, 0, w, h))
	} else {
		dst = image.NewRGBA(image.Rect(0, 0, h, w)) // 90 / 270 swap
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := src.At(b.Min.X+x, b.Min.Y+y)
			switch deg {
			case 90:
				dst.Set(h-1-y, x, c)
			case 180:
				dst.Set(w-1-x, h-1-y, c)
			case 270:
				dst.Set(y, w-1-x, c)
			}
		}
	}
	return dst
}

func flip(src image.Image, horizontal bool) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := src.At(b.Min.X+x, b.Min.Y+y)
			if horizontal {
				dst.Set(w-1-x, y, c)
			} else {
				dst.Set(x, h-1-y, c)
			}
		}
	}
	return dst
}

func saveTransform(img image.Image, originalPath, suffix string) (string, error) {
	dir, err := importsDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, secureDirMode); err != nil {
		return "", err
	}
	base := filepath.Base(originalPath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	name := fmt.Sprintf("%s-%s-%s.png", time.Now().Format("20060102-150405"), sanitiseName(stem), suffix)
	out := filepath.Join(dir, name)
	f, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, secureFileMode)
	if err != nil {
		return "", err
	}
	defer f.Close()
	ext := strings.ToLower(filepath.Ext(originalPath))
	if ext == ".jpg" || ext == ".jpeg" {
		return out, jpeg.Encode(f, img, &jpeg.Options{Quality: 92})
	}
	return out, png.Encode(f, img)
}
