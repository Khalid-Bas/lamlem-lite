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

/**
 * Reads text aloud in Arabic.
 *
 * Used to announce what an order contains the moment its label scans, so the
 * packer hears what to put in the box without looking up from the bench.
 * Anything already queued is cancelled first — a stale announcement talking
 * over the current order is worse than silence.
 */
export function speak(text: string): void {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth || !text.trim()) return;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ar-SA";
    // Slightly brisk: these are short phrases heard many times a day.
    u.rate = 1.05;
    u.pitch = 1;
    const arabic = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith("ar"));
    if (arabic) u.voice = arabic;
    synth.speak(u);
  } catch {
    // No speech engine on this device: the visual card is still there.
  }
}

export function stopSpeaking(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* nothing to cancel */
  }
}

/** True when the device can speak at all. */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && Boolean(window.speechSynthesis);
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

/* ══════════════ ambient alert while packing ══════════════ */

let ambient: { out: GainNode; timer: ReturnType<typeof setInterval> } | null = null;

/**
 * Quiet piano that plays for as long as a flagged item is being packed.
 *
 * Deliberately music rather than an alarm: it runs for the whole order, and
 * anything sharp would be unbearable by the tenth box. It has to stay
 * *noticeable*, though — the earlier sustained drone blended into warehouse
 * noise and stopped registering after a minute, which defeats the point.
 */
export function startAmbient(): void {
  const ac = audio();
  if (!ac || ambient) return;
  try {
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, ac.currentTime);
    // Fade in over a second: an abrupt start reads as an error sound.
    out.gain.exponentialRampToValueAtTime(0.5, ac.currentTime + 1);
    out.connect(ac.destination);

    /**
     * A slow piano-ish arpeggio rather than a held drone.
     *
     * A sustained two-note pad blends into warehouse noise and stops being
     * noticed after a minute. Repeating plucked notes stay audible without
     * being harsh, and read as "music playing" rather than "something is
     * broken". Each note is a decaying sine plus a quieter octave, which is
     * roughly what makes a struck string sound like one.
     */
    const NOTES = [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25]; // C E G C G E
    const STEP = 0.62;
    let step = 0;

    const pluck = (freq: number, at: number) => {
      for (const [mult, level] of [[1, 0.22], [2, 0.07]] as const) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(freq * mult, at);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(level, at + 0.012);
        // Long exponential tail — the decay is what sells it as a piano.
        g.gain.exponentialRampToValueAtTime(0.0001, at + 1.5);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + 1.6);
      }
    };

    // Scheduled a little ahead of time so the rhythm never stutters, and
    // driven by a timer so it keeps going for as long as the order is open.
    const schedule = () => {
      const now = ac.currentTime;
      while (nextAt < now + 1.2) {
        pluck(NOTES[step % NOTES.length], nextAt);
        step++;
        nextAt += STEP;
      }
    };
    let nextAt = ac.currentTime + 0.05;
    schedule();
    const timer = setInterval(schedule, 400);

    ambient = { out, timer };
  } catch {
    // Audio is a helper here; never let it break packing.
  }
}

export function stopAmbient(): void {
  const ac = audio();
  if (!ambient || !ac) return;
  const { out, timer } = ambient;
  ambient = null;
  try {
    // Stop scheduling new notes, then fade what is already sounding.
    clearInterval(timer);
    out.gain.cancelScheduledValues(ac.currentTime);
    out.gain.setValueAtTime(Math.max(out.gain.value, 0.0001), ac.currentTime);
    out.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
    setTimeout(() => {
      try {
        out.disconnect();
      } catch {
        /* already detached */
      }
    }, 700);
  } catch {
    /* already stopped */
  }
}

/** True while the look-twice music is sounding. */
export function isAmbientPlaying(): boolean {
  return ambient !== null;
}

/**
 * Scanning a label whose order contains a flagged item: a long, unmistakable
 * buzz plus a low double note, distinct from the ordinary scan tick.
 */
export function cueAlertScan(): void {
  navigator.vibrate?.([180, 90, 180]);
  play(
    [
      [392, 0, 0.18],
      [523.25, 0.2, 0.3],
    ],
    0.26,
  );
}
