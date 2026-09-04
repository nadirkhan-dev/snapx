import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Camera access.
 *
 * Spec §44 requires every permission edge case be handled and the app must
 * never crash when permission is unavailable. The browser surfaces these as
 * differently-named DOMExceptions, so they are mapped to one union the UI can
 * switch on — and each one gets a message that says what to actually do, not
 * "an error occurred".
 *
 * Note the deliberate absence of a "denied forever" state on the web: unlike
 * Android's "don't ask again", a browser will re-prompt after the user clears
 * the site permission, so the copy points at the address-bar padlock instead of
 * an OS settings screen.
 */

export type CamStatus =
  | 'idle'          // not yet requested
  | 'prompting'     // browser dialog is open
  | 'live'          // stream running
  | 'denied'        // user or policy refused
  | 'unavailable'   // no camera on the device
  | 'busy'          // another app holds the camera
  | 'insecure'      // not HTTPS — getUserMedia is unavailable
  | 'unsupported';  // browser has no mediaDevices at all

export type Facing = 'user' | 'environment';

export interface CameraState {
  status: CamStatus;
  message: string | null;
  facing: Facing;
  hasFlash: boolean;
  flashOn: boolean;
  zoom: number;
  zoomRange: { min: number; max: number; step: number } | null;
  devices: MediaDeviceInfo[];
}

const MESSAGES: Record<Exclude<CamStatus, 'idle' | 'prompting' | 'live'>, string> = {
  denied: 'Camera access is blocked. Tap the padlock in your address bar to allow it, then try again.',
  unavailable: 'No camera found on this device.',
  busy: 'Another app is using the camera. Close it and try again.',
  insecure: 'The camera needs a secure connection. Open SNAPX over HTTPS.',
  unsupported: 'This browser cannot access the camera. Try Chrome, Safari or Firefox.',
};

export function useCamera(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [state, setState] = useState<CameraState>({
    status: 'idle', message: null, facing: 'user',
    hasFlash: false, flashOn: false, zoom: 1, zoomRange: null, devices: [],
  });

  const streamRef = useRef<MediaStream | null>(null);
  // Guards against a fast double-flip resolving out of order and leaving the
  // newer stream orphaned while the older one paints.
  const requestId = useRef(0);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async (facing: Facing = 'user') => {
    if (!navigator.mediaDevices?.getUserMedia) {
      // Browsers hide mediaDevices entirely on insecure origins, so the two
      // cases are indistinguishable without checking isSecureContext first.
      const status = window.isSecureContext ? 'unsupported' : 'insecure';
      setState(s => ({ ...s, status, message: MESSAGES[status] }));
      return;
    }

    const id = ++requestId.current;
    setState(s => ({ ...s, status: 'prompting', message: null }));
    stop();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,   // requested separately at record time, so a photo-only
                        // session never lights the microphone indicator
      });

      // A newer request superseded this one while the dialog was open.
      if (id !== requestId.current) { stream.getTracks().forEach(t => t.stop()); return; }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // iOS Safari refuses to autoplay without an explicit call, and rejects
        // silently — which looks exactly like a black camera.
        await videoRef.current.play().catch(() => {});
      }

      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
        torch?: boolean; zoom?: { min: number; max: number; step: number };
      };
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'videoinput');

      setState({
        status: 'live', message: null, facing,
        hasFlash: Boolean(caps.torch),
        flashOn: false,
        zoom: 1,
        zoomRange: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step ?? 0.1 } : null,
        devices,
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      const status: CamStatus =
        name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable'
        : name === 'NotReadableError' || name === 'AbortError' ? 'busy'
        : 'unsupported';
      setState(s => ({ ...s, status, message: MESSAGES[status as keyof typeof MESSAGES] }));
    }
  }, [stop, videoRef]);

  const flip = useCallback(() => {
    start(state.facing === 'user' ? 'environment' : 'user');
  }, [start, state.facing]);

  /** Torch. Android Chrome only — iOS exposes no torch constraint at all. */
  const toggleFlash = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !state.hasFlash) return;
    const next = !state.flashOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setState(s => ({ ...s, flashOn: next }));
    } catch { /* the device withdrew the capability; leave the UI as it was */ }
  }, [state.hasFlash, state.flashOn]);

  const setZoom = useCallback(async (value: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !state.zoomRange) return;
    const z = Math.min(state.zoomRange.max, Math.max(state.zoomRange.min, value));
    try {
      await track.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
      setState(s => ({ ...s, zoom: z }));
    } catch { /* ignore */ }
  }, [state.zoomRange]);

  /**
   * Captures a still from the live video.
   *
   * The preview is mirrored for the front camera because an unmirrored selfie
   * feels wrong to look at — but the *stream* is not mirrored, so drawing it
   * straight to canvas already yields the correct orientation. Flipping here as
   * well would double-apply it and reverse any text in frame; a browser test
   * with a synthetic camera caught exactly that, its timestamp rendered
   * backwards in the saved file.
   *
   * Consequence worth knowing: a selfie saves un-mirrored, so it differs from
   * the preview. That is the iOS default and the right call — a photo of a sign
   * or a whiteboard must be readable.
   */
  const capturePhoto = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || state.status !== 'live') return null;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0);

    return new Promise(resolve =>
      canvas.toBlob(b => resolve(b), 'image/jpeg', 0.92));
  }, [state.status, videoRef]);

  /** Releasing the camera on unmount is what turns the device's privacy light off. */
  useEffect(() => stop, [stop]);

  /* Browsers suspend camera tracks when a tab is backgrounded and do not always
     resume them, which presents as a frozen frame on return. */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || state.status !== 'live') return;
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') start(state.facing);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [start, state.status, state.facing]);

  return { ...state, stream: streamRef, start, stop, flip, toggleFlash, setZoom, capturePhoto };
}
