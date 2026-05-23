import { useEffect, useState } from "react";

export function base64ToBlob(b64: string, mimeType = "image/png"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function blobToObjectURL(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function useBlobURL(blob?: Blob | null, fallbackB64?: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob) {
      const objectURL = URL.createObjectURL(blob);
      setUrl(objectURL);
      return () => URL.revokeObjectURL(objectURL);
    }

    if (fallbackB64) {
      try {
        const objectURL = URL.createObjectURL(base64ToBlob(fallbackB64));
        setUrl(objectURL);
        return () => URL.revokeObjectURL(objectURL);
      } catch {
        setUrl(null);
        return;
      }
    }

    setUrl(null);
  }, [blob, fallbackB64]);

  return url;
}

export async function createPreviewBlob(blob: Blob, maxEdge = 192): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      if (scale >= 0.999) return blob;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return blob;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const preview = await new Promise<Blob>((resolve) => {
        canvas.toBlob((out) => resolve(out ?? blob), "image/jpeg", 0.72);
      });
      return preview;
    } finally {
      bitmap.close();
    }
  } finally {
    // no-op: createImageBitmap consumes the Blob directly
  }
}

export function useImageElement(source?: Blob | string | null): HTMLImageElement | null {
  const url = useBlobURL(source instanceof Blob ? source : null, typeof source === "string" ? source : null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!url) { setImg(null); return; }
    setImg(null);
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setImg(null);
    el.src = url;
    return () => {
      el.onload = null;
      el.onerror = null;
    };
  }, [url]);

  return img;
}

export async function getImageDimensionsFromBlob(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    if (buf.byteLength >= 24) {
      const w = view.getUint32(16, false);
      const h = view.getUint32(20, false);
      if (w > 0 && h > 0 && w < 20000 && h < 20000) return { w, h };
    }
  } catch {
    // ignore
  }
  return null;
}

export function getImageDimensionsFromBase64(b64: string): { w: number; h: number } | null {
  try {
    const bin = atob(b64.slice(0, 64));
    const view = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
    const w = view.getUint32(16, false);
    const h = view.getUint32(20, false);
    if (w > 0 && h > 0 && w < 20000 && h < 20000) return { w, h };
  } catch {
    // ignore
  }
  return null;
}

export async function getImageDimensions(
  source: { imageBlob?: Blob | null; imageB64?: string | null } | Blob | string | null | undefined,
): Promise<{ w: number; h: number } | null> {
  if (!source) return null;
  if (typeof source === "string") return getImageDimensionsFromBase64(source);
  if (source instanceof Blob) return getImageDimensionsFromBlob(source);
  if (source.imageBlob) return getImageDimensionsFromBlob(source.imageBlob);
  if (source.imageB64) return getImageDimensionsFromBase64(source.imageB64);
  return null;
}

export async function ensureBase64FromSource(
  source: { imageB64?: string | null; imageBlob?: Blob | null } | Blob | string | null | undefined,
): Promise<string> {
  if (!source) return "";
  if (typeof source === "string") return source;
  if (source instanceof Blob) return blobToBase64(source);
  if (source.imageB64) return source.imageB64;
  if (source.imageBlob) return blobToBase64(source.imageBlob);
  return "";
}

export function blobSourceToURL(source: { imageBlob?: Blob | null; imageB64?: string | null } | null | undefined): string | null {
  if (!source) return null;
  if (source.imageBlob) return URL.createObjectURL(source.imageBlob);
  if (source.imageB64) return URL.createObjectURL(base64ToBlob(source.imageB64));
  return null;
}
