"use client";

/**
 * One camera, two jobs: reading barcodes and taking the packing photo.
 *
 * Opening the camera twice would fail on Android — the device is single-claim
 * — so a single MediaStream is opened once and shared. The same <video> that
 * the detector reads frames from is the viewfinder the shot is framed in.
 *
 * The stream does not survive the phone going away. Locking the screen, taking
 * a call, or switching apps ends or mutes the camera track, and Chrome does
 * not restore it: the element keeps a dead stream and renders black forever,
 * which is why this class watches for coming back and re-acquires by itself.
 */

import { QUALITY, type PhotoQuality } from "./settings.ts";

export type BarcodeHandler = (value: string) => void;

/**
 * Gap between detection attempts.
 *
 * Deliberately a timer rather than requestAnimationFrame: rAF is suspended
 * whenever the page stops compositing (screen dimmed, app backgrounded), which
 * silently stalls scanning. It also fires ~60 times a second, and running a
 * detector over a 1080p frame that often is pure battery burn — a label is
 * still picked up instantly at roughly eight attempts per second.
 */
const SCAN_INTERVAL_MS = 120;

/** Formats carriers actually print on Saudi shipping labels. */
const FORMATS = [
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "ean_13",
  "ean_8",
  "itf",
  "qr_code",
  "data_matrix",
  "pdf417",
];

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  const w = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return w.BarcodeDetector ?? null;
}

/** True when this browser can scan barcodes natively (Chrome on Android does). */
export function canScan(): boolean {
  return detectorCtor() !== null;
}

export class Camera {
  private stream: MediaStream | null = null;
  private detector: BarcodeDetectorLike | null = null;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  private scanning = false;
  /** Incremented on every stop, to invalidate in-flight detections. */
  private session = 0;
  /** Codes seen recently, so one physical label is not read ten times a second. */
  private cooldown = new Map<string, number>();
  /** Set while a recovery is in flight, so overlapping events do not stack. */
  private reviving = false;
  private onCodeHandler: BarcodeHandler | null = null;
  private cooldownMs = 2500;
  /** Told when the preview recovers or gives up, so the UI can say so. */
  private onStateChange?: (state: "live" | "recovering" | "lost") => void;
  private detached: (() => void)[] = [];

  video: HTMLVideoElement;
  private quality: PhotoQuality;

  constructor(video: HTMLVideoElement, quality: PhotoQuality = "high") {
    this.video = video;
    this.quality = quality;
    this.watchForReturn();
  }

  /** Changes capture resolution. Takes effect the next time the camera starts. */
  setQuality(q: PhotoQuality): void {
    this.quality = q;
  }

  onState(fn: (state: "live" | "recovering" | "lost") => void): void {
    this.onStateChange = fn;
  }

  /**
   * Watches every signal that the page has come back from being away.
   *
   * Android gives no single reliable one: `visibilitychange` fires for a
   * screen lock and an app switch, `pageshow` for a restore from the back
   * forward cache, `focus` for returning from a permission dialog, and a phone
   * call can end the camera track without any of them. All four are listened
   * to, plus the track's own `ended` and `mute` events, and they all funnel
   * into the same idempotent recovery.
   */
  private watchForReturn(): void {
    if (typeof document === "undefined") return;
    const wake = () => {
      if (document.visibilityState === "visible") void this.revive();
    };
    const on = (target: EventTarget, type: string) => {
      target.addEventListener(type, wake);
      this.detached.push(() => target.removeEventListener(type, wake));
    };
    on(document, "visibilitychange");
    on(window, "pageshow");
    on(window, "focus");
    // Chrome's freeze/resume pair for discarded background tabs.
    on(document, "resume");
  }

  /**
   * Brings the preview back after the phone was locked, called, or switched
   * away from.
   *
   * Cheap checks first: a stream whose track is still live usually only needs
   * `play()` again. Anything worse is repaired by throwing the stream away and
   * asking for a new one — the element cannot be talked out of a dead track,
   * which is exactly the black preview that used to need a page reload.
   */
  async revive(): Promise<void> {
    if (!this.stream || this.reviving) return;
    this.reviving = true;
    try {
      const track = this.stream.getVideoTracks()[0];
      // A track muted by a phone call stays "live" and the element keeps
      // showing the last frame it got, so neither the track state nor the
      // element's dimensions reveal the failure. Give the OS a moment to hand
      // the camera back, then treat a still-muted track as dead.
      if (track?.muted) await new Promise((r) => setTimeout(r, 500));
      const dead = !track || track.readyState === "ended" || track.muted;

      if (!dead) {
        if (this.video.srcObject !== this.stream) this.video.srcObject = this.stream;
        await this.video.play().catch(() => {});
        // A track can report "live" while delivering nothing — muted by the
        // call that just ended, or simply not resumed. Frames are the only
        // honest test, so wait a beat and look at the element itself.
        await new Promise((r) => setTimeout(r, 350));
        if (this.hasFrames()) {
          this.onStateChange?.("live");
          return;
        }
      }

      this.onStateChange?.("recovering");
      await this.reacquire();
    } finally {
      this.reviving = false;
    }
  }

  /** True when the element is actually receiving pictures. */
  private hasFrames(): boolean {
    return (
      this.video.readyState >= 2 &&
      this.video.videoWidth > 0 &&
      !this.video.paused
    );
  }

