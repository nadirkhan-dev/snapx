import { api, getAccessToken } from './api';

export interface UploadedMedia {
  id: string; status: string; mimeType: string;
  byteSize: number; width: number | null; height: number | null;
}

/**
 * Uploads a blob as a raw body with metadata in headers.
 *
 * Not FormData: one file per request needs no multipart parser on the server,
 * and the bytes stream straight from the browser. Dimensions are measured here
 * because the server should never trust client-supplied numbers for anything
 * that matters — they are a rendering hint, not a security boundary.
 */
export async function uploadMedia(blob: Blob): Promise<UploadedMedia> {
  const meta = await measure(blob);

  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
  };
  const token = getAccessToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (meta.width) headers['x-media-width'] = String(meta.width);
  if (meta.height) headers['x-media-height'] = String(meta.height);
  if (meta.durationMs) headers['x-media-duration'] = String(Math.round(meta.durationMs));

  const res = await fetch('/api/media/upload', {
    method: 'POST', headers, credentials: 'include', body: blob,
  });

  if (res.status === 401) {
    // One retry through the shared refresh path, then give up.
    await api('/auth/me').catch(() => {});
    const retry = await fetch('/api/media/upload', {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${getAccessToken() ?? ''}` },
      credentials: 'include', body: blob,
    });
    if (!retry.ok) throw new Error((await retry.json().catch(() => ({}))).message ?? 'Upload failed');
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Upload failed (${res.status})`);
  }
  return res.json();
}

/** Reads intrinsic dimensions without decoding the whole file into a canvas. */
function measure(blob: Blob): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const url = URL.createObjectURL(blob);
  const done = (v: { width?: number; height?: number; durationMs?: number }) => {
    URL.revokeObjectURL(url);
    return v;
  };

  return new Promise(resolve => {
    // A corrupt or exotic file must not hang the upload forever.
    const bail = setTimeout(() => resolve(done({})), 3000);

    if (blob.type.startsWith('video')) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        clearTimeout(bail);
        resolve(done({ width: v.videoWidth, height: v.videoHeight, durationMs: v.duration * 1000 }));
      };
      v.onerror = () => { clearTimeout(bail); resolve(done({})); };
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        clearTimeout(bail);
        resolve(done({ width: img.naturalWidth, height: img.naturalHeight }));
      };
      img.onerror = () => { clearTimeout(bail); resolve(done({})); };
      img.src = url;
    }
  });
}
