"use client";

/**
 * Haptics and audio cues.
 *
 * The packer is looking at the box, not the screen, so confirmation has to be
 * felt and heard. Tones are synthesised with the Web Audio API rather than
 * shipped as files: no download, no decode delay, and nothing to cache.
 */

let ctx: AudioContext | null = null;

/**
 * AudioContext must be created or resumed inside a user gesture. Every call
 * site here is downstream of a tap or a scan, so this is safe to call lazily.
 */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Plays a sequence of short notes. `[frequency Hz, start s, length s]`. */
function play(notes: [number, number, number][], gainPeak = 0.22) {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;

  for (const [freq, at, dur] of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    // A triangle wave is soft enough to hear all day without becoming grating.
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now + at);
    // Shaped attack and decay: a raw gate would click on every note.
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(gainPeak, now + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + at);
    osc.stop(now + at + dur + 0.02);
  }
}

/** Warms the audio pipeline on first user gesture, so the first cue is instant. */
export function primeAudio(): void {
  audio();
}

/** A label resolved to an order: short tick, single firm buzz. */
export function cueScanOk(): void {
  navigator.vibrate?.(70);
  play([[880, 0, 0.08]], 0.16);
}

/** Nothing matched: low double buzz, descending two-tone. */
export function cueScanFail(): void {
  navigator.vibrate?.([90, 70, 90]);
  play(
    [
      [320, 0, 0.13],
      [220, 0.14, 0.2],
    ],
    0.2,
  );
}

/** Already counted, or otherwise a no-op: one soft blip, no vibration. */
export function cueNeutral(): void {
  navigator.vibrate?.(30);
  play([[600, 0, 0.07]], 0.12);
}

/** An order is finished: rising three-note major arpeggio (C–E–G). */
export function cueOrderDone(): void {
  navigator.vibrate?.([50, 45, 90]);
  play([
    [523.25, 0, 0.12],
    [659.25, 0.1, 0.12],
    [783.99, 0.2, 0.26],
  ]);
}

/** A whole group finished: the same arpeggio topped with the octave. */
export function cueGroupDone(): void {
  navigator.vibrate?.([60, 50, 60, 50, 120]);
  play([
    [523.25, 0, 0.12],
    [659.25, 0.1, 0.12],
    [783.99, 0.2, 0.12],
    [1046.5, 0.3, 0.34],
  ]);
}

/** Every order in the batch is packed: longer, unmistakable flourish. */
export function cueBatchDone(): void {
  navigator.vibrate?.([80, 60, 80, 60, 200]);
  play([
    [523.25, 0, 0.14],
    [659.25, 0.12, 0.14],
    [783.99, 0.24, 0.14],
    [1046.5, 0.36, 0.16],
    [1318.5, 0.5, 0.45],
  ]);
}
