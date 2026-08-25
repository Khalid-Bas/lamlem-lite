# لَمّ — لتجهيز الطلبات

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
| **Group** | **تجهيز مجموعة طلبات** — scan several labels, pack them together, then re-scan each label to confirm. **The recording runs through the whole session, verification included**, so the confirming scan of every sealed box is on film. All of them are marked done and share one clip. |
| **Summary** | Per-order time, customer name, video size, **مشاهدة** to preview in place, **حفظ** to download, and **رفع … فيديو إلى Drive** — available at any time, not only once the batch is finished. |

Tapping an order in **الطلبات** opens a **read-only preview** — items, photos,
quantities — and never touches the camera. Recording starts only from the
explicit **ابدأ التعبئة والتسجيل** button inside it. If another order is already
being packed the button says so and asks first; the running recording keeps
going while you look. Previewing an order that is already done offers
**إعادة التعبئة والتسجيل**, which warns that the stored video will be replaced.

Before a group recording starts, the app compares what every selected order
actually contains — product, chosen variant and quantity — and stops on a full
red screen if one differs, naming the exact reason: *صنف إضافي: ملعقة ماتشا*,
*عدد الأصناف 2 بدل 1*, *الكمية 3 بدل 1*. Continuing is deliberate; cancelling
returns to the home screen with nothing recorded. Packing several boxes from one
pile only works when they hold the same thing, and this is where that goes wrong.

## Guarding against packing the wrong item

Flag the products that are easy to grab by mistake under **الإعدادات → أصناف
تحتاج انتباهًا**. While any order containing one is being packed:

- a **calm two-note tone plays for the whole recording**, with a **♪ صنف انتبه
  له** chip in the header so the hum reads as a deliberate cue, not a fault
- the item card turns amber and names the products it is most easily confused
  with — *ليس: ماتشا زعفراني 150 جرام* — because telling the packer what to rule
  out is far more useful than "check carefully"
- the order cannot be finished until the item is explicitly ticked

The look-alikes are worked out from the batch itself, by word overlap: it pairs
the black and white matcha bundles, the Ethiopian and Colombian coffee cartons,
and a standalone product with the bundle that contains it — while ignoring weak
pairs that merely share one word, like a matcha tea and a matcha spoon.

Scanning is **only** active while the scanner is on screen. During packing the
detector is off, so a label lying on the bench cannot end the order or restart
the recording.

**الإعدادات** (on the main screen) holds three switches: read the order aloud
when a label scans, ask for a confirming re-scan after each order, and video
quality. All presets record 1080p at 24fps; only the bitrate changes.
**أعلى وضوح** (6 Mbps, ~45 MB/min) is the default and the one confirmed
legible on a real label. **متوازنة** (3.5 Mbps, ~26 MB/min) and **موفّرة**
(720p, ~15 MB/min) trade sharpness for space.

After an order is finished, the app asks for a confirming re-scan of the sealed
box. Scanning the wrong label says which order it actually belongs to and keeps
waiting; scanning the right one stamps the record with ✓ تحقّق in the summary.
It can be skipped per-order, or switched off entirely.

The Android back button closes whatever is on top — scanner, preview, sheet —
innermost first, and only offers to leave the app when nothing is open.

In **الطلبات**, swipe left/right (or use ‹ السابق / التالي ›) to flick through
every order without closing the preview.

Every scan gives feedback you can feel and hear without looking: a single buzz
and tick for a good read, a double buzz and low two-tone for an unknown code,
a rising C–E–G chime when an order is done, and a longer flourish when the last
order in the batch is packed.

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

## Getting videos into Drive

**أرسل … فيديو إلى Drive** in **الملخص** needs no setup at all. It hands the
clips to Android's share sheet, where Drive appears as a target and uses the
Google account the phone is already signed in to. Two taps, nothing to
configure. Individual clips also get a **مشاركة** button.

There is no way to make this fully automatic without setup: reaching a user's
Drive silently requires the Drive API, and that requires an OAuth client
registered to this exact origin. Google does not allow an app to write to your
Drive just because the browser is signed in. The optional path below does give
you a named folder and unattended upload, at the cost of a one-time setup.

### Optional: unattended upload into a named folder

With `NEXT_PUBLIC_GOOGLE_CLIENT_ID` set, a second button appears that creates a
folder named after the carrier and batch date — `SMSA - 24/08/2026` — and
uploads every clip plus a CSV manifest without a share sheet.

A group session produces **one** clip covering all its orders, so the summary
lists it as a single row and offers a single **حفظ** — there is no need to
download the same file once per order. Filenames lead with the carrier — `SMSA - 2562445625.webm`,
`DN - 25556554 - 26554852.webm`, and `MIX` when a group spans two couriers — so
a folder of clips sorts by courier at a glance. A group clip lists every order
number it covers, trimmed with a count if
a session is long enough to exceed the 255-character filename limit. The same
name is used whether you save to the phone or upload. Alongside the videos it writes a
`… - الملخّص.csv` manifest listing every order, its customer, duration and which
video file it appears in, so a shared clip can still be traced back.

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

Also verified by substituting a synthetic camera (an animated canvas fed
through `getUserMedia`), which exercises the real video pipeline:

- the preview element receives frames — 640×480, `readyState 4`, sampled pixels
  are not black — on the first open **and** on every reopen
- the camera is acquired **once per batch** and stays live across scanner
  open/close, so no scan waits on re-acquisition
- recording produces a real file: a 19 KB `video/webm;codecs=vp9` clip stored in
  IndexedDB, with the duration recorded against the order
- **مشاهدة** plays that clip back inline (5.0s, 640×480, non-black frames)

**Still not verified:** decoding an actual printed barcode, which needs a real
camera pointed at a real label, and the Drive upload, which cannot run until you
create the OAuth client.

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
