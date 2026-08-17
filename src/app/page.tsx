"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, canScan } from "@/lib/camera";
import { buildBatch, linkCatalog, describeOrder, type BuildProgress, type BuildStats } from "@/lib/build-batch";
import { readCatalog } from "@/lib/catalog-load";
import {
  clearAll, formatBytes, formatDuration, loadBatch, loadVideo,
  saveBatch, saveVideo, upsertRecord, usage,
} from "@/lib/store";
import { buildAliases, resolveScan } from "@/lib/barcode";
import { driveConfigured, ensureFolder, folderName, getAccessToken, uploadFile, uploadText, safeFileName, clipFileName } from "@/lib/drive";
import {
  primeAudio, cueScanOk, cueScanFail, cueNeutral,
  cueOrderDone, cueGroupDone, cueBatchDone, speak, stopSpeaking, canSpeak,
} from "@/lib/feedback";
import { loadSettings, saveSettings, QUALITY, DEFAULTS, type Settings as Prefs } from "@/lib/settings";
import { useBackGuard } from "@/lib/use-back-guard";
import type { Batch, PackOrder, PackRecord } from "@/lib/types";

type Mode = "setup" | "idle" | "packing" | "group-collect" | "group-recording" | "group-verify";
type ScanPurpose = "single" | "group-collect" | "group-verify" | "verify-one";
type Flash = { kind: "bad" | "warn" | "ok"; text: string } | null;

