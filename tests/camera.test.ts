import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression tests for the detection lifecycle.
 *
 * The bug these cover: `BarcodeDetector.detect()` is awaited, and on a 720p
 * frame it takes tens of milliseconds. If the scanner closed during that await,
 * the resolved detection still fired — so a barcode lying on the bench could
 * end the order that was being packed and restart the recording.
 */

interface FakeDetector {
  detect(src: unknown): Promise<{ rawValue: string }[]>;
}

/** Minimal DOM/global shims so camera.ts can be exercised under Node. */
function installGlobals(detectDelayMs: number, value = "DNL123456789") {
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => (resolveGate = r));

  class BarcodeDetector implements FakeDetector {
    async detect() {
      // Hold the promise open so the test can close the scanner mid-await.
      if (detectDelayMs < 0) await gate;
      else await new Promise((r) => setTimeout(r, detectDelayMs));
      return [{ rawValue: value }];
    }
  }

  (globalThis as Record<string, unknown>).BarcodeDetector = BarcodeDetector;
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void) =>
    setTimeout(cb, 8) as unknown as number;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) =>
    clearTimeout(id);

  return { releaseDetect: () => resolveGate?.() };
}

/** A stand-in for the <video> element the camera reads frames from. */
const fakeVideo = () =>
  ({ readyState: 4, srcObject: null, setAttribute() {}, play: async () => {}, muted: false }) as unknown as HTMLVideoElement;

test("a detection that resolves after stopScanning is discarded", async () => {
  const { releaseDetect } = installGlobals(-1);
  const { Camera } = await import("../src/lib/camera.ts");

  const cam = new Camera(fakeVideo());
  // Bypass getUserMedia: only the detection loop is under test.
  (cam as unknown as { detector: FakeDetector }).detector = new (
    globalThis as unknown as { BarcodeDetector: new () => FakeDetector }
  ).BarcodeDetector();

  const seen: string[] = [];
  cam.startScanning((v) => seen.push(v));
  assert.equal(cam.isScanning, true);

  // The packer taps a label, the scanner closes, packing begins — all while
  // detect() is still in flight.
  cam.stopScanning();
  assert.equal(cam.isScanning, false);

  releaseDetect();
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(seen, [], "a late detection must not deliver a code");
});

test("codes are delivered normally while the scanner is open", async () => {
  installGlobals(5, "274080065");
  const { Camera } = await import("../src/lib/camera.ts");

  const cam = new Camera(fakeVideo());
  (cam as unknown as { detector: FakeDetector }).detector = new (
    globalThis as unknown as { BarcodeDetector: new () => FakeDetector }
  ).BarcodeDetector();

  const seen: string[] = [];
  cam.startScanning((v) => seen.push(v));
  await new Promise((r) => setTimeout(r, 80));
  cam.stopScanning();

  assert.ok(seen.length >= 1, "an open scanner still reads codes");
  assert.equal(seen[0], "274080065");
});

test("the same label is not re-delivered inside the cooldown", async () => {
  installGlobals(2, "SAME");
  const { Camera } = await import("../src/lib/camera.ts");

  const cam = new Camera(fakeVideo());
  (cam as unknown as { detector: FakeDetector }).detector = new (
    globalThis as unknown as { BarcodeDetector: new () => FakeDetector }
  ).BarcodeDetector();

  const seen: string[] = [];
  cam.startScanning((v) => seen.push(v), 5000);
  await new Promise((r) => setTimeout(r, 120));
  cam.stopScanning();

  assert.equal(seen.length, 1, "one physical label yields exactly one hit");
});
