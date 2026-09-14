"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, canScan } from "@/lib/camera";
import {
  buildBatch, linkCatalog, describeOrder, differsFromSession, NoTextLayerError,
  type BuildProgress, type BuildStats,
} from "@/lib/build-batch";
import { readCatalog } from "@/lib/catalog-load";
import {
  activeCatalog, loadStoredCatalog, saveCatalog, clearCatalog, BUILT_IN_CATALOG,
  type StoredCatalog,
} from "@/lib/catalog-store";
import {
  clearAll, formatBytes, loadBatch, loadPhoto, saveBatch, savePhoto,
  upsertRecord, usage,
} from "@/lib/store";
import { buildAliases, resolveScan } from "@/lib/barcode";
import {
  driveConfigured, ensureFolder, folderName, getAccessToken, uploadFile,
  uploadText, safeFileName, clipFileName, canShareFiles, shareFiles,
  shareBatches, SHARE_MAX_FILES, targetFolderId, dayFolderName,
} from "@/lib/drive";
import { carrierCode } from "@/lib/carriers";
import {
  primeAudio, cueScanOk, cueScanFail, cueNeutral,
  cueOrderDone, cueBatchDone, speak, canSpeak,
} from "@/lib/feedback";
import {
  loadSettings, saveSettings, QUALITY, DEFAULTS,
  type Settings as Prefs, type ShipService,
} from "@/lib/settings";
import {
  buildInventoryWorkbook, downloadInventory, type InventoryWorkbook,
} from "@/lib/inventory/export";
import {
  activeBom, loadStoredBom, saveBom, clearBom, BUILT_IN_BOM, type StoredBom,
} from "@/lib/inventory/bom-store";
import { readBomFile } from "@/lib/inventory/bom";
import { useBackGuard } from "@/lib/use-back-guard";
import type { Batch, PackOrder, PackRecord } from "@/lib/types";
import type { Product } from "@/lib/catalog-types";

/** A scanned order is on screen waiting for its still photo in "photo-shoot". */
type Mode = "setup" | "idle" | "photo-shoot";
type ScanPurpose = "photo";
type Flash = { kind: "bad" | "warn" | "ok"; text: string } | null;

/** What the stocktake button reports back, warnings and all. */
function inventoryMessage(out: InventoryWorkbook): string {
  const money = (n: number) => n.toLocaleString("en", { maximumFractionDigits: 2 });
  const parts = [
    `تم تنزيل «${out.fileName}»`,
    `المنتجات: ${out.soldCount} · المواد: ${out.componentCount}`,
    `صافي المبيعات: ${money(out.netSales)} · صافي الربح: ${money(out.netProfit)} ر.س`,
  ];
  if (out.uncosted.length) {
    parts.push(`الربح ناقص — بلا سعر تكلفة: ${out.uncosted.join("، ")}`);
  }
  if (out.unresolved.length) {
    parts.push(`بلا مكوّنات في ملف الجرد: ${out.unresolved.join("، ")}`);
  }
  return parts.join(" — ");
}

