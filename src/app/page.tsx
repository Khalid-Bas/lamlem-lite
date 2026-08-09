"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, canScan } from "@/lib/camera";
import { buildBatch, type BuildProgress } from "@/lib/build-batch";
import {
  clearAll, formatBytes, formatDuration, loadBatch, loadVideo,
  saveBatch, saveVideo, upsertRecord, usage,
} from "@/lib/store";
import { buildAliases, resolveScan } from "@/lib/barcode";
import type { Batch, PackOrder } from "@/lib/types";

type View = "setup" | "scan" | "packing" | "summary";
type Flash = { kind: "bad" | "warn"; text: string } | null;

export default function App() {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [view, setView] = useState<View>("setup");
  const [current, setCurrent] = useState<PackOrder | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [flash, setFlash] = useState<Flash>(null);
  const [camError, setCamError] = useState("");
  const [showList, setShowList] = useState(false);
  /**
   * Whether a clip is genuinely being captured. Tracked separately from the
   * view because showing a "recording" badge when the camera failed would have
   * the packer trust a video that does not exist.
   */
  const [recording, setRecording] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<Camera | null>(null);
  // Held in refs so the scan callback — created once — always sees fresh values.
  const batchRef = useRef<Batch | null>(null);
  const currentRef = useRef<PackOrder | null>(null);
  const startedAtRef = useRef(0);
  batchRef.current = batch;
  currentRef.current = current;
  startedAtRef.current = startedAt;

  /* ── restore any batch already on this device ── */
  useEffect(() => {
    void loadBatch().then((b) => {
      if (b) {
        setBatch(b);
        setView("scan");
      }
    });
  }, []);

  const aliases = useMemo(
    () =>
      (batch?.orders ?? []).flatMap((o) =>
        buildAliases({
          id: o.id,
          orderNumber: o.orderNumber,
          trackingRaw: o.trackingRaw,
        }),
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

  /* ── finish the order in progress: stop recording, store video + duration ── */
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
      });
      batchRef.current = next;
      setBatch(next);
      void saveBatch(next);
    }
    setCurrent(null);
  }, []);

  /* ── begin an order: show items and start recording ── */
  const beginOrder = useCallback((order: PackOrder) => {
    setCurrent(order);
    currentRef.current = order;
    const now = Date.now();
    setStartedAt(now);
    startedAtRef.current = now;
    setElapsed(0);
    setView("packing");
    setFlash(null);
    camRef.current?.startRecording();
    setRecording(Boolean(camRef.current?.isRecording));
  }, []);

  /* ── one handler for every scan, whether idle or mid-pack ── */
  const onCode = useCallback(
    async (raw: string) => {
      const res = resolveScan(raw, aliasesRef.current);
      const active = currentRef.current;

      if (res.kind === "yellow") {
        setFlash({ kind: "bad", text: `باركود غير معروف: ${raw}` });
        navigator.vibrate?.([90, 60, 90]);
        return;
      }
      if (res.kind === "orange") {
        setFlash({ kind: "warn", text: "أكثر من طلب يطابق — اختر يدويًا" });
        setShowList(true);
        return;
      }

      const hitId = res.orderId;
      const order = batchRef.current?.orders.find((o) => o.id === hitId);
      if (!order) return;

      // Same label again = "I'm done with this one".
      if (active && active.id === order.id) {
        navigator.vibrate?.(60);
        await finishCurrent();
        setView("scan");
        return;
      }

      // A different label = finish the current order and roll straight on.
      if (active) await finishCurrent();
      navigator.vibrate?.(45);
      beginOrder(order);
    },
    [beginOrder, finishCurrent],
  );
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  /* ── camera lifecycle: opened once, kept for the whole session ── */
  useEffect(() => {
    if (view === "setup" || !videoRef.current) return;
    let cancelled = false;

    const cam = camRef.current ?? new Camera(videoRef.current);
    camRef.current = cam;

    void cam
      .start()
      .then(() => {
        if (cancelled) return;
        setCamError("");
        cam.startScanning((v) => void onCodeRef.current(v));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCamError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "لم يُسمح باستخدام الكاميرا. افتح إعدادات المتصفح واسمح بالكاميرا لهذا الموقع."
            : "تعذّر فتح الكاميرا على هذا الجهاز.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [view]);

  // Release the camera when the app is closed or backgrounded for good.
  useEffect(() => () => camRef.current?.stop(), []);

  /* ── live timer ── */
  useEffect(() => {
    if (view !== "packing") return;
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 500);
    return () => clearInterval(id);
  }, [view]);

  if (view === "setup") {
    return <Setup onReady={(b) => { setBatch(b); void saveBatch(b); setView("scan"); }} />;
  }

  const remaining = (batch?.orders ?? []).filter((o) => !packedIds.has(o.id));

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
        {view === "packing" ? (
          <>
            <span className="timer">{formatDuration(elapsed)}</span>
            {recording ? (
              <span className="rec">
                <i />
                تسجيل
              </span>
            ) : (
              <span className="chip">بلا فيديو</span>
            )}
          </>
        ) : (
          <button className="chip" onClick={() => setShowList(true)}>
            الطلبات
          </button>
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

        <div className={`cam ${view === "packing" ? "small" : ""}`}>
          <video ref={videoRef} playsInline muted />
          {view === "scan" && <div className="reticle" />}
          <div className="camhint">
            {view === "packing"
              ? "امسح باركود الطلب التالي لإنهاء هذا الطلب"
              : "وجّه الكاميرا نحو باركود البوليصة"}
          </div>
        </div>

        {view === "packing" && current ? (
          <PackingItems order={current} />
        ) : (
          <IdlePrompt remaining={remaining.length} total={total} />
        )}

        {view === "packing" && (
          <button className="btn b-go" onClick={() => void finishCurrent().then(() => setView("scan"))}>
            تم — أنهِ هذا الطلب
          </button>
        )}

        {view === "scan" && done > 0 && (
          <button className="btn b-ghost" onClick={() => setView("summary")}>
            عرض الملخّص والفيديوهات ({done})
          </button>
        )}
      </main>

      {showList && batch && (
        <OrderSheet
          batch={batch}
          packedIds={packedIds}
          onPick={(o) => {
            setShowList(false);
            void (async () => {
              if (currentRef.current) await finishCurrent();
              beginOrder(o);
            })();
          }}
          onClose={() => setShowList(false)}
        />
      )}

      {view === "summary" && batch && (
        <Summary
          batch={batch}
          onClose={() => setView("scan")}
          onReset={async () => {
            await clearAll();
            camRef.current?.stop();
            camRef.current = null;
            setBatch(null);
            setCurrent(null);
            setView("setup");
          }}
        />
      )}
    </div>
  );
}

/* ══════════════ packing items ══════════════ */

function PackingItems({ order }: { order: PackOrder }) {
  const single = order.items.length === 1;
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

      <div className="items" data-n={order.items.length}>
        {order.items.map((it, i) => (
          <div className="item" key={`${it.name}-${i}`}>
            <div className="pic">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.imageUrl} alt="" loading="eager" />
              ) : (
                <span>بلا صورة</span>
              )}
            </div>
            {single ? (
              <div className="row2">
                <div className="txt">
                  <div className="nm">{it.name}</div>
                  {it.optionText && <div className="opt">{it.optionText}</div>}
                </div>
                <div className="qty">{it.quantity}</div>
              </div>
            ) : (
              <>
                <div className="txt">
                  <div className="nm">{it.name}</div>
                  {it.optionText && <div className="opt">{it.optionText}</div>}
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

function IdlePrompt({ remaining, total }: { remaining: number; total: number }) {
  if (total === 0) return null;
  return (
    <p className="note" style={{ textAlign: "center" }}>
      {remaining === 0
        ? "تم تجهيز كل الطلبات 🎉"
        : `متبقٍ ${remaining} طلب — امسح الباركود للبدء.`}
    </p>
  );
}

/* ══════════════ order picker ══════════════ */

function OrderSheet({
  batch, packedIds, onPick, onClose,
}: {
  batch: Batch;
  packedIds: Set<string>;
  onPick: (o: PackOrder) => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet" onClick={onClose}>
      <div className="inner" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3 style={{ fontSize: 16 }}>اختر طلبًا</h3>
        <div className="list">
          {batch.orders.map((o, i) => {
            const isDone = packedIds.has(o.id);
            return (
              <button className="lrow" key={o.id} onClick={() => onPick(o)}>
                <span className="n">{i + 1}</span>
                <span className="t">
                  <b>#{o.orderNumber}</b>
                  <span>
                    {o.customerName ?? "—"}
                    {o.city ? ` · ${o.city}` : ""} · {o.items.length} صنف
                  </span>
                </span>
                {isDone && <span className="chip done">تم</span>}
              </button>
            );
          })}
        </div>
        <button className="btn b-line" onClick={onClose}>
          إغلاق
        </button>
      </div>
    </div>
  );
}

/* ══════════════ summary ══════════════ */

function Summary({
  batch, onClose, onReset,
}: {
  batch: Batch;
  onClose: () => void;
  onReset: () => Promise<void>;
}) {
  const [store, setStore] = useState<{ used: number; quota: number } | null>(null);
  useEffect(() => {
    void usage().then(setStore);
  }, []);

  const byId = new Map(batch.orders.map((o) => [o.id, o]));
  const records = [...batch.records].sort((a, b) => a.packedAt.localeCompare(b.packedAt));
  const totalMs = records.reduce((s, r) => s + r.durationMs, 0);
  const avg = records.length ? totalMs / records.length : 0;

  async function download(orderId: string, orderNumber: string) {
    const blob = await loadVideo(orderId);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `order-${orderNumber}.webm`;
    a.click();
    // Revoke on the next tick so the download has claimed the URL.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  return (
    <div className="sheet" onClick={onClose}>
      <div className="inner" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3 style={{ fontSize: 16 }}>الملخّص</h3>
        <p className="note">
          {records.length} طلب · متوسط {formatDuration(avg)} للطلب · إجمالي{" "}
          {formatDuration(totalMs)}
          {store && ` · مساحة مستخدمة ${formatBytes(store.used)}`}
        </p>

        <div className="list">
          {records.map((r, i) => {
            const o = byId.get(r.orderId);
            return (
              <div className="lrow" key={r.orderId}>
                <span className="n">{i + 1}</span>
                <span className="t">
                  <b>#{o?.orderNumber ?? r.orderId}</b>
                  <span>
                    {new Date(r.packedAt).toLocaleTimeString("ar-SA")}
                    {r.videoBytes ? ` · ${formatBytes(r.videoBytes)}` : " · بلا فيديو"}
                  </span>
                </span>
                <span className="dur">{formatDuration(r.durationMs)}</span>
                {r.hasVideo && (
                  <button
                    className="chip"
                    onClick={() => void download(r.orderId, o?.orderNumber ?? "")}
                  >
                    حفظ
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="b-row">
          <button className="btn b-line" onClick={onClose}>
            رجوع
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
        <p className="note">
          الفيديوهات محفوظة على هذا الجهاز فقط. احفظ ما تحتاجه قبل بدء دفعة
          جديدة.
        </p>
      </div>
    </div>
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

  async function go() {
    if (!orders || !labels) return;
    setBusy(true);
    setError("");
    try {
      const b = await buildBatch(orders, labels, catalog, setProgress);
      if (b.orders.length === 0) {
        setError("لم نتعرّف على أي طلب في ملف الطلبات. تأكد أنه ملف سلة الصحيح.");
        setBusy(false);
        return;
      }
      onReady(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّرت قراءة الملفات");
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="count" style={{ fontSize: 20 }}>
            لملم
          </div>
          <div className="lbl">ارفع الملفات لتبدأ</div>
        </div>
      </header>

      <main className="main">
        <div className="setup">
          <Picker
            n="١"
            label="ملف الطلبات"
            hint="Prep Orders.pdf من سلة"
            accept="application/pdf"
            file={orders}
            onPick={setOrders}
          />
          <Picker
            n="٢"
            label="ملف البوليصات"
            hint="polices.pdf من شركة الشحن"
            accept="application/pdf"
            file={labels}
            onPick={setLabels}
          />
          <Picker
            n="٣"
            label="ملف المنتجات (اختياري)"
            hint="list of products.xlsx — لعرض صور المنتجات"
            accept=".xlsx,.xls,.csv"
            file={catalog}
            onPick={setCatalog}
          />

          {error && <div className="err">{error}</div>}

          {busy && progress && (
            <p className="note">
              {progress.stage}
              {progress.total > 1 ? ` — ${progress.done}/${progress.total}` : "…"}
            </p>
          )}

          <button className="btn b-go" disabled={!orders || !labels || busy} onClick={go}>
            {busy ? "جارٍ القراءة…" : "ابدأ"}
          </button>

          <p className="note">
            كل شيء يُقرأ على جهازك ولا يُرفع لأي خادم. تحتاج إذن الكاميرا في
            الخطوة التالية لمسح الباركود وتسجيل التعبئة.
          </p>
        </div>
      </main>
    </div>
  );
}

function Picker({
  n, label, hint, accept, file, onPick,
}: {
  n: string;
  label: string;
  hint: string;
  accept: string;
  file: File | null;
  onPick: (f: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
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