export default function App() {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [mode, setMode] = useState<Mode>("setup");
  const [current, setCurrent] = useState<PackOrder | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [camError, setCamError] = useState("");
  const [scanFor, setScanFor] = useState<ScanPurpose | null>(null);
  const [sheet, setSheet] = useState<"orders" | "summary" | "settings" | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  /** Order awaiting a confirming re-scan after being packed. */
  const [verifyOne, setVerifyOne] = useState<PackOrder | null>(null);
  /** Order being previewed from the list. Viewing never starts a recording. */
  const [preview, setPreview] = useState<PackOrder | null>(null);
  /** Bumped once the camera exists, so the scanning effect can re-run. */
  const [camReady, setCamReady] = useState(0);

  // Group session state
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [verified, setVerified] = useState<string[]>([]);
  const [manualPick, setManualPick] = useState(false);
  const groupIdRef = useRef<string>("");

  /** Adds/ticks an order without scanning, for when a label will not read. */
  const addManually = useCallback((id: string) => {
    if (modeRef.current === "group-collect") {
      setGroupIds((ids) => {
        if (ids.includes(id)) { cueNeutral(); return ids; }
        cueScanOk();
        return [...ids, id];
      });
    } else if (modeRef.current === "group-verify") {
      setVerified((v) => {
        if (v.includes(id)) { cueNeutral(); return v; }
        cueScanOk();
        return [...v, id];
      });
    }
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<Camera | null>(null);

  // Refs so the scan callback, created once, always sees current values.
  const batchRef = useRef<Batch | null>(null);
  const currentRef = useRef<PackOrder | null>(null);
  const startedAtRef = useRef(0);
  const modeRef = useRef<Mode>("setup");
  const groupIdsRef = useRef<string[]>([]);
  batchRef.current = batch;
  currentRef.current = current;
  startedAtRef.current = startedAt;
  modeRef.current = mode;
  groupIdsRef.current = groupIds;

  useEffect(() => {
    setPrefs(loadSettings());
    void loadBatch().then((b) => {
      if (b) { setBatch(b); setMode("idle"); }
    });
  }, []);

  const prefsRef = useRef<Prefs>(DEFAULTS);
  prefsRef.current = prefs;
  const scanForRef = useRef<ScanPurpose | null>(null);
  const verifyOneRef = useRef<PackOrder | null>(null);
  const previewRef = useRef<PackOrder | null>(null);
  const sheetRef = useRef<"orders" | "summary" | "settings" | null>(null);
  scanForRef.current = scanFor;
  verifyOneRef.current = verifyOne;
  previewRef.current = preview;
  sheetRef.current = sheet;

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      saveSettings(next);
      if (patch.videoQuality) camRef.current?.setQuality(patch.videoQuality);
      return next;
    });
  }, []);

  const aliases = useMemo(
    () =>
      (batch?.orders ?? []).flatMap((o) =>
        buildAliases({ id: o.id, orderNumber: o.orderNumber, trackingRaw: o.trackingRaw }),
      ),
    [batch],
  );
  const aliasesRef = useRef(aliases);
  aliasesRef.current = aliases;

  const packedIds = useMemo(
    () => new Set((batch?.records ?? []).map((r) => r.orderId)),
    [batch],
  );
  const total = batch?.orders.length ?? 0;
  const done = packedIds.size;
  const allDone = total > 0 && done === total;

  /* ── camera: opened on demand, kept alive while a recording is running ── */
  const ensureCamera = useCallback(async (): Promise<Camera | null> => {
    if (!videoRef.current) return null;
    const cam = camRef.current ?? new Camera(videoRef.current, prefsRef.current.videoQuality);
    camRef.current = cam;
    // Re-bind in case React handed us a different element since last time.
    cam.attach(videoRef.current);
    try {
      await cam.start();
      setCamError("");
      setCamReady((n) => n + 1);
      return cam;
    } catch (e) {
      setCamError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "لم يُسمح باستخدام الكاميرا. افتح إعدادات المتصفح واسمح بالكاميرا لهذا الموقع."
          : "تعذّر فتح الكاميرا على هذا الجهاز.",
      );
      return null;
    }
  }, []);

  useEffect(() => () => camRef.current?.stop(), []);

  useEffect(() => {
    if (mode !== "packing" && mode !== "group-recording") return;
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 500);
    return () => clearInterval(id);
  }, [mode]);

  /* ── single-order pack ── */
  const finishCurrent = useCallback(async () => {
    const order = currentRef.current;
    const cam = camRef.current;
    if (!order || !cam) return;

    const durationMs = Date.now() - startedAtRef.current;
    const blob = await cam.stopRecording();
    setRecording(false);
    if (blob) await saveVideo(order.id, blob);

    const base = batchRef.current;
    if (base) {
      const next = upsertRecord(base, {
        orderId: order.id,
        durationMs,
        packedAt: new Date().toISOString(),
        hasVideo: Boolean(blob),
        videoBytes: blob?.size,
        videoKey: blob ? order.id : undefined,
      });
      batchRef.current = next;
      setBatch(next);
      void saveBatch(next);
      // The last order of a batch gets its own, unmistakable flourish.
      if (next.records.length >= next.orders.length) cueBatchDone();
      else cueOrderDone();
    }
    setCurrent(null);
  }, []);

  const beginOrder = useCallback((order: PackOrder) => {
    setCurrent(order);
    currentRef.current = order;
    const now = Date.now();
    setStartedAt(now);
    startedAtRef.current = now;
    setElapsed(0);
    setMode("packing");
    modeRef.current = "packing";
    setFlash(null);
    camRef.current?.startRecording();
    setRecording(Boolean(camRef.current?.isRecording));
  }, []);

  /* ── every scan lands here ── */
  const onCode = useCallback(
    async (raw: string) => {
      const res = resolveScan(raw, aliasesRef.current);
      if (res.kind === "yellow") {
        setFlash({ kind: "bad", text: `باركود غير معروف: ${raw}` });
        cueScanFail();
        return;
      }
      if (res.kind === "orange") {
        setFlash({ kind: "warn", text: "أكثر من طلب يطابق — اختر يدويًا" });
        cueScanFail();
        return;
      }

      const order = batchRef.current?.orders.find((o) => o.id === res.orderId);
      if (!order) return;
      const m = modeRef.current;

      if (m === "group-collect") {
        setGroupIds((ids) => {
          if (ids.includes(order.id)) {
            setFlash({ kind: "warn", text: `#${order.orderNumber} مضاف مسبقًا` });
            cueNeutral();
            return ids;
          }
          cueScanOk();
          setFlash({ kind: "ok", text: `أُضيف #${order.orderNumber}` });
          return [...ids, order.id];
        });
        return;
      }

      if (m === "group-verify") {
        if (!groupIdsRef.current.includes(order.id)) {
          setFlash({ kind: "bad", text: `#${order.orderNumber} ليس ضمن هذه المجموعة` });
          cueScanFail();
          return;
        }
        setVerified((v) => (v.includes(order.id) ? v : [...v, order.id]));
        cueScanOk();
        return;
      }

      if (scanForRef.current === "verify-one") {
        const target = verifyOneRef.current;
        if (!target || order.id !== target.id) {
          setFlash({ kind: "bad", text: `هذا #${order.orderNumber} — المطلوب #${target?.orderNumber}` });
          cueScanFail();
          return;
        }
        // Stamp the record so an unverified box is visible in the summary.
        const base = batchRef.current;
        if (base) {
          const next = {
            ...base,
            records: base.records.map((r) =>
              r.orderId === order.id ? { ...r, verified: true } : r,
            ),
          };
          batchRef.current = next;
          setBatch(next);
          void saveBatch(next);
        }
        cueScanOk();
        setVerifyOne(null);
        setScanFor(null);
        setFlash({ kind: "ok", text: `تم التحقق من #${order.orderNumber}` });
        return;
      }

      // Single-order flow. Detection must stop the moment a label resolves —
      // otherwise it keeps running behind the packing screen and the next
      // barcode in view would end the order on its own.
      const active = currentRef.current;
      camRef.current?.stopScanning();

      if (active && active.id === order.id) {
        cueScanOk();
        await finishCurrent();
        setScanFor(null);
        setMode("idle");
        modeRef.current = "idle";
        await askVerifyRef.current(order);
        return;
      }
      if (active) await finishCurrent();
      cueScanOk();
      setScanFor(null);
      beginOrder(order);
      // Announce what goes in the box, so the packer need not look up.
      if (prefsRef.current.voice) speak(describeOrder(order));
    },
    [beginOrder, finishCurrent],
  );
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  /* ── the scanner overlay drives detection only while it is open ── */
  const openScanner = useCallback(
    async (purpose: ScanPurpose) => {
      primeAudio();
      setScanFor(purpose);
      setFlash(null);
      await ensureCamera();
    },
    [ensureCamera],
  );

  /**
   * Detection is bound to the scanner being open, and to nothing else.
   *
   * Driving start/stop from this one effect — rather than imperatively from
   * each call site — makes it structurally impossible for the detector to be
   * running while the packer is packing. Previously a missed stop meant a
   * barcode drifting into view would end the order and restart the recording.
   */
  useEffect(() => {
    const cam = camRef.current;
    if (!cam) return;
    if (scanFor) {
      cam.resetCooldown();
      cam.startScanning((v) => void onCodeRef.current(v));
    } else {
      cam.stopScanning();
    }
    return () => cam.stopScanning();
  }, [scanFor, camReady]);

  /**
   * Closes the scanner UI and stops detection, but deliberately leaves the
   * camera stream open for the rest of the batch.
   *
   * Tearing the stream down on every close meant each scan had to re-acquire
   * the camera — several hundred milliseconds on a phone, during which the
   * preview is black. The stream is released on reset and on unmount instead.
   */
  const openScannerRef = useRef(openScanner);
  openScannerRef.current = openScanner;

  const closeScanner = useCallback(() => {
    camRef.current?.stopScanning();
    setScanFor(null);
    setVerifyOne(null);
  }, []);

  /**
   * Asks for a confirming re-scan of the order just packed.
   *
   * The point is catching a box that was filled from the wrong order: the
   * label on the sealed box is scanned again and must match what was packed.
   */
  const askVerify = useCallback(
    async (order: PackOrder) => {
      if (!prefsRef.current.verifyAfterPack) return false;
      setVerifyOne(order);
      verifyOneRef.current = order;
      await openScannerRef.current("verify-one");
      return true;
    },
    [],
  );
  const askVerifyRef = useRef(askVerify);
  askVerifyRef.current = askVerify;

  /**
   * Android's back button closes whatever is on top, innermost first, instead
   * of leaving the site. Only when nothing is open does it offer to exit.
   */
  useBackGuard(
    () => {
      if (scanForRef.current) { closeScanner(); return true; }
      if (previewRef.current) { setPreview(null); return true; }
      if (sheetRef.current) { setSheet(null); return true; }
      return false;
    },
    () => confirm("هل أنت متأكد من أنك تريد الخروج من الصفحة؟"),
  );

  /* ── group session ── */
  const startGroup = useCallback(async () => {
    setGroupIds([]);
    setVerified([]);
    groupIdRef.current = `g${Date.now().toString(36)}`;
    setMode("group-collect");
    modeRef.current = "group-collect";
    await openScanner("group-collect");
  }, [openScanner]);

  const beginGroupRecording = useCallback(async () => {
    closeScanner();
    const cam = await ensureCamera();
    const now = Date.now();
    setStartedAt(now);
    startedAtRef.current = now;
    setElapsed(0);
    setMode("group-recording");
    modeRef.current = "group-recording";
    cam?.startRecording();
    setRecording(Boolean(cam?.isRecording));
  }, [closeScanner, ensureCamera]);

  const stopGroupRecording = useCallback(async () => {
    const cam = camRef.current;
    const blob = await cam?.stopRecording();
    setRecording(false);
    // Saved immediately, before verification: abandoning the check must never
    // destroy footage that has already been filmed.
    if (blob) await saveVideo(groupIdRef.current, blob);
    (window as unknown as { __lamlemGroupBytes?: number }).__lamlemGroupBytes = blob?.size ?? 0;
    setVerified([]);
    setMode("group-verify");
    modeRef.current = "group-verify";
    await openScanner("group-verify");
  }, [openScanner]);

  const commitGroup = useCallback(
    async (ids: string[]) => {
      closeScanner();
      const base = batchRef.current;
      if (!base) return;
      const bytes =
        (window as unknown as { __lamlemGroupBytes?: number }).__lamlemGroupBytes ?? 0;
      const per = ids.length ? (Date.now() - startedAtRef.current) / ids.length : 0;

      let next = base;
      for (const id of ids) {
        next = upsertRecord(next, {
          orderId: id,
          // A group video covers several orders, so the per-order figure is the
          // session split evenly — labelled as such in the summary.
          durationMs: Math.round(per),
          packedAt: new Date().toISOString(),
          hasVideo: bytes > 0,
          // The whole clip belongs to each of these orders; storing a
          // share of it made the summary understate the file size.
          videoBytes: bytes > 0 ? bytes : undefined,
          videoKey: bytes > 0 ? groupIdRef.current : undefined,
          groupId: groupIdRef.current,
          groupSize: ids.length,
        });
      }
      batchRef.current = next;
      setBatch(next);
      await saveBatch(next);
      setGroupIds([]);
      setVerified([]);
      setMode("idle");
      modeRef.current = "idle";
      setFlash({ kind: "ok", text: `تم تسجيل ${ids.length} طلب` });
      if (next.records.length >= next.orders.length) cueBatchDone();
      else cueGroupDone();
    },
    [closeScanner],
  );

  if (mode === "setup") {
    return (
      <Setup
        onReady={(b) => { setBatch(b); void saveBatch(b); setMode("idle"); }}
      />
    );
  }

  const orders = batch?.orders ?? [];
  const groupOrders = groupIds
    .map((id) => orders.find((o) => o.id === id))
    .filter((o): o is PackOrder => Boolean(o));

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="count">
            {done}
            <small> / {total}</small>
          </div>
          <div className="lbl">طلب جاهز</div>
        </div>
        <div className="bar">
          <i style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
        </div>
        {(mode === "packing" || mode === "group-recording") && (
          <>
            <span className="timer">{formatDuration(elapsed)}</span>
            {recording ? (
              <span className="rec"><i />تسجيل</span>
            ) : (
              <span className="chip">بلا فيديو</span>
            )}
          </>
        )}
        {/* Available during packing too: opening the list only previews now, so
            browsing another order can no longer disturb the recording. */}
        {mode !== "group-recording" && (
          <button className="chip" onClick={() => setSheet("orders")}>الطلبات</button>
        )}
      </header>

      <main className="main">
        {camError && <div className="err">{camError}</div>}
        {!canScan() && !camError && (
          <div className="err">
            هذا المتصفح لا يدعم قراءة الباركود بالكاميرا. استخدم Chrome على
            أندرويد، أو اختر الطلب يدويًا من زر «الطلبات».
          </div>
        )}
        {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}

        {/* The scan button occupies the space the live preview used to. */}
        {(mode === "idle" || mode === "packing") && (
          <button className="btn b-scan" onClick={() => void openScanner("single")}>
            <ScanIcon />
            {mode === "packing" ? "مسح باركود الطلب التالي" : "مسح الباركود"}
          </button>
        )}

        {mode === "idle" && (
          <>
            <button className="btn b-line" onClick={() => void startGroup()}>
              تجهيز مجموعة طلبات
            </button>
            <p className="note" style={{ textAlign: "center" }}>
              {allDone
                ? "تم تجهيز كل الطلبات 🎉"
                : `متبقٍ ${total - done} طلب — امسح الباركود للبدء.`}
            </p>
            {done > 0 && (
              <button className="btn b-ghost" onClick={() => setSheet("summary")}>
                عرض الملخّص والفيديوهات ({done})
              </button>
            )}
            <button className="btn b-ghost" onClick={() => setSheet("settings")}>
              الإعدادات
            </button>
          </>
        )}

        {mode === "packing" && current && (
          <>
            <OrderCard order={current} />
            <button
              className="btn b-go"
              onClick={() =>
                void (async () => {
                  const packed = currentRef.current;
                  await finishCurrent();
                  setMode("idle");
                  modeRef.current = "idle";
                  if (packed) await askVerify(packed);
                })()
              }
            >
              تم — أنهِ هذا الطلب
            </button>
          </>
        )}

        {mode === "group-recording" && (
          <>
            <h3 style={{ fontSize: 16 }}>
              تسجيل مجموعة — {groupOrders.length} طلب
            </h3>
            {groupOrders.map((o) => (
              <OrderCard key={o.id} order={o} compact />
            ))}
            <button className="btn b-stop" onClick={() => void stopGroupRecording()}>
              إيقاف التسجيل والتحقق
            </button>
          </>
        )}
      </main>

      {/*
        The preview element is mounted exactly once, for the whole session, and
        only restyled when the scanner opens. Rendering a second <video> for the
        overlay meant the stream stayed attached to the element React had just
        unmounted, so the camera ran but the preview was black.
      */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className={scanFor ? "scan-video" : "cam-hidden"}
      />

      {/* ── scanner chrome, drawn over the preview ── */}
      {scanFor && (
        <ScannerOverlay
          title={
            scanFor === "group-collect"
              ? `اختيار المجموعة — ${groupIds.length} طلب`
              : scanFor === "group-verify"
                ? `تحقق — ${verified.length} / ${groupIds.length}`
                : scanFor === "verify-one"
                  ? `تحقق — امسح بوليصة #${verifyOne?.orderNumber} مرة أخرى`
                  : "وجّه الكاميرا نحو الباركود"
          }
          flash={flash}
          onClose={() => {
            if (scanFor === "group-collect" && groupIds.length === 0) {
              setMode("idle");
              modeRef.current = "idle";
            }
            closeScanner();
          }}
          footer={
            scanFor === "group-collect" ? (
              <>
                <GroupList orders={groupOrders} />
                <button className="btn b-ghost" onClick={() => setManualPick((v) => !v)}>
                  {manualPick ? "إخفاء الإضافة اليدوية" : "إضافة يدويًا"}
                </button>
                {manualPick && (
                  <ManualPicker
                    orders={orders.filter(
                      (o) => !packedIds.has(o.id) && !groupIds.includes(o.id),
                    )}
                    onAdd={addManually}
                  />
                )}
                <button
                  className="btn b-go"
                  disabled={groupIds.length === 0}
                  onClick={() => void beginGroupRecording()}
                >
                  ابدأ التسجيل ({groupIds.length})
                </button>
              </>
            ) : scanFor === "verify-one" ? (
              <>
                <p className="note">
                  امسح بوليصة الصندوق المغلق للتأكد أنه الطلب الصحيح.
                </p>
                <button className="btn b-ghost" onClick={closeScanner}>
                  تخطَّ التحقق
                </button>
              </>
            ) : scanFor === "group-verify" ? (
              <>
                <GroupList orders={groupOrders} verified={verified} />
                <button className="btn b-ghost" onClick={() => setManualPick((v) => !v)}>
                  {manualPick ? "إخفاء التأكيد اليدوي" : "تأكيد يدويًا"}
                </button>
                {manualPick && (
                  <ManualPicker
                    orders={groupOrders.filter((o) => !verified.includes(o.id))}
                    onAdd={addManually}
                  />
                )}
                {verified.length === groupIds.length ? (
                  <button className="btn b-go" onClick={() => void commitGroup(groupIds)}>
                    تأكيد — سجّل {groupIds.length} طلب
                  </button>
                ) : (
                  <button
                    className="btn b-line"
                    onClick={() => {
                      if (
                        confirm(
                          `${groupIds.length - verified.length} طلب لم يُمسح. تسجيل الممسوح فقط؟`,
                        )
                      ) {
                        void commitGroup(verified);
                      }
                    }}
                  >
                    سجّل الممسوح فقط ({verified.length})
                  </button>
                )}
              </>
            ) : null
          }
        />
      )}

      {sheet === "orders" && batch && (
        <Sheet title="الطلبات" onClose={() => setSheet(null)}>
          <p className="note">اضغط على أي طلب لمعاينته قبل بدء التعبئة.</p>
          <div className="list">
            {orders.map((o, i) => (
              <button
                className="lrow"
                key={o.id}
                // Opens a read-only preview. Starting a recording from here
                // used to happen on the first tap, which could cut short — and
                // overwrite — a recording already in progress.
                onClick={() => setPreview(o)}
              >
                <span className="n">{i + 1}</span>
                <span className="t">
                  <b>#{o.orderNumber}</b>
                  <span>
                    {o.customerName ?? "—"}
                    {o.city ? ` · ${o.city}` : ""} · {o.items.length} صنف
                  </span>
                </span>
                {packedIds.has(o.id) && <span className="chip done">تم</span>}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {preview && (
        <OrderPreview
          order={preview}
          index={orders.findIndex((o) => o.id === preview.id)}
          count={orders.length}
          onStep={(d) => {
            const i = orders.findIndex((o) => o.id === preview.id);
            const next = orders[i + d];
            if (next) setPreview(next);
          }}
          packed={packedIds.has(preview.id)}
          record={batch?.records.find((r) => r.orderId === preview.id)}
          busyWith={current}
          onClose={() => setPreview(null)}
          onStart={() => {
            const o = preview;
            setPreview(null);
            setSheet(null);
            void (async () => {
              if (currentRef.current) await finishCurrent();
              await ensureCamera();
              beginOrder(o);
            })();
          }}
        />
      )}

      {sheet === "settings" && (
        <SettingsSheet
          prefs={prefs}
          onChange={updatePrefs}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === "summary" && batch && (
        <Summary
          batch={batch}
          allDone={allDone}
          onClose={() => setSheet(null)}
          onReset={async () => {
            await clearAll();
            camRef.current?.stop();
            camRef.current = null;
            setBatch(null);
            setCurrent(null);
            setSheet(null);
            setMode("setup");
          }}
          onRelink={async (file) => {
            const products = await readCatalog(file);
            const base = batchRef.current;
            if (!base) return "";
            const { orders: next, withPhoto } = linkCatalog(base.orders, products);
            const updated = { ...base, orders: next };
            batchRef.current = updated;
            setBatch(updated);
            await saveBatch(updated);
            const items = next.reduce((s, o) => s + o.items.length, 0);
            return `${withPhoto} من ${items} صنف له صورة الآن`;
          }}
        />
      )}
    </div>
  );
}

/* ══════════════ scanner overlay ══════════════ */

/** Overlay chrome only — the preview itself is the single hoisted <video>. */
function ScannerOverlay({
  title, flash, onClose, footer,
}: {
  title: string;
  flash: Flash;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  return (
    <div className="scanner">
      <div className="scanner-cam">
        <div className="reticle" />
        <div className="camhint">{title}</div>
      </div>
      <div className="scanner-foot">
        {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}
        {footer}
        <button className="btn b-line" onClick={onClose}>إغلاق</button>
      </div>
    </div>
  );
}

/** Tap-to-add list, used when a barcode refuses to scan. */
function ManualPicker({
  orders, onAdd,
}: {
  orders: PackOrder[];
  onAdd: (id: string) => void;
}) {
  if (orders.length === 0) return <p className="note">لا طلبات متبقية.</p>;
  return (
    <div className="list scrolly" style={{ maxHeight: "26dvh" }}>
      {orders.map((o) => (
        <button className="lrow" key={o.id} onClick={() => onAdd(o.id)}>
          <span className="t">
            <b>#{o.orderNumber}</b>
            <span>{o.customerName ?? "—"}</span>
          </span>
          <span className="chip">إضافة</span>
        </button>
      ))}
    </div>
  );
}

function GroupList({ orders, verified }: { orders: PackOrder[]; verified?: string[] }) {
  if (orders.length === 0) {
    return <p className="note">امسح بوليصات الطلبات التي ستعبّئها معًا.</p>;
  }
  return (
    <div className="list scrolly" style={{ maxHeight: "30dvh" }}>
      {orders.map((o, i) => (
        <div className="lrow" key={o.id}>
          <span className="n">{i + 1}</span>
          <span className="t">
            <b>#{o.orderNumber}</b>
            <span>{o.customerName ?? "—"}</span>
          </span>
          {verified && (
            <span className={`chip ${verified.includes(o.id) ? "done" : ""}`}>
              {verified.includes(o.id) ? "تم" : "بانتظار"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ══════════════ order card ══════════════ */

function OrderCard({ order, compact }: { order: PackOrder; compact?: boolean }) {
  const single = order.items.length === 1 && !compact;
  return (
    <>
      <div className="ohead">
        <span className="oid">#{order.orderNumber}</span>
        {order.customerName && (
          <span className="who">
            {order.customerName}
            {order.city ? ` · ${order.city}` : ""}
          </span>
        )}
        {order.paymentType === "cod" && (
          <span className="chip cod">
            تحصيل {order.totalAmount ? `${order.totalAmount} ر.س` : ""}
          </span>
        )}
      </div>

      <div className="items" data-n={single ? 1 : 2}>
        {order.items.map((it, i) => (
          <div className="item" key={`${it.name}-${i}`}>
            <div className="pic">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.imageUrl}
                  alt=""
                  loading="eager"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <span>بلا صورة</span>
              )}
            </div>
            {single ? (
              <div className="row2">
                <div className="txt">
                  <div className="nm">{it.name}</div>
                  {it.optionText && (
                    <div className={`opt ${it.optionVerified ? "" : "unsure"}`}>
                      {it.optionText}
                      {!it.optionVerified && " ⚠"}
                    </div>
                  )}
                </div>
                <div className="qty">{it.quantity}</div>
              </div>
            ) : (
              <>
                <div className="txt">
                  <div className="nm">{it.name}</div>
                  {it.optionText && (
                    <div className={`opt ${it.optionVerified ? "" : "unsure"}`}>
                      {it.optionText}
                      {!it.optionVerified && " ⚠"}
                    </div>
                  )}
                </div>
                <div className="qty">{it.quantity}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ══════════════ order preview ══════════════ */

/**
 * Read-only look at an order, opened from the list.
 *
 * Deliberately inert: nothing here touches the camera. Recording only ever
 * starts from the explicit button, and if another order is already being
 * packed the button says so, because starting a new one closes that recording.
 */
function OrderPreview({
  order, index, count, onStep, packed, record, busyWith, onClose, onStart,
}: {
  order: PackOrder;
  index: number;
  count: number;
  onStep: (delta: number) => void;
  packed: boolean;
  record?: PackRecord;
  busyWith: PackOrder | null;
  onClose: () => void;
  onStart: () => void;
}) {
  // Horizontal swipe moves between orders, so a whole batch can be flicked
  // through without closing and reopening the list each time.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Ignore mostly-vertical gestures so scrolling the card still works.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // RTL: swiping right (positive dx) moves to the next order in the list.
    onStep(dx > 0 ? 1 : -1);
  };
  const interrupting = Boolean(busyWith && busyWith.id !== order.id);

  const label = packed
    ? "إعادة التعبئة والتسجيل"
    : interrupting
      ? `أنهِ #${busyWith!.orderNumber} وابدأ هذا`
      : "ابدأ التعبئة والتسجيل";

  function start() {
    if (packed && record?.hasVideo) {
      if (!confirm("سيُستبدل الفيديو المحفوظ لهذا الطلب. متابعة؟")) return;
    } else if (interrupting) {
      if (!confirm(`سيتم إنهاء وحفظ الطلب #${busyWith!.orderNumber} أولًا. متابعة؟`)) return;
    }
    onStart();
  }

  return (
    <Sheet
      title={`معاينة — ${index + 1} من ${count}`}
      onClose={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      footer={
        <>
          <div className="b-row">
            <button
              className="btn b-line"
              disabled={index <= 0}
              onClick={() => onStep(-1)}
              aria-label="الطلب السابق"
            >
              ‹ السابق
            </button>
            <button
              className="btn b-line"
              disabled={index >= count - 1}
              onClick={() => onStep(1)}
              aria-label="الطلب التالي"
            >
              التالي ›
            </button>
          </div>
          <button className="btn b-go" onClick={start}>
            <RecIcon />
            {label}
          </button>
        </>
      }
    >
      {packed && record && (
        <div className="flash ok">
          تم تجهيزه · {formatDuration(record.durationMs)}
          {record.videoBytes ? ` · ${formatBytes(record.videoBytes)}` : " · بلا فيديو"}
        </div>
      )}
      {interrupting && (
        <div className="flash warn">
          يجري الآن تجهيز #{busyWith!.orderNumber} — سيُحفظ قبل بدء هذا الطلب.
        </div>
      )}
      <OrderCard order={order} />
    </Sheet>
  );
}

function RecIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6" fill="currentColor" />
    </svg>
  );
}

/* ══════════════ sheet shell (scrollable) ══════════════ */

function Sheet({
  title, children, footer, onClose, onTouchStart, onTouchEnd,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchEnd?: (e: React.TouchEvent) => void;
}) {
  return (
    <div className="sheet" onClick={onClose}>
      <div
        className="inner"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="grab" />
        <h3 className="sheet-title">{title}</h3>
        {/* min-height:0 on this region is what actually lets it scroll inside
            a flex column — without it the list just overflows the sheet. */}
        <div className="scrolly">{children}</div>
        <div className="sheet-foot">
          {footer}
          <button className="btn b-line" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════ summary ══════════════ */

function Summary({
  batch, allDone, onClose, onReset, onRelink,
}: {
  batch: Batch;
  allDone: boolean;
  onClose: () => void;
  onReset: () => Promise<void>;
  onRelink: (f: File) => Promise<string>;
}) {
  const [store, setStore] = useState<{ used: number; quota: number } | null>(null);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: "" });
  const relinkRef = useRef<HTMLInputElement>(null);
  const [relinkMsg, setRelinkMsg] = useState("");

  useEffect(() => {
    void usage().then(setStore);
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const byId = new Map(batch.orders.map((o) => [o.id, o]));
  const records = [...batch.records].sort((a, b) => a.packedAt.localeCompare(b.packedAt));
  const totalMs = records.reduce((s, r) => s + r.durationMs, 0);
  const avg = records.length ? totalMs / records.length : 0;

  const videoKeyOf = (r: PackRecord) => r.videoKey ?? r.orderId;

  /**
   * Records grouped by the file they live in.
   *
   * A group session writes one clip shared by every order in it, so the
   * summary lists it once. Listing it per order meant the same video appeared
   * four times and had to be downloaded four times to be sure of having it.
   */
  const clips: { key: string; records: PackRecord[] }[] = [];
  const clipIndex = new Map<string, number>();
  for (const r of records) {
    const key = videoKeyOf(r);
    const at = clipIndex.get(key);
    if (at === undefined) {
      clipIndex.set(key, clips.length);
      clips.push({ key, records: [r] });
    } else {
      clips[at].records.push(r);
    }
  }

  const withVideo = clips.filter((c) => c.records[0].hasVideo).length;

  /** `278290423 - 278307194 - … .webm`, every order the clip covers. */
  const clipName = (rs: PackRecord[]) =>
    clipFileName(rs.map((r) => byId.get(r.orderId)?.orderNumber ?? r.orderId));

  async function watch(rs: PackRecord[]) {
    const blob = await loadVideo(videoKeyOf(rs[0]));
    if (!blob) return;
    setPreview({ url: URL.createObjectURL(blob), label: clipName(rs) });
  }

  async function download(rs: PackRecord[]) {
    const blob = await loadVideo(videoKeyOf(rs[0]));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clipName(rs)}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function uploadAll() {
    if (!driveConfigured()) {
      // Explaining the one-time setup beats a silent no-op or a raw error.
      setUpload({
        busy: false,
        msg: "الرفع إلى Drive غير مفعّل بعد. أضف NEXT_PUBLIC_GOOGLE_CLIENT_ID في إعدادات Vercel ثم أعد النشر (الخطوات في ملف README).",
      });
      return;
    }
    setUpload({ busy: true, msg: "جارٍ تسجيل الدخول إلى Google…" });
    try {
      const token = await getAccessToken();
      const carrier =
        batch.orders.find((o) => o.carrierName)?.carrierName ?? "Orders";
      const name = folderName(carrier, new Date(batch.createdAt));
      setUpload({ busy: true, msg: `تجهيز المجلد «${name}»…` });
      const folderId = await ensureFolder(token, name);

      // One upload per clip, named the same way the summary names it, so a
      // file downloaded to the phone and the one in Drive match.
      const jobs = clips.filter((c) => c.records[0].hasVideo);

      let uploaded = 0;
      for (let i = 0; i < jobs.length; i++) {
        setUpload({ busy: true, msg: `رفع ${i + 1} من ${jobs.length}…` });
        const blob = await loadVideo(jobs[i].key);
        if (!blob) continue;
        await uploadFile(token, folderId, `${clipName(jobs[i].records)}.webm`, blob);
        uploaded++;
      }

      // A manifest so a shared clip can still be traced back to every order.
      const csv = [
        "رقم الطلب,العميل,المدينة,المدة,وقت التعبئة,ملف الفيديو",
        ...clips.flatMap((c) =>
          c.records.map((r) => {
            const o = byId.get(r.orderId);
            const file = r.hasVideo ? `${clipName(c.records)}.webm` : "";
            const cell = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
            return [
              o?.orderNumber ?? r.orderId,
              o?.customerName ?? "",
              o?.city ?? "",
              formatDuration(r.durationMs),
              new Date(r.packedAt).toLocaleString("ar-SA"),
              file,
            ]
              .map((v) => cell(String(v)))
              .join(",");
          }),
        ),
      ].join("\n");
      await uploadText(token, folderId, `${safeFileName(name)} - الملخّص.csv`, csv);

      setUpload({
        busy: false,
        msg: `تم رفع ${uploaded} فيديو و ملخّص إلى «${name}»`,
      });
    } catch (e) {
      setUpload({
        busy: false,
        msg: e instanceof Error ? `فشل الرفع: ${e.message}` : "فشل الرفع",
      });
    }
  }

  return (
    <>
      <Sheet
        title="الملخّص"
        onClose={onClose}
        footer={
          <>
            {/* Always offered, not gated on the batch being finished: a long
                day is often uploaded in stages, and already-packed orders are
                the ones at risk if the phone fills up or is lost. */}
            <button
              className="btn b-drive"
              disabled={upload.busy || withVideo === 0}
              onClick={() => void uploadAll()}
            >
              {upload.busy
                ? upload.msg
                : withVideo === 0
                  ? "لا فيديوهات للرفع بعد"
                  : `رفع ${withVideo} فيديو إلى Drive`}
            </button>
            <div className="b-row">
              <button className="btn b-line" onClick={() => relinkRef.current?.click()}>
                ربط صور المنتجات
              </button>
              <button
                className="btn b-stop"
                onClick={() => {
                  if (confirm("سيُحذف كل شيء: الطلبات والفيديوهات. متأكد؟")) void onReset();
                }}
              >
                دفعة جديدة
              </button>
            </div>
          </>
        }
      >
        <p className="note">
          {records.length} طلب · متوسط {formatDuration(avg)} للطلب · إجمالي{" "}
          {formatDuration(totalMs)}
          {store && ` · مساحة مستخدمة ${formatBytes(store.used)}`}
        </p>

        {!upload.busy && upload.msg && <div className="flash ok">{upload.msg}</div>}
        {relinkMsg && <div className="flash ok">{relinkMsg}</div>}
        {!driveConfigured() && (
          <p className="note">
            الرفع إلى Drive غير مفعّل — يحتاج ضبط <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>.
          </p>
        )}

        <input
          ref={relinkRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onRelink(f).then(setRelinkMsg);
          }}
        />

        <div className="list">
          {/* One row per clip. A group session's orders share a single file,
              so it is offered once — downloading it four times to be sure of
              having it was both confusing and a waste of phone storage. */}
          {clips.map((clip, i) => {
            const rs = clip.records;
            const first = rs[0];
            const orders = rs.map((r) => byId.get(r.orderId));
            const numbers = orders.map((o, j) => o?.orderNumber ?? rs[j].orderId);
            const totalDur = rs.reduce((sum, r) => sum + r.durationMs, 0);
            const bytes = first.videoBytes;
            return (
              <div className="lrow" key={clip.key}>
                <span className="n">{i + 1}</span>
                <span className="t">
                  <b>{numbers.map((n) => `#${n}`).join(" · ")}</b>
                  <span>
                    {orders.map((o) => o?.customerName ?? "—").join("، ")}
                  </span>
                  <span>
                    {new Date(first.packedAt).toLocaleTimeString("ar-SA")}
                    {bytes ? ` · ${formatBytes(bytes)}` : " · بلا فيديو"}
                    {rs.length > 1 ? ` · مجموعة من ${rs.length} طلبات` : ""}
                  </span>
                </span>
                {rs.every((r) => r.verified) && <span className="chip done">✓ تحقّق</span>}
                <span className="dur">{formatDuration(totalDur)}</span>
                {first.hasVideo && (
                  <span className="acts">
                    <button className="chip" onClick={() => void watch(rs)}>
                      مشاهدة
                    </button>
                    <button className="chip" onClick={() => void download(rs)}>
                      حفظ
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <p className="note">
          الفيديوهات محفوظة على هذا الجهاز فقط. احفظ ما تحتاجه قبل بدء دفعة جديدة.
        </p>
      </Sheet>

      {preview && (
        <div className="sheet" onClick={() => setPreview(null)} style={{ zIndex: 60 }}>
          <div className="inner" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h3 className="sheet-title">{preview.label}</h3>
            <video src={preview.url} controls autoPlay playsInline className="preview" />
            <button className="btn b-line" onClick={() => setPreview(null)}>إغلاق</button>
          </div>
        </div>
      )}
    </>
  );
}

/* ══════════════ setup ══════════════ */

function Setup({ onReady }: { onReady: (b: Batch) => void }) {
  const [orders, setOrders] = useState<File | null>(null);
  const [labels, setLabels] = useState<File | null>(null);
  const [catalog, setCatalog] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<BuildStats | null>(null);
  const pending = useRef<Batch | null>(null);

  async function go() {
    if (!orders || !labels) return;
    setBusy(true);
    setError("");
    try {
      const { batch, stats: s } = await buildBatch(orders, labels, catalog, setProgress);
      if (batch.orders.length === 0) {
        setError("لم نتعرّف على أي طلب في ملف الطلبات. تأكد أنه ملف سلة الصحيح.");
        setBusy(false);
        return;
      }
      pending.current = batch;
      setStats(s);
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّرت قراءة الملفات");
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="count" style={{ fontSize: 22 }}>لَمّ</div>
          <div className="lbl">لتجهيز الطلبات — ارفع الملفات لتبدأ</div>
        </div>
      </header>

      <main className="main">
        <div className="setup">
          <Picker n="١" label="ملف الطلبات" hint="Prep Orders.pdf من سلة"
            accept="application/pdf" file={orders} onPick={setOrders} />
          <Picker n="٢" label="ملف البوليصات" hint="polices.pdf من شركة الشحن"
            accept="application/pdf" file={labels} onPick={setLabels} />
          <Picker n="٣" label="ملف المنتجات" hint="xlsx أو csv — لعرض صور المنتجات"
            accept=".xlsx,.xls,.csv,text/csv" file={catalog} onPick={setCatalog} />

          {error && <div className="err">{error}</div>}
          {busy && progress && (
            <p className="note">
              {progress.stage}
              {progress.total > 1 ? ` — ${progress.done}/${progress.total}` : "…"}
            </p>
          )}

          {stats ? (
            <>
              {/* Shown before packing starts so a missing or wrong catalog is
                  caught here, not discovered on the bench with blank photos. */}
              <div className="statbox">
                <Stat label="طلب" value={stats.orders} />
                <Stat label="بوليصة مطابقة" value={`${stats.matchedLabels}/${stats.labels}`} />
                <Stat label="صنف" value={stats.lineItems} />
                <Stat
                  label="صنف له صورة"
                  value={`${stats.itemsWithPhoto}/${stats.lineItems}`}
                  bad={stats.itemsWithPhoto < stats.lineItems}
                />
              </div>
              {stats.catalogProducts === 0 && (
                <div className="err">
                  لم يُقرأ أي منتج من ملف المنتجات — لن تظهر صور. أضف ملف
                  xlsx أو csv الصحيح ثم أعد المحاولة.
                </div>
              )}
              {stats.catalogProducts > 0 && stats.itemsWithPhoto < stats.lineItems && (
                <div className="flash warn">
                  {stats.lineItems - stats.itemsWithPhoto} صنف بلا صورة — تحقق
                  أن ملف المنتجات هو أحدث نسخة.
                </div>
              )}
              <button className="btn b-go" onClick={() => pending.current && onReady(pending.current)}>
                ابدأ التجهيز
              </button>
              <button className="btn b-ghost" onClick={() => { setStats(null); pending.current = null; }}>
                تغيير الملفات
              </button>
            </>
          ) : (
            <button className="btn b-go" disabled={!orders || !labels || busy} onClick={go}>
              {busy ? "جارٍ القراءة…" : "اقرأ الملفات"}
            </button>
          )}

          <p className="note">
            كل شيء يُقرأ على جهازك ولا يُرفع لأي خادم. تحتاج إذن الكاميرا لاحقًا
            لمسح الباركود وتسجيل التعبئة.
          </p>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: string | number; bad?: boolean }) {
  return (
    <div className="stat">
      <b className={bad ? "bad" : ""}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function Picker({
  n, label, hint, accept, file, onPick,
}: {
  n: string; label: string; hint: string; accept: string;
  file: File | null; onPick: (f: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
      <button className={`drop ${file ? "ok" : ""}`} onClick={() => ref.current?.click()}>
        <span className="n">{file ? "✓" : n}</span>
        <span style={{ minWidth: 0 }}>
          <b>{label}</b>
          <span>{file ? file.name : hint}</span>
        </span>
      </button>
    </>
  );
}

function ScanIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6.5V4.5A1.5 1.5 0 014.5 3h2M17 6.5V4.5A1.5 1.5 0 0015.5 3h-2M3 13.5v2A1.5 1.5 0 004.5 17h2M17 13.5v2a1.5 1.5 0 01-1.5 1.5h-2" />
      <path d="M6.5 7v6M9 7v6M11.5 7v6M14 7v6" />
    </svg>
  );
}

/* ══════════════ settings ══════════════ */

function Toggle({
  label, note, on, onToggle, disabled, disabledNote,
}: {
  label: string;
  note: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  disabledNote?: string;
}) {
  return (
    <button
      className={`toggle ${on && !disabled ? "on" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on && !disabled}
    >
      <span className="tx">
        <b>{label}</b>
        <span>{disabled ? (disabledNote ?? note) : note}</span>
      </span>
      <span className="sw" aria-hidden="true"><i /></span>
    </button>
  );
}

function SettingsSheet({
  prefs, onChange, onClose,
}: {
  prefs: Prefs;
  onChange: (p: Partial<Prefs>) => void;
  onClose: () => void;
}) {
  const speech = canSpeak();
  return (
    <Sheet title="الإعدادات" onClose={onClose}>
      <Toggle
        label="نطق محتويات الطلب"
        note="يقرأ الأصناف بصوت عند مسح الباركود، لتتجنّب الخطأ بلا نظر للشاشة."
        on={prefs.voice}
        disabled={!speech}
        disabledNote="هذا الجهاز لا يدعم النطق."
        onToggle={() => {
          const next = !prefs.voice;
          onChange({ voice: next });
          if (next) speak("تم تشغيل النطق");
          else stopSpeaking();
        }}
      />
      <Toggle
        label="تحقق بعد كل طلب"
        note="بعد إنهاء الطلب، يطلب مسح البوليصة مرة أخرى للتأكد من الصندوق."
        on={prefs.verifyAfterPack}
        onToggle={() => onChange({ verifyAfterPack: !prefs.verifyAfterPack })}
      />

      <div className="blk">
        <b className="blk-title">جودة الفيديو</b>
        <div className="list">
          {(["high", "balanced", "saver"] as const).map((q) => (
            <button
              key={q}
              className="lrow"
              onClick={() => onChange({ videoQuality: q })}
            >
              <span className="t">
                <b style={{ direction: "rtl", textAlign: "start" }}>{QUALITY[q].label}</b>
                <span>{QUALITY[q].note}</span>
              </span>
              {prefs.videoQuality === q && <span className="chip done">مُختار</span>}
            </button>
          ))}
        </div>
        <p className="note">
          تُطبَّق الجودة على التسجيل التالي — لن يتأثر تسجيل جارٍ الآن.
        </p>
      </div>
    </Sheet>
  );
}