export default function App() {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [invMsg, setInvMsg] = useState("");
  const [mode, setMode] = useState<Mode>("setup");
  const [flash, setFlash] = useState<Flash>(null);
  const [camError, setCamError] = useState("");
  /** Set while the camera is being brought back after the phone went away. */
  const [camState, setCamState] = useState<"live" | "recovering" | "lost">("live");
  const [scanFor, setScanFor] = useState<ScanPurpose | null>(null);
  const [sheet, setSheet] = useState<"orders" | "summary" | "settings" | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  /** Order being previewed from the list. Viewing never opens the camera. */
  const [preview, setPreview] = useState<PackOrder | null>(null);
  /** Bumped once the camera exists, so the scanning effect can re-run. */
  const [camReady, setCamReady] = useState(0);
  const [manualPick, setManualPick] = useState(false);

  /**
   * Photo session: scan a sealed box, photograph it, scan the next.
   *
   * "single" stops after one order; "group" keeps going and holds every box to
   * the contents of the first one scanned, because photographing a pile packed
   * from one order only makes sense when the pile really is one order.
   */
  const [photoMode, setPhotoMode] = useState<"single" | "group" | null>(null);
  /** Orders already photographed in the current session. */
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [photoTarget, setPhotoTarget] = useState<PackOrder | null>(null);
  const [photoWarn, setPhotoWarn] = useState<
    { order: PackOrder; reasons: string[] } | null
  >(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<Camera | null>(null);

  // Refs so the scan callback, created once, always sees current values.
  const batchRef = useRef<Batch | null>(null);
  const modeRef = useRef<Mode>("setup");
  const photoModeRef = useRef<"single" | "group" | null>(null);
  const photoIdsRef = useRef<string[]>([]);
  const photoTargetRef = useRef<PackOrder | null>(null);
  const photoBusyRef = useRef(false);
  photoModeRef.current = photoMode;
  photoIdsRef.current = photoIds;
  photoTargetRef.current = photoTarget;
  photoBusyRef.current = photoBusy;
  batchRef.current = batch;
  modeRef.current = mode;

  useEffect(() => {
    setPrefs(loadSettings());
    void loadBatch().then((b) => {
      if (b) { setBatch(b); setMode("idle"); }
    });
  }, []);

  const prefsRef = useRef<Prefs>(DEFAULTS);
  prefsRef.current = prefs;
  const scanForRef = useRef<ScanPurpose | null>(null);
  const previewRef = useRef<PackOrder | null>(null);
  const sheetRef = useRef<"orders" | "summary" | "settings" | null>(null);
  scanForRef.current = scanFor;
  previewRef.current = preview;
  sheetRef.current = sheet;

  /**
   * Re-applies the product list to the batch already open.
   *
   * Changing the list mid-batch has to reach the orders on screen, or the
   * photos and names keep coming from the list that was in force when the
   * batch was read — which is exactly the confusion the change was meant to fix.
   */
  const relinkBatch = useCallback(async (products: Product[]): Promise<string> => {
    const base = batchRef.current;
    if (!base) return "";
    const { orders: next, withPhoto } = linkCatalog(base.orders, products);
    const updated = { ...base, orders: next };
    batchRef.current = updated;
    setBatch(updated);
    await saveBatch(updated);
    const items = next.reduce((n, o) => n + o.items.length, 0);
    return `${withPhoto} من ${items} صنف له صورة الآن`;
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      saveSettings(next);
      if (patch.photoQuality) camRef.current?.setQuality(patch.photoQuality);
      return next;
    });
  }, []);

  /**
   * Writes the stocktake for the whole uploaded batch, photographed or not.
   *
   * The question it answers — how much stock to write down — is about what was
   * sold, not about how far the packing has got, so it deliberately covers
   * every order in the batch.
   */
  const exportInventory = useCallback(async () => {
    if (!batch) return;
    setInvMsg("جارٍ تجهيز الملف…");
    try {
      const out = await downloadInventory(batch.orders, activeBom(), activeCatalog(), prefs);
      setInvMsg(inventoryMessage(out));
    } catch (e) {
      setInvMsg(e instanceof Error ? `تعذّر إنشاء الجرد: ${e.message}` : "تعذّر إنشاء الجرد");
    }
  }, [batch, prefs]);

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

  /* ── camera: opened on demand, and put back on its feet by itself ── */
  const ensureCamera = useCallback(async (): Promise<Camera | null> => {
    if (!videoRef.current) return null;
    const cam = camRef.current ?? new Camera(videoRef.current, prefsRef.current.photoQuality);
    camRef.current = cam;
    // Re-bind in case React handed us a different element since last time.
    cam.attach(videoRef.current);
    cam.onState(setCamState);
    try {
      await cam.start();
      setCamError("");
      setCamState("live");
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

  useEffect(() => () => camRef.current?.dispose(), []);

  /* ── every scan lands here ── */
  const onCode = useCallback(async (raw: string) => {
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

    if (offerShotRef.current(order) && prefsRef.current.voice) {
      speak(describeOrder(order));
    }
  }, []);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  /* ── the scanner overlay drives detection only while it is open ── */
  const openScanner = useCallback(async () => {
    primeAudio();
    setScanFor("photo");
    setFlash(null);
    await ensureCamera();
  }, [ensureCamera]);
  const openScannerRef = useRef(openScanner);
  openScannerRef.current = openScanner;

  /**
   * Detection is bound to the scanner being open, and to nothing else.
   *
   * Driving start/stop from this one effect — rather than imperatively from
   * each call site — makes it structurally impossible for the detector to be
   * running while a shot is being framed, where a stray barcode drifting into
   * view would jump to a different order.
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

  const closeScanner = useCallback(() => {
    camRef.current?.stopScanning();
    setScanFor(null);
  }, []);

  /* ── photo session: scan a sealed box, photograph it, scan the next ── */

  /** Puts one order on the shutter screen. Detection stops first, always. */
  const beginShot = useCallback((order: PackOrder) => {
    camRef.current?.stopScanning();
    setScanFor(null);
    setPhotoWarn(null);
    setFlash(null);
    setPhotoTarget(order);
    photoTargetRef.current = order;
    setMode("photo-shoot");
    modeRef.current = "photo-shoot";
  }, []);
  const beginShotRef = useRef(beginShot);
  beginShotRef.current = beginShot;

  /**
   * Accepts an order into the photo session, or refuses it with a reason.
   *
   * Every route into a shot goes through here — the scan and the manual picker
   * alike — because a box chosen by hand can break the "this pile is all one
   * order" assumption exactly as easily as a mis-scanned label, and skipping
   * the check on the manual path would quietly defeat the group mode. Returns
   * true when the shutter screen was opened.
   */
  const offerShot = useCallback((order: PackOrder): boolean => {
    if (photoIdsRef.current.includes(order.id)) {
      setFlash({ kind: "warn", text: `#${order.orderNumber} صُوِّر بالفعل في هذه الجلسة` });
      cueNeutral();
      return false;
    }
    // A group session assumes every box holds the same thing. The first order
    // sets what that is; each later one is measured against it and stops the
    // flow if it differs, before any photo is taken.
    if (photoModeRef.current === "group") {
      const shot = photoIdsRef.current
        .map((id) => batchRef.current?.orders.find((o) => o.id === id))
        .filter((o): o is PackOrder => Boolean(o));
      const reasons = differsFromSession(order, shot);
      if (reasons.length > 0) {
        cueScanFail();
        setPhotoWarn({ order, reasons });
        return false;
      }
    }
    cueScanOk();
    beginShotRef.current(order);
    return true;
  }, []);
  const offerShotRef = useRef(offerShot);
  offerShotRef.current = offerShot;

  /** Opens a session and goes straight to the scanner — one tap, no menu. */
  const startPhoto = useCallback(
    async (kind: "single" | "group") => {
      setPhotoMode(kind);
      photoModeRef.current = kind;
      setPhotoIds([]);
      photoIdsRef.current = [];
      setPhotoTarget(null);
      photoTargetRef.current = null;
      setPhotoWarn(null);
      setMode("idle");
      modeRef.current = "idle";
      await openScannerRef.current();
    },
    [],
  );

  const endPhotoSession = useCallback(() => {
    const n = photoIdsRef.current.length;
    camRef.current?.stopScanning();
    setScanFor(null);
    setPhotoMode(null);
    photoModeRef.current = null;
    setPhotoTarget(null);
    photoTargetRef.current = null;
    setPhotoWarn(null);
    setPhotoIds([]);
    photoIdsRef.current = [];
    setMode("idle");
    modeRef.current = "idle";
    if (n > 0) setFlash({ kind: "ok", text: `تم حفظ ${n} صورة` });
  }, []);

  /**
   * Takes the shot for the order on screen and files it under that order.
   *
   * One photo, one order, always — even in a group session, where the whole
   * point is that each box ends up with its own picture named after its own
   * order number. The label was scanned moments earlier, on the sealed box, so
   * the record is marked verified by the same act that opened this screen.
   */
  const capturePhoto = useCallback(async () => {
    const order = photoTargetRef.current;
    const cam = camRef.current;
    if (!order || !cam || photoBusyRef.current) return;
    setPhotoBusy(true);
    photoBusyRef.current = true;
    try {
      const blob = await cam.capturePhoto();
      if (!blob) {
        cueScanFail();
        setFlash({ kind: "bad", text: "تعذّر التقاط الصورة — حاول مرة أخرى" });
        return;
      }
      await savePhoto(order.id, blob);

      const base = batchRef.current;
      if (base) {
        const next = upsertRecord(base, {
          orderId: order.id,
          packedAt: new Date().toISOString(),
          hasPhoto: true,
          photoBytes: blob.size,
          verified: true,
        });
        batchRef.current = next;
        setBatch(next);
        await saveBatch(next);
        if (next.records.length >= next.orders.length) cueBatchDone();
        else cueOrderDone();
      }

      const ids = [...photoIdsRef.current, order.id];
      photoIdsRef.current = ids;
      setPhotoIds(ids);
      setPhotoTarget(null);
      photoTargetRef.current = null;
      setFlash({ kind: "ok", text: `حُفظت صورة #${order.orderNumber}` });

      if (photoModeRef.current === "group") {
        // Straight back to the scanner for the next box — scan, shoot, repeat.
        await openScannerRef.current();
      } else {
        setPhotoMode(null);
        photoModeRef.current = null;
        setMode("idle");
        modeRef.current = "idle";
      }
    } finally {
      setPhotoBusy(false);
      photoBusyRef.current = false;
    }
  }, []);

  /** Backs out of a shot without taking it, returning to the scanner. */
  const cancelShot = useCallback(async () => {
    setPhotoTarget(null);
    photoTargetRef.current = null;
    setMode("idle");
    modeRef.current = "idle";
    if (photoModeRef.current) await openScannerRef.current();
  }, []);
  const cancelShotRef = useRef(cancelShot);
  cancelShotRef.current = cancelShot;

  /**
   * Android's back button closes whatever is on top, innermost first, instead
   * of leaving the site. Only when nothing is open does it offer to exit.
   */
  useBackGuard(
    () => {
      if (photoTargetRef.current) { void cancelShotRef.current(); return true; }
      if (scanForRef.current) { endPhotoSession(); return true; }
      if (previewRef.current) { setPreview(null); return true; }
      if (sheetRef.current) { setSheet(null); return true; }
      return false;
    },
    () => confirm("هل أنت متأكد من أنك تريد الخروج من الصفحة؟"),
  );
  if (mode === "setup") {
    return (
      <Setup
        onReady={(b) => { setBatch(b); void saveBatch(b); setMode("idle"); }}
      />
    );
  }

  const orders = batch?.orders ?? [];

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="count">
            {done}
            <small> / {total}</small>
          </div>
          <div className="lbl">طلب مصوَّر</div>
        </div>
        <div className="bar">
          <i style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
        </div>
        {photoMode && (
          <span className="chip shot">
            {photoIds.length}
            {photoMode === "group" ? " · مجموعة" : ""}
          </span>
        )}
        <button className="chip" onClick={() => setSheet("orders")}>الطلبات</button>
      </header>

      <main className="main">
        {camError && <div className="err">{camError}</div>}
        {camState === "lost" && (
          <div className="err">
            انقطعت الكاميرا ولم تعد. أغلق التطبيقات التي تستخدم الكاميرا ثم
            اضغط الزر مرة أخرى.
          </div>
        )}
        {!canScan() && !camError && (
          <div className="err">
            هذا المتصفح لا يدعم قراءة الباركود بالكاميرا. استخدم Chrome على
            أندرويد، أو اختر الطلب يدويًا من زر «الطلبات».
          </div>
        )}
        {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}

        {mode === "idle" && (
          <>
            {/* The two ways to work, each one tap away. Asking "one or many?"
                in a sheet first put a menu between the packer and the camera
                on every single box. */}
            <button className="btn b-scan" onClick={() => void startPhoto("single")}>
              <ScanIcon />
              تصوير طلب واحد
            </button>
            <button className="btn b-scan" onClick={() => void startPhoto("group")}>
              <ScanIcon />
              تصوير مجموعة طلبات
            </button>
            <p className="note" style={{ textAlign: "center" }}>
              {allDone
                ? "تم تصوير كل الطلبات 🎉"
                : `متبقٍ ${total - done} طلب — امسح البوليصة بعد التجهيز ثم صوّر الصندوق.`}
            </p>
            {done > 0 && (
              <button className="btn b-ghost" onClick={() => setSheet("summary")}>
                عرض الملخّص والصور ({done})
              </button>
            )}
            <button className="btn b-ghost" onClick={() => void exportInventory()}>
              جرد الكميات (Excel)
            </button>
            {invMsg && <p className="note">{invMsg}</p>}
            <button className="btn b-ghost" onClick={() => setSheet("settings")}>
              الإعدادات
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
        className={scanFor || mode === "photo-shoot" ? "scan-video" : "cam-hidden"}
      />

      {/* ── scanner chrome, drawn over the preview ── */}
      {scanFor && (
        <ScannerOverlay
          title={
            camState === "recovering"
              ? "جارٍ إعادة تشغيل الكاميرا…"
              : photoMode === "group"
                ? `امسح بوليصة الطلب التالي — ${photoIds.length} مصوَّر`
                : "امسح بوليصة الطلب الذي انتهيت من تجهيزه"
          }
          flash={flash}
          onClose={endPhotoSession}
          footer={
            <>
              {photoWarn && (
                <div className="mismatch">
                  <b>تحذير: الطلب #{photoWarn.order.orderNumber} غير مطابق</b>
                  <span>
                    باقي طلبات هذه المجموعة تحتوي أصنافًا مختلفة عن هذا الطلب.
                  </span>
                  <ul>
                    {photoWarn.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <div className="b-row">
                    <button className="btn b-stop" onClick={() => setPhotoWarn(null)}>
                      تخطَّ هذا الطلب
                    </button>
                    <button className="btn b-line" onClick={() => beginShot(photoWarn.order)}>
                      صوّره رغم الاختلاف
                    </button>
                  </div>
                </div>
              )}
              <p className="note">
                {photoMode === "group"
                  ? "امسح بوليصة كل صندوق ثم صوّره — كل طلب يُحفظ في صورة باسمه."
                  : "امسح البوليصة، ثم صوّر الطلب — تُحفظ الصورة باسم رقم الطلب."}
              </p>
              {photoIds.length > 0 && (
                <p className="note">تم تصوير {photoIds.length} طلب في هذه الجلسة.</p>
              )}
              <button className="btn b-ghost" onClick={() => setManualPick((v) => !v)}>
                {manualPick ? "إخفاء الاختيار اليدوي" : "اختيار الطلب يدويًا"}
              </button>
              {manualPick && (
                <ManualPicker
                  orders={orders.filter((o) => !photoIds.includes(o.id))}
                  onAdd={(id) => {
                    const o = orders.find((x) => x.id === id);
                    if (o) offerShot(o);
                  }}
                />
              )}
              <button className="btn b-go" onClick={endPhotoSession}>
                {photoIds.length > 0 ? `إنهاء (${photoIds.length} صورة)` : "إنهاء"}
              </button>
            </>
          }
        />
      )}

      {mode === "photo-shoot" && photoTarget && (
        <ShootOverlay
          order={photoTarget}
          shot={photoIds.length}
          group={photoMode === "group"}
          busy={photoBusy}
          recovering={camState === "recovering"}
          flash={flash}
          onCapture={() => void capturePhoto()}
          onCancel={() => void cancelShot()}
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
          onClose={() => setPreview(null)}
          onStart={() => {
            const o = preview;
            setPreview(null);
            setSheet(null);
            void (async () => {
              // Straight to the shutter for this one box: the label has
              // already been identified by hand, so there is nothing to scan.
              setPhotoMode(null);
              photoModeRef.current = null;
              setPhotoIds([]);
              photoIdsRef.current = [];
              await ensureCamera();
              beginShot(o);
            })();
          }}
        />
      )}

      {sheet === "settings" && (
        <SettingsSheet
          prefs={prefs}
          onChange={updatePrefs}
          onCatalogChange={relinkBatch}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === "summary" && batch && (
        <Summary
          batch={batch}
          prefs={prefs}
          onClose={() => setSheet(null)}
          onReset={async () => {
            await clearAll();
            camRef.current?.dispose();
            camRef.current = null;
            setBatch(null);
            setSheet(null);
            setMode("setup");
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

/**
 * The shutter screen: the order that was just scanned, over a live viewfinder.
 *
 * The order card is on screen while the shot is framed so the contents can be
 * checked one last time against the box, and the order number is repeated on
 * the button because that is the name the file will carry.
 */
function ShootOverlay({
  order, shot, group, busy, recovering, flash, onCapture, onCancel,
}: {
  order: PackOrder;
  shot: number;
  group: boolean;
  busy: boolean;
  /** The camera is being brought back after the phone went away. */
  recovering: boolean;
  flash: Flash;
  onCapture: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="scanner">
      <div className="scanner-cam">
        <div className="camhint">
          {recovering
            ? "جارٍ إعادة تشغيل الكاميرا…"
            : `صوّر صندوق الطلب #${order.orderNumber}${group ? ` · ${shot} مصوَّر` : ""}`}
        </div>
      </div>
      <div className="scanner-foot">
        {flash && <div className={`flash ${flash.kind}`}>{flash.text}</div>}
        <OrderCard order={order} compact />
        <button className="btn b-shot" disabled={busy || recovering} onClick={onCapture}>
          <span className="ring" aria-hidden="true" />
          {busy
            ? "جارٍ الحفظ…"
            : recovering
              ? "جارٍ إعادة تشغيل الكاميرا…"
              : `التقط صورة #${order.orderNumber}`}
        </button>
        <button className="btn b-ghost" onClick={onCancel}>
          إلغاء
        </button>
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
        {order.items.map((it, i) => {
          return (
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
              <div className={single ? "row2" : "contents"}>
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

            </div>
          );
        })}
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
  order, index, count, onStep, packed, record, onClose, onStart,
}: {
  order: PackOrder;
  index: number;
  count: number;
  onStep: (delta: number) => void;
  packed: boolean;
  record?: PackRecord;
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
  function start() {
    if (packed && record?.hasPhoto) {
      if (!confirm("سيُستبدل الصورة المحفوظة لهذا الطلب. متابعة؟")) return;
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
            <ShotIcon />
            {packed ? "أعد تصوير هذا الطلب" : "صوّر هذا الطلب"}
          </button>
        </>
      }
    >
      {packed && record && (
        <div className="flash ok">
          تم تصويره · {new Date(record.packedAt).toLocaleTimeString("ar-SA")}
          {record.photoBytes ? ` · ${formatBytes(record.photoBytes)}` : ""}
        </div>
      )}
      <OrderCard order={order} />
    </Sheet>
  );
}

function ShotIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M3 6.5h3l1.2-2h5.6l1.2 2h3v9H3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="11" r="3" stroke="currentColor" strokeWidth="1.6" />
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
  batch, prefs, onClose, onReset,
}: {
  batch: Batch;
  prefs: Prefs;
  onClose: () => void;
  onReset: () => Promise<void>;
}) {
  const [store, setStore] = useState<{ used: number; quota: number } | null>(null);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: "" });
  const [invMsg, setInvMsg] = useState("");
  const [bulk, setBulk] = useState({ busy: false, done: 0, total: 0 });
  /** Batches still to hand to the share sheet, after the first tap. */
  const [queue, setQueue] = useState<{ batches: File[][]; at: number } | null>(null);
  // Probed once with a dummy file: the API is all-or-nothing per device.
  const shareSupported = useMemo(
    () => canShareFiles([new File([new Blob(["x"])], "a.jpg", { type: "image/jpeg" })]),
    [],
  );

  useEffect(() => {
    void usage().then(setStore);
  }, []);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const byId = new Map(batch.orders.map((o) => [o.id, o]));
  const records = [...batch.records].sort((a, b) => a.packedAt.localeCompare(b.packedAt));
  const withPhoto = records.filter((r) => r.hasPhoto).length;

  /** `SMSA - 278290423.jpg` — a photo is always exactly one order. */
  const photoName = (r: PackRecord) =>
    `${clipFileName(
      [byId.get(r.orderId)?.orderNumber ?? r.orderId],
      carrierCode([byId.get(r.orderId)]),
    )}.jpg`;

  async function watch(r: PackRecord) {
    const blob = await loadPhoto(r.orderId);
    if (!blob) return;
    setPreview({ url: URL.createObjectURL(blob), label: photoName(r) });
  }

  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  async function download(r: PackRecord) {
    const blob = await loadPhoto(r.orderId);
    if (blob) saveBlob(blob, photoName(r));
  }

  /**
   * Saves every photo to the phone, each as its own file.
   *
   * Not an archive: the point is having the pictures, and a zip on a phone is
   * something to fight with before you can see anything. Chrome asks once
   * whether the site may download several files and then lets them all
   * through, but it drops them if they arrive too fast, so they are spaced out
   * — which also keeps the progress honest rather than firing forty clicks
   * into a tab and hoping.
   */
  async function downloadAll() {
    const jobs = records.filter((r) => r.hasPhoto);
    if (jobs.length === 0) return;
    setBulk({ busy: true, done: 0, total: jobs.length });
    for (let i = 0; i < jobs.length; i++) {
      const blob = await loadPhoto(jobs[i].orderId);
      if (blob) saveBlob(blob, photoName(jobs[i]));
      setBulk({ busy: true, done: i + 1, total: jobs.length });
      if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 350));
    }
    setBulk({ busy: false, done: jobs.length, total: jobs.length });
  }

  /**
   * Share needs the files in hand *before* the tap.
   *
   * navigator.share() only works while the browser still considers the tap
   * "active" — about a second. Reading tens of megabytes out of IndexedDB
   * inside the click handler blew through that every time, and Chrome rejected
   * the share with NotAllowedError. Wrapping the blobs up front costs nothing
   * (a File wraps a disk-backed Blob, it does not copy it) and makes the
   * handler synchronous.
   *
   * The stocktake workbook rides along with the photos, so one trip to Drive
   * carries both the evidence and the figures it is evidence for.
   */
  const [readyFiles, setReadyFiles] = useState<File[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: File[] = [];
      for (const r of records) {
        if (!r.hasPhoto) continue;
        const blob = await loadPhoto(r.orderId);
        if (cancelled) return;
        if (blob) out.push(new File([blob], photoName(r), { type: blob.type || "image/jpeg" }));
      }
      try {
        const book = await buildInventoryWorkbook(batch.orders, activeBom(), activeCatalog(), prefs);
        if (cancelled) return;
        out.push(new File([book.blob], book.fileName, { type: book.blob.type }));
      } catch {
        // A stocktake that cannot be built must not hold up the photos.
      }
      if (!cancelled) setReadyFiles(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch]);

  /** Hands one batch to the share sheet, synchronously, and queues the rest. */
  function shareSet(batches: File[][], at: number) {
    const files = batches[at];
    if (!files?.length) return;
    if (!canShareFiles(files)) {
      setUpload({
        busy: false,
        msg: "هذا الجهاز لا يدعم المشاركة المباشرة — استخدم «حفظ» أو الرفع إلى Drive.",
      });
      return;
    }

    const more = at + 1 < batches.length;
    // Called synchronously so the tap is still "active" as far as Chrome is
    // concerned; anything awaited before this point loses that permission.
    shareFiles(files, `ملفات تجهيز الطلبات ${at + 1}/${batches.length}`)
      .then(() => {
        setQueue(more ? { batches, at: at + 1 } : null);
        setUpload({
          busy: false,
          msg: more
            ? `تمت مشاركة ${at + 1} من ${batches.length} — اضغط للمتابعة.`
            : "تمت مشاركة كل الملفات ✓",
        });
      })
      .catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : "";
        if (name === "AbortError") {
          // Cancelled on purpose: keep the queue so it can be resumed.
          setUpload({ busy: false, msg: more ? `توقّفت عند ${at + 1} من ${batches.length}.` : "" });
          return;
        }
        setUpload({
          busy: false,
          msg:
            name === "NotAllowedError"
              ? "رفض المتصفح المشاركة — اضغط الزر مباشرة دون انتظار، أو استخدم «حفظ»."
              : "تعذّرت المشاركة — جرّب مرة أخرى أو استخدم «حفظ».",
        });
      });
  }

  function startShare() {
    if (readyFiles.length === 0) {
      setUpload({ busy: false, msg: "جارٍ تجهيز الملفات… أعد المحاولة بعد لحظة" });
      return;
    }
    const batches = shareBatches(readyFiles);
    setQueue({ batches, at: 0 });
    shareSet(batches, 0);
  }

  async function uploadAll() {
    if (!driveConfigured(prefs.driveClientId)) {
      // Explaining the one-time setup beats a silent no-op or a raw error.
      setUpload({
        busy: false,
        msg: "الرفع المباشر غير مفعّل — افتح الإعدادات ← الرفع إلى Drive وألصق معرّف Google.",
      });
      return;
    }
    setUpload({ busy: true, msg: "جارٍ تسجيل الدخول إلى Google…" });
    try {
      const token = await getAccessToken(prefs.driveClientId);

      // With a target folder configured, file everything under a dated folder
      // inside it — "26 Aug 2026" — so a day's work lands in one place.
      // Without one, fall back to a carrier-and-date folder at the Drive root.
      const parent = targetFolderId(prefs.driveFolderId);
      const name = parent
        ? dayFolderName(new Date(batch.createdAt))
        : folderName(
            batch.orders.find((o) => o.carrierName)?.carrierName ?? "Orders",
            new Date(batch.createdAt),
          );
      setUpload({ busy: true, msg: `تجهيز المجلد «${name}»…` });
      const folderId = await ensureFolder(token, name, parent);

      const jobs = records.filter((r) => r.hasPhoto);
      let uploaded = 0;
      for (let i = 0; i < jobs.length; i++) {
        setUpload({ busy: true, msg: `رفع ${i + 1} من ${jobs.length}…` });
        const blob = await loadPhoto(jobs[i].orderId);
        if (!blob) continue;
        await uploadFile(token, folderId, photoName(jobs[i]), blob);
        uploaded++;
      }

      // The stocktake belongs with the photos: the figures and the evidence
      // for them end up in the same folder, on the same trip.
      setUpload({ busy: true, msg: "رفع ملف الجرد…" });
      const book = await buildInventoryWorkbook(batch.orders, activeBom(), activeCatalog(), prefs);
      await uploadFile(token, folderId, book.fileName, book.blob);

      // A manifest so a shared photo can still be traced back to its order.
      const csv = [
        "رقم الطلب,العميل,المدينة,وقت التصوير,الملف",
        ...records.map((r) => {
          const o = byId.get(r.orderId);
          const cell = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
          return [
            o?.orderNumber ?? r.orderId,
            o?.customerName ?? "",
            o?.city ?? "",
            new Date(r.packedAt).toLocaleString("ar-SA"),
            r.hasPhoto ? photoName(r) : "",
          ]
            .map((v) => cell(String(v)))
            .join(",");
        }),
      ].join("\n");
      await uploadText(token, folderId, `${safeFileName(name)} - الملخّص.csv`, csv);

      setUpload({
        busy: false,
        msg: `تم رفع ${uploaded} صورة و ملف الجرد والملخّص إلى «${name}»`,
      });
    } catch (e) {
      setUpload({
        busy: false,
        msg: e instanceof Error ? `فشل الرفع: ${e.message}` : "فشل الرفع",
      });
    }
  }

  const pending = queue && queue.at < queue.batches.length;

  return (
    <>
      <Sheet
        title="الملخّص"
        onClose={onClose}
        footer={
          <>
            {/* The stocktake covers every order that was uploaded, so it is
                offered here as well as on the home screen — this sheet is
                where the batch gets wrapped up. */}
            <button
              className="btn b-ghost"
              onClick={() => {
                setInvMsg("جارٍ تجهيز الملف…");
                void downloadInventory(batch.orders, activeBom(), activeCatalog(), prefs)
                  .then((out) =>
                    setInvMsg(
                      inventoryMessage(out),
                    ),
                  )
                  .catch((e: unknown) =>
                    setInvMsg(e instanceof Error ? `تعذّر إنشاء الجرد: ${e.message}` : "تعذّر إنشاء الجرد"),
                  );
              }}
            >
              جرد الكميات (Excel)
            </button>
            {invMsg && <p className="note">{invMsg}</p>}

            {/* Always offered, not gated on the batch being finished: a long
                day is often uploaded in stages, and already-packed orders are
                the ones at risk if the phone fills up or is lost. */}
            <button
              className="btn b-drive"
              disabled={upload.busy || withPhoto === 0}
              onClick={() => (pending ? shareSet(queue.batches, queue.at) : startShare())}
            >
              {upload.busy
                ? upload.msg
                : withPhoto === 0
                  ? "لا صور بعد"
                  : pending
                    ? `تابع المشاركة (${queue.at + 1} من ${queue.batches.length})`
                    : `أرسل ${withPhoto} صورة + الجرد إلى Drive`}
            </button>
            {driveConfigured(prefs.driveClientId) && (
              <button
                className="btn b-ghost"
                disabled={upload.busy || withPhoto === 0}
                onClick={() => void uploadAll()}
              >
                رفع تلقائي إلى مجلد Drive (بلا حد للعدد)
              </button>
            )}
            <button
              className="btn b-line"
              disabled={bulk.busy || withPhoto === 0}
              onClick={() => void downloadAll()}
            >
              {bulk.busy
                ? `جارٍ التحميل… ${bulk.done} من ${bulk.total}`
                : `تحميل جميع الصور (${withPhoto})`}
            </button>
            {!bulk.busy && bulk.total > 0 && (
              <p className="note">تم تحميل {bulk.done} صورة إلى جهازك.</p>
            )}
            <div className="b-row">
              <button
                className="btn b-stop"
                onClick={() => {
                  if (confirm("سيُحذف كل شيء: الطلبات والصور. متأكد؟")) void onReset();
                }}
              >
                دفعة جديدة
              </button>
            </div>
          </>
        }
      >
        <p className="note">
          {records.length} طلب · {withPhoto} صورة
          {store && ` · مساحة مستخدمة ${formatBytes(store.used)}`}
        </p>

        {!upload.busy && upload.msg && <div className="flash ok">{upload.msg}</div>}
        {shareSupported && withPhoto > SHARE_MAX_FILES && (
          <p className="note">
            المشاركة تُرسل {SHARE_MAX_FILES} ملفات في كل مرة — حدّ يفرضه المتصفح
            نفسه. اضغط الزر مرة بعد كل إرسال حتى تنتهي، أو استخدم الرفع التلقائي
            إلى Drive الذي يرفع الكل دفعة واحدة.
          </p>
        )}
        {!driveConfigured(prefs.driveClientId) && (
          <p className="note">
            الرفع التلقائي غير مفعّل — أضِف معرّف Google من الإعدادات ← الرفع إلى
            Drive. زر المشاركة أعلاه يعمل بدونه.
          </p>
        )}


        <div className="list">
          {records.map((r, i) => {
            const o = byId.get(r.orderId);
            return (
              <div className="lrow" key={r.orderId}>
                <span className="n">{i + 1}</span>
                <span className="t">
                  <b>#{o?.orderNumber ?? r.orderId}</b>
                  <span>{o?.customerName ?? "—"}</span>
                  <span>
                    {new Date(r.packedAt).toLocaleTimeString("ar-SA")}
                    {r.photoBytes ? ` · ${formatBytes(r.photoBytes)}` : " · بلا صورة"}
                  </span>
                </span>
                {r.verified && <span className="chip done">✓ تحقّق</span>}
                {r.hasPhoto && (
                  <span className="acts">
                    <button className="chip" onClick={() => void watch(r)}>
                      عرض
                    </button>
                    <button className="chip" onClick={() => void download(r)}>
                      حفظ
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <p className="note">
          الصور محفوظة على هذا الجهاز فقط. احفظ ما تحتاجه قبل بدء دفعة جديدة.
        </p>
      </Sheet>

      {preview && (
        <div className="sheet" onClick={() => setPreview(null)} style={{ zIndex: 60 }}>
          <div className="inner" onClick={(e) => e.stopPropagation()}>
            <div className="grab" />
            <h3 className="sheet-title">{preview.label}</h3>
            <img src={preview.url} alt={preview.label} className="preview" />
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
  const [busy, setBusy] = useState(false);
  const [catalogCount, setCatalogCount] = useState(BUILT_IN_CATALOG.length);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState("");
  /** The orders PDF had no text layer, so the labels-only route is offered. */
  const [noText, setNoText] = useState(false);
  const [stats, setStats] = useState<BuildStats | null>(null);
  const pending = useRef<Batch | null>(null);

  // Read after mount: localStorage on the first render would not match the
  // server-rendered markup.
  useEffect(() => setCatalogCount(activeCatalog().length), []);

  /**
   * Reads the uploads.
   *
   * `skipOrders` retries with the orders PDF ignored, which is the way out of
   * an export that has no text in it: the labels alone carry enough to pack
   * from, and offering that beats leaving the merchant stuck at the door.
   */
  async function go(skipOrders = false) {
    if (!labels) return;
    setBusy(true);
    setError("");
    setNoText(false);
    try {
      const { batch, stats: s } = await buildBatch(
        skipOrders ? null : orders,
        labels,
        activeCatalog(),
        setProgress,
      );
      if (batch.orders.length === 0) {
        setError(
          "لم نتعرّف على أي طلب — لا في ملف الطلبات ولا في البوليصات. تأكد أنها ملفات سلة/شركة الشحن الصحيحة.",
        );
        setBusy(false);
        return;
      }
      pending.current = batch;
      setStats(s);
      setBusy(false);
    } catch (e) {
      // A file with no text layer is not a parse failure to retry — it is a
      // dead end, and the only useful next step is the labels-only route.
      if (e instanceof NoTextLayerError) setNoText(e.which === "orders");
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
          <Picker n="١" label="ملف الطلبات (اختياري)" hint="«تجهيز الطلبات» من سلة — لا تستخدم «الفواتير»"
            accept="application/pdf" file={orders} onPick={setOrders} />
          <Picker n="٢" label="ملف البوليصات" hint="polices.pdf من شركة الشحن"
            accept="application/pdf" file={labels} onPick={setLabels} />
          {/* The product list is built into the app and is not asked for each
              time. الإعدادات replaces it on the rare occasion it changes. */}
          <p className="note">
            قائمة المنتجات مضمَّنة في التطبيق ({catalogCount} منتجًا بصورها
            وأسعارها) — لا حاجة لرفعها. حدّثها من الإعدادات عند تغيّرها.
          </p>

          {error && <div className="err">{error}</div>}
          {noText && (
            <button className="btn b-line" disabled={busy} onClick={() => void go(true)}>
              تابع بملف البوليصات وحده
            </button>
          )}
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
              {/* Built from the labels: say so plainly. The data is thinner
                  than the orders PDF gives, and the packer should know which
                  source they are trusting before they start filling boxes. */}
              {stats.source === "labels" && (
                <div className="flash warn">
                  قُرئت الطلبات من البوليصات نفسها (وصف محتويات الشحنة)، لا من
                  ملف الطلبات. الأصناف والكميات مأخوذة من نص البوليصة — راجعها
                  قبل التعبئة.
                </div>
              )}
              {stats.unreadItems > 0 && (
                <div className="err">
                  {stats.unreadItems} صنف لم نطابقه مع ملف المنتجات — سيظهر
                  بالنص كما هو على البوليصة.
                </div>
              )}
              {stats.approximateItems > 0 && (
                <div className="flash warn">
                  {stats.approximateItems} صنف كميته غير مؤكدة — مُعلَّم على
                  بطاقة الطلب.
                </div>
              )}
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
            <button className="btn b-go" disabled={!labels || busy} onClick={() => void go()}>
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
  prefs, onChange, onCatalogChange, onClose,
}: {
  prefs: Prefs;
  onChange: (p: Partial<Prefs>) => void;
  /** Re-links the open batch after the product list is replaced or restored. */
  onCatalogChange: (products: Product[]) => Promise<string>;
  onClose: () => void;
}) {
  const speech = canSpeak();
  const [driveTest, setDriveTest] = useState("");
  const [bom, setBom] = useState<StoredBom | null>(null);
  const [bomMsg, setBomMsg] = useState("");
  const bomRef = useRef<HTMLInputElement>(null);
  const [cat, setCat] = useState<StoredCatalog | null>(null);
  const [catMsg, setCatMsg] = useState("");
  const catRef = useRef<HTMLInputElement>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  // Read after mount: localStorage on the first render would not match the
  // server-rendered markup.
  useEffect(() => {
    setBom(loadStoredBom());
    setCat(loadStoredCatalog());
  }, []);

  const costed = (cat?.products ?? BUILT_IN_CATALOG).filter(
    (p) => p.cost !== undefined,
  ).length;
  const catalogSize = (cat?.products ?? BUILT_IN_CATALOG).length;

  /** One tariff, as three inputs on one row. */
  const tariffRow = (key: ShipService) => {
    const t = prefs.shipping[key];
    const set = (patch: Partial<typeof t>) =>
      onChange({ shipping: { ...prefs.shipping, [key]: { ...t, ...patch } } });
    return (
      <div className="blk-sub" key={key}>
        <b>{t.label}</b>
        <div className="b-row">
          <label className="fieldlet">
            <span>تكلفتها علينا</span>
            <input
              type="number"
              inputMode="decimal"
              value={t.cost}
              onChange={(e) => set({ cost: Number(e.target.value) })}
            />
          </label>
          <label className="fieldlet">
            <span>على العميل</span>
            <input
              type="number"
              inputMode="decimal"
              value={t.charged}
              onChange={(e) => set({ charged: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="list">
          <Toggle
            label="تكلفتنا شاملة الضريبة"
            note="أطفئها إن كان السعر المتفق عليه بدون ضريبة."
            on={t.costIncludesVat}
            onToggle={() => set({ costIncludesVat: !t.costIncludesVat })}
          />
        </div>
      </div>
    );
  };

  return (
    <Sheet title="الإعدادات" onClose={onClose}>
      <div className="blk">
        <b className="blk-title">أثناء التصوير</b>
        <div className="list">
          <Toggle
            label="اقرأ محتويات الطلب بصوت"
            note="عند مسح البوليصة، يُقرأ ما يوضع في الصندوق."
            disabled={!speech}
            disabledNote="لا يدعم هذا الجهاز النطق."
            on={prefs.voice && speech}
            onToggle={() => onChange({ voice: !prefs.voice })}
          />
        </div>
      </div>

      <div className="blk">
        <b className="blk-title">قائمة المنتجات</b>
        <p className="note">
          القائمة مضمَّنة في التطبيق ولا تُرفع مع كل دفعة — الأسماء والصور
          والأسعار وأسعار التكلفة كلها بداخلها. ارفع نسخة جديدة فقط عند تغيّر
          المنتجات أو الأسعار.
        </p>
        <p className="note">
          {cat
            ? `المستخدمة الآن: «${cat.fileName}» — ${catalogSize} منتجًا، منها ${costed} لها سعر تكلفة.`
            : `المستخدمة الآن: القائمة المضمَّنة — ${catalogSize} منتجًا، منها ${costed} لها سعر تكلفة.`}
        </p>
        {costed < catalogSize && (
          <p className="note">
            المنتجات بلا سعر تكلفة تُحتسب بصفر في صفحة الأرباح، فيظهر الربح
            أعلى من الحقيقة. أضِف عمود «سعر التكلفة» في ملف المنتجات وارفعه.
          </p>
        )}
        <input
          ref={catRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setCatMsg("جارٍ القراءة…");
            void readCatalog(f)
              .then(async (products) => {
                if (products.length === 0) {
                  setCatMsg("لم يُقرأ أي منتج من الملف.");
                  return;
                }
                setCat(saveCatalog(products, f.name));
                const relinked = await onCatalogChange(products);
                setCatMsg(`تم — ${products.length} منتجًا. ${relinked}`.trim());
              })
              .catch((err: unknown) =>
                setCatMsg(err instanceof Error ? `تعذّرت القراءة: ${err.message}` : "تعذّرت القراءة"),
              );
          }}
        />
        <button className="btn b-line" onClick={() => catRef.current?.click()}>
          رفع قائمة منتجات محدَّثة
        </button>
        {cat && (
          <button
            className="btn b-ghost"
            onClick={() => {
              clearCatalog();
              setCat(null);
              void onCatalogChange(BUILT_IN_CATALOG).then((r) =>
                setCatMsg(`عادت القائمة المضمَّنة. ${r}`.trim()),
              );
            }}
          >
            العودة إلى القائمة المضمَّنة
          </button>
        )}
        {catMsg && <p className="note">{catMsg}</p>}
      </div>

      <div className="blk">
        <b className="blk-title">الشحن والضريبة — لحساب الأرباح</b>
        <p className="note">
          تُحسب صفحة «المبيعات والأرباح» من هذه الأرقام. غيّرها متى تغيّرت
          أسعار شركات الشحن — بلا حاجة لإعادة نشر التطبيق.
        </p>
        <label className="fieldlet">
          <span>نسبة ضريبة القيمة المضافة ٪</span>
          <input
            type="number"
            inputMode="decimal"
            value={prefs.vatPercent}
            onChange={(e) => onChange({ vatPercent: Number(e.target.value) })}
          />
        </label>
        {(["dn", "smsaHome", "smsaPickup"] as const).map(tariffRow)}
        <p className="note">
          نوع شحن سمسا (منزلي أو استلام من الفرع) يُقرأ من البوليصة نفسها؛ إن
          لم تذكره، يُحتسب على أنه توصيل منزلي وهو الأعلى تكلفة.
        </p>
      </div>

      <div className="blk">
        <b className="blk-title">ملف الجرد — مكوّنات كل منتج</b>
        <p className="note">
          يُحسب «جرد الكميات» من جدول يقول ماذا يُستهلك فعليًا عند بيع كل منتج
          أو بكج. الجدول المرفق مضمَّن في التطبيق، فلا حاجة لرفع شيء — ارفع
          نسخة محدّثة فقط عند تغيّر مكوّنات أي بكج.
        </p>
        <p className="note">
          {bom
            ? `المستخدم الآن: «${bom.fileName}» — المنتجات: ${bom.bom.rows.length} · المواد: ${bom.bom.components.length}.`
            : `المستخدم الآن: الجدول المضمَّن — المنتجات: ${BUILT_IN_BOM.rows.length} · المواد: ${BUILT_IN_BOM.components.length}.`}
        </p>
        <input
          ref={bomRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setBomMsg("جارٍ القراءة…");
            void readBomFile(f)
              .then((parsed) => {
                setBom(saveBom(parsed, f.name));
                setBomMsg(`تم — المنتجات: ${parsed.rows.length} · المواد: ${parsed.components.length}.`);
              })
              .catch((err: unknown) =>
                setBomMsg(err instanceof Error ? `تعذّرت القراءة: ${err.message}` : "تعذّرت القراءة"),
              );
          }}
        />
        <button className="btn b-line" onClick={() => bomRef.current?.click()}>
          رفع ملف جرد محدَّث
        </button>
        {bom && (
          <button
            className="btn b-ghost"
            onClick={() => {
              clearBom();
              setBom(null);
              setBomMsg("عاد التطبيق إلى الجدول المضمَّن.");
            }}
          >
            العودة إلى الجدول المضمَّن
          </button>
        )}
        {bomMsg && <p className="note">{bomMsg}</p>}
      </div>

      <div className="blk">
        <b className="blk-title">الرفع إلى Drive</b>
        <p className="note">
          للرفع المباشر بلا مشاركة يدوية، يحتاج Google معرّف تطبيق مرتبط بهذا
          الموقع — لا توجد طريقة تتجاوز ذلك، فحساب Google في المتصفح وحده لا
          يمنح أي موقع صلاحية الكتابة في Drive. تُلصق البيانات هنا، فلا حاجة
          لإعادة نشر التطبيق.
        </p>
        <ol className="steps">
          <li>افتح console.cloud.google.com وأنشئ مشروعًا.</li>
          <li>فعّل «Google Drive API».</li>
          <li>OAuth consent screen ← External ← أضف بريدك في Test users.</li>
          <li>
            Credentials ← OAuth client ID ← Web application، وأضف هذا العنوان في
            «Authorised JavaScript origins»:
            <code className="origin">{origin}</code>
          </li>
          <li>انسخ الـ Client ID وألصقه بالأسفل.</li>
        </ol>
        <input
          className="searchbar"
          value={prefs.driveClientId}
          onChange={(e) => onChange({ driveClientId: e.target.value.trim() })}
          placeholder="Client ID …apps.googleusercontent.com"
          style={{ direction: "ltr", textAlign: "left" }}
        />
        <input
          className="searchbar"
          value={prefs.driveFolderId}
          onChange={(e) => onChange({ driveFolderId: e.target.value.trim() })}
          placeholder="رابط مجلد Drive أو معرّفه"
          style={{ direction: "ltr", textAlign: "left" }}
        />
        <p className="note">
          {prefs.driveFolderId
            ? `سيُرفع داخل مجلد باسم اليوم داخل: ${targetFolderId(prefs.driveFolderId)}`
            : "بدون مجلد، تُنشأ مجلدات باسم الناقل والتاريخ في جذر Drive."}
        </p>
        <button
          className="btn b-line"
          disabled={!prefs.driveClientId || driveTest === "جارٍ الاختبار…"}
          onClick={() => {
            setDriveTest("جارٍ الاختبار…");
            void (async () => {
              try {
                const token = await getAccessToken(prefs.driveClientId);
                const parent = targetFolderId(prefs.driveFolderId);
                // Creating the day folder is the same call the real upload
                // makes, so a pass here means the real thing will work.
                await ensureFolder(token, dayFolderName(new Date()), parent);
                setDriveTest("تم الاتصال ✓ — المجلد جاهز");
              } catch (e) {
                setDriveTest(e instanceof Error ? `فشل: ${e.message}` : "فشل الاختبار");
              }
            })();
          }}
        >
          اختبر الاتصال بـ Drive
        </button>
        {driveTest && <p className="note">{driveTest}</p>}
      </div>

      <div className="blk">
        <b className="blk-title">دقة الصورة</b>
        <div className="list">
          {(["ultra", "high", "balanced", "saver"] as const).map((q) => (
            <button
              key={q}
              className="lrow"
              onClick={() => onChange({ photoQuality: q })}
            >
              <span className="t">
                <b style={{ direction: "rtl", textAlign: "start" }}>{QUALITY[q].label}</b>
                <span>{QUALITY[q].note}</span>
              </span>
              {prefs.photoQuality === q && <span className="chip done">مُختار</span>}
            </button>
          ))}
        </div>
        <p className="note">
          إن كان جهازك يدعم التقاط الصور بدقة المستشعر، فالصورة تُلتقط بدقته
          الكاملة وهذا الإعداد يحكم المعاينة فقط.
        </p>
      </div>
    </Sheet>
  );
}