  /**
   * Drops the stream and opens a fresh one, restoring scanning if it was on.
   *
   * Retried a few times: coming back from a phone call, the camera can still
   * be held by the dialer for a moment and `getUserMedia` rejects outright.
   */
  private async reacquire(): Promise<void> {
    const wasScanning = this.scanning;
    const handler = this.onCodeHandler;
    const cooldownMs = this.cooldownMs;

    this.stopScanning();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.start();
        if (this.hasFrames() || this.video.readyState >= 2) {
          if (wasScanning && handler) this.startScanning(handler, cooldownMs);
          this.onStateChange?.("live");
          return;
        }
      } catch {
        // Camera still held elsewhere; back off and try again.
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    this.onStateChange?.("lost");
  }

  /**
   * Re-points at a different <video> element, moving the live stream with it.
   *
   * Defensive: if the element this camera was built around is ever replaced,
   * the stream would otherwise stay bound to a detached node and the on-screen
   * preview would render black while the camera light stays on.
   */
  attach(video: HTMLVideoElement): void {
    if (this.video === video) return;
    this.video = video;
    if (this.stream) {
      video.srcObject = this.stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      void video.play().catch(() => {});
    }
  }

  async start(): Promise<void> {
    if (this.stream) {
      // Already running: make sure the current element is showing it.
      if (this.video.srcObject !== this.stream) {
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => {});
      }
      return;
    }
    const q = QUALITY[this.quality];
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Rear camera. Resolution follows the quality setting: the photo has to
      // be legible enough to read a shipping label back off, which 720p was not.
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: q.width },
        height: { ideal: q.height },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "true");
    this.video.muted = true;
    await this.video.play();
    this.watchTrack();

    const Ctor = detectorCtor();
    if (Ctor) this.detector = new Ctor({ formats: FORMATS });
  }

  /**
   * A camera track that ends or goes muted is the failure this class exists to
   * survive, and it often fires with no page-level event alongside it.
   */
  private watchTrack(): void {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const wake = () => {
      if (document.visibilityState === "visible") void this.revive();
    };
    track.addEventListener("ended", wake);
    track.addEventListener("mute", wake);
    track.addEventListener("unmute", wake);
  }

  stop(): void {
    this.stopScanning();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Releases the page-level listeners. Call when the camera is discarded. */
  dispose(): void {
    this.stop();
    this.detached.forEach((off) => off());
    this.detached = [];
  }

  /**
   * Begins continuous detection. `onCode` fires at most once per
   * `cooldownMs` for any given value.
   */
  startScanning(onCode: BarcodeHandler, cooldownMs = 2500): void {
    if (!this.detector || this.scanning) return;
    this.scanning = true;
    // Remembered so a recovery can put detection back exactly as it was; the
    // scanner is usually the screen you are on when the phone rings.
    this.onCodeHandler = onCode;
    this.cooldownMs = cooldownMs;
    const session = ++this.session;

    const tick = async () => {
      if (!this.scanning || session !== this.session) return;
      try {
        if (this.video.readyState >= 2) {
          const hits = await this.detector!.detect(this.video);

          // Re-check after the await. detect() takes tens of milliseconds on a
          // 720p frame, which is easily long enough for the scanner to have
          // been closed in the meantime. Without this, a detection that landed
          // after the packer started packing would fire anyway and restart the
          // order mid-recording.
          if (!this.scanning || session !== this.session) return;

          const now = Date.now();
          for (const hit of hits) {
            const value = hit.rawValue?.trim();
            if (!value) continue;
            const last = this.cooldown.get(value) ?? 0;
            if (now - last < cooldownMs) continue;
            this.cooldown.set(value, now);
            onCode(value);
            break;
          }
        }
      } catch {
        // A dropped frame is not worth surfacing; the next tick retries.
      }
      if (!this.scanning || session !== this.session) return;
      this.timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
    };
    void tick();
  }

  stopScanning(): void {
    this.scanning = false;
    this.onCodeHandler = null;
    // Bumping the session invalidates any in-flight detection, so a promise
    // that resolves after this call cannot deliver a code.
    this.session++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  /** Clears the debounce so the same label can be scanned again deliberately. */
  resetCooldown(): void {
    this.cooldown.clear();
  }

  /**
   * Takes one still frame from the live stream.
   *
   * `ImageCapture.takePhoto()` first: it uses the sensor's photo mode, so on a
   * phone it returns a far larger image than the preview resolution — which
   * matters when the point of the shot is being able to read a label back off
   * it later. It is not universally implemented and can reject on devices that
   * do implement it, so a canvas grab of the current frame is always there as
   * a fallback; that yields exactly what is on screen, which is never wrong,
   * only smaller.
   */
  async capturePhoto(quality = 0.92): Promise<Blob | null> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return null;

    const Ctor = (globalThis as unknown as {
      ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> };
    }).ImageCapture;
    if (Ctor) {
      try {
        const shot = await new Ctor(track).takePhoto();
        if (shot.size > 0) return shot;
      } catch {
        // Fall through to the canvas grab below.
      }
    }

    const v = this.video;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (v.readyState < 2 || !w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
    );
  }
}
