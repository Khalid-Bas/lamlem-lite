# لملم — تجهيز (lite)

A single-screen packing tool for one person with a phone.

Upload the two PDFs (plus the product Excel for photos) → scan a shipping label
with the phone camera → see exactly what goes in the box → the packing is
recorded → scan the next label → the video and the elapsed time are saved.

Everything runs on the phone. No server, no account, no database, and none of
your customer data leaves the device.

---

## The flow

| | |
|---|---|
| **Setup** (once per batch) | Pick `Prep Orders.pdf`, `polices.pdf`, and the product list (`.xlsx` or `.csv`). Parsed on-device in a few seconds, then a summary shows how many orders, labels and photos were resolved — check this before packing. |
| **Scan** | Tap **مسح الباركود**. The camera opens only for the scan, then closes. Counter at the top reads `3 / 30`. |
| **Pack** | Large product photos with quantities. Recording starts automatically; a timer runs. The camera preview is hidden — the scan button sits in its place. |
| **Next** | Tap **مسح الباركود** and scan the next label: the current order is saved and the new one starts in one move. Or tap **تم** to just finish. |
| **Group** | **تجهيز مجموعة طلبات** — scan several labels, start one recording, pack them together, stop, then re-scan each label to confirm. All of them are marked done and share the clip. |
| **Summary** | Per-order time, customer name, video size, **مشاهدة** to preview in place, **حفظ** to download, and — once every order is packed — **رفع إلى ملف Drive**. |

Everything is resumable: close the app mid-batch and it reopens where you left off.

---

## Deploying to Vercel

The camera and video recording **require HTTPS**, so this has to be deployed
(or run behind an HTTPS tunnel) — `http://localhost` on a phone will not get
camera permission.

```bash
git init && git add -A && git commit -m "Initial commit"
```

Push to GitHub, then import at [vercel.com/new](https://vercel.com/new) and set
the **Root Directory to `lamlem-lite`**. No environment variables, no database,
nothing to configure.

## Google Drive upload (optional)

The **رفع إلى ملف Drive** button appears in the summary once every order in the
batch is packed. It creates a folder named after the carrier and the batch date
— `SMSA - 24/08/2026` — and uploads one clip per recording.

It needs a Google OAuth client, which only you can create:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → add yourself under *Test users*.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under *Authorised JavaScript origins* add your Vercel URL
   (e.g. `https://lamlem-lite-two.vercel.app`).
5. Copy the client ID into Vercel → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | `…apps.googleusercontent.com` |

Redeploy. Without this variable the button stays hidden rather than failing
when tapped.

The scope requested is `drive.file`, which lets the app touch **only files it
creates itself** — it cannot read anything already in your Drive. Note that
uploading does send packing videos, which show customer labels, to Google.

## Installing on Android

1. Open the Vercel URL in **Chrome**.
2. Menu → **Add to Home screen**.
3. Launch it from the home screen and allow the camera when asked.

It runs full-screen in portrait like a normal app.

---

## Local development

```bash
cd lamlem-lite && npm install && npm run dev
```

```bash
npm test && npm run typecheck && npm run build
```

The upload/parse/pack/summary flow works in a desktop browser. Barcode scanning
and video recording need a real device.

---

## What I could and could not verify

Driven through the real UI against your real files (`Prep Orders.pdf`,
`polices.pdf`, and the product list as **both** `.xlsx` and `.csv`):

- 30 orders and 30 labels parsed, **30/30 matched**
- 32 line items, **32/32 linked to a catalog product with a photo** (both file
  formats)
- variant text repaired from the catalog: `نوع الحليب م�وب اوت�` → **نوع
  الحليب: مشروب اوتلي**
- product names no longer glued: **استكر شيت من تصميم قوت**
- sheets scroll through all 30 rows
- group session: collect 3 → record → stop → verify 3 → all marked done,
  counter 2/30 → 5/30, each row labelled *ضمن مجموعة*
- summary shows customer names; timings and IndexedDB persistence survive reload

**Not verified, because this environment has no camera:** live barcode
detection, video recording, and therefore the **مشاهدة** preview and the Drive
upload (which need real clips). The Drive code path also cannot be exercised
until you create the OAuth client.

Two things worth testing first on the phone, with one order:

1. The scan still resolves after the change to an on-demand camera.
2. **رفع إلى ملف Drive** end to end, once the client ID is set.

If a label ever refuses to scan, every flow has a manual fallback — the
**الطلبات** button for single orders, **إضافة يدويًا** / **تأكيد يدويًا**
inside a group session.

---

## Notes and limits

- **Barcode scanning uses the browser's built-in `BarcodeDetector`**, which
  Chrome on Android supports. Safari/iOS does not; there the app shows a notice
  and you use the manual pickers.
- **The camera opens only while the scanner is on screen**, and is released
  again afterwards — except while a recording is running, which necessarily
  keeps it open. The preview is hidden during packing; the scan button sits
  where it used to be.
- **Videos live only on that phone**, in IndexedDB, unless you upload them.
  "دفعة جديدة" deletes all of them.
- **Video is picture-only, no audio.** Fewer permissions, smaller files.
- A group session stores **one clip shared by every order in it**; the per-order
  time shown is the session split evenly, and the row says *ضمن مجموعة*.
- Roughly 1.5 Mbps, so a two-minute pack is about 20 MB. The summary shows
  current usage.
- **Product photos are hot-linked to Salla's CDN**, so the first view of each
  needs a connection.
- The product list is technically optional, but without it there are no photos
  and no variant repair — the setup screen now reports the photo count so a
  missing or stale file is obvious before you start packing.
