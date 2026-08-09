"use client";

/**
 * One camera, two jobs.
 *
 * The packer points the phone at a label to scan it, then at the bench to
 * record packing, then back at the next label. Opening the camera twice would
 * fail on Android (the device is single-claim), so a single MediaStream is
 * opened once and shared: a <video> element renders it for barcode detection,
 * and a MediaRecorder writes the same stream to a file.
 *
 * That also means detection keeps running *during* recording, which is what
 * makes "scan the next order to finish this one" work without any button.
 */

export type BarcodeHandler = (value: string) => void;

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
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private detector: BarcodeDetectorLike | null = null;
  private raf = 0;
  private scanning = false;
  /** Codes seen recently, so one physical label is not read ten times a second. */
  private cooldown = new Map<string, number>();

  readonly video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Rear camera, and a resolution high enough to resolve a Code 128 bar
      // pattern without producing enormous video files.
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "true");
    this.video.muted = true;
    await this.video.play();

    const Ctor = detectorCtor();
    if (Ctor) this.detector = new Ctor({ formats: FORMATS });
  }

  stop(): void {
    this.stopScanning();
    this.recorder?.state === "recording" && this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /**
   * Begins continuous detection. `onCode` fires at most once per
   * `cooldownMs` for any given value.
   */
  startScanning(onCode: BarcodeHandler, cooldownMs = 2500): void {
    if (!this.detector || this.scanning) return;
    this.scanning = true;

    const tick = async () => {
      if (!this.scanning) return;
      try {
        if (this.video.readyState >= 2) {
          const hits = await this.detector!.detect(this.video);
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
      this.raf = requestAnimationFrame(() => void tick());
    };
    void tick();
  }

  stopScanning(): void {
    this.scanning = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Clears the debounce so the same label can be scanned again deliberately. */
  resetCooldown(): void {
    this.cooldown.clear();
  }

  private static mimeType(): string {
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];
    return (
      candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "video/webm"
    );
  }

  startRecording(): void {
    if (!this.stream || this.recorder?.state === "recording") return;
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: Camera.mimeType(),
      // ~1.5 Mbps keeps a few minutes of packing well under 20 MB, which
      // matters because these are stored on the phone.
      videoBitsPerSecond: 1_500_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
  }

  /** Stops recording and resolves with the finished clip. */
  stopRecording(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state !== "recording") {
        resolve(null);
        return;
      }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType });
        this.chunks = [];
        this.recorder = null;
        resolve(blob.size > 0 ? blob : null);
      };
      rec.stop();
    });
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }
}
