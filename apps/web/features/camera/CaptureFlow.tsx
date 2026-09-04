'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraScreen } from './CameraScreen';
import { SnapEditor, type EditorResult } from './SnapEditor';
import { uploadMedia } from '@/lib/upload';
import { useToast } from '@/components/ui/toast';

type Stage =
  | { name: 'camera' }
  | { name: 'editing'; url: string; kind: 'photo' | 'video' };

/**
 * Capture → edit → upload.
 *
 * Object URLs are revoked the moment they stop being displayed. A camera app
 * that leaks one blob per capture will exhaust memory inside a single session,
 * and the symptom — the tab dying after twenty snaps — looks nothing like its
 * cause.
 */
export function CaptureFlow() {
  const [stage, setStage] = useState<Stage>({ name: 'camera' });
  const [uploading, setUploading] = useState(false);
  const toast = useToast();
  const active = useRef<string | null>(null);
  // Portals need a DOM target, which does not exist during the server render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const open = useCallback((blob: Blob, kind: 'photo' | 'video') => {
    if (active.current) URL.revokeObjectURL(active.current);
    const url = URL.createObjectURL(blob);
    active.current = url;
    setStage({ name: 'editing', url, kind });
  }, []);

  const close = useCallback(() => {
    if (active.current) { URL.revokeObjectURL(active.current); active.current = null; }
    setStage({ name: 'camera' });
  }, []);

  useEffect(() => () => { if (active.current) URL.revokeObjectURL(active.current); }, []);

  const pickFile = useCallback((file: File) => {
    const kind = file.type.startsWith('video') ? 'video' : 'photo';
    open(file, kind);
  }, [open]);

  const send = useCallback(async (result: EditorResult) => {
    setUploading(true);
    try {
      const media = await uploadMedia(result.blob);
      toast(
        media.status === 'processing'
          ? 'Uploaded — your video is being processed'
          : 'Uploaded to your Memories',
      );
      close();
    } catch (err) {
      // The editor stays open on failure so the edit is not lost — re-doing
      // drawings because the network blipped is the worst possible outcome.
      toast(err instanceof Error ? err.message : 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  }, [close, toast]);

  /* The editor is portalled to <body>.
     Its z-50 would otherwise be trapped inside the camera wrapper's z-30
     stacking context — z-index only competes within a context, so the editor
     rendered *below* the z-40 tab bar. The bar covered the Send button and ate
     the clicks. A portal removes the editor from that context entirely, which
     is the correct shape for a full-screen modal anyway. */
  if (stage.name === 'editing') {
    return mounted ? createPortal(
      <>
        <SnapEditor source={stage.url} kind={stage.kind} onCancel={close} onDone={send} />
        {uploading && (
          <div className="fixed inset-0 z-[70] grid place-items-center bg-black/70">
            <div className="flex items-center gap-3 rounded-2xl glass px-5 py-4">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <span className="text-sm">Uploading…</span>
            </div>
          </div>
        )}
      </>,
      document.body,
    ) : null;
  }

  return <CameraScreen onCapture={open} onPickFile={pickFile} />;
}
