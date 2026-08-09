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
| **Setup** (once per batch) | Pick `Prep Orders.pdf`, `polices.pdf`, and optionally `list of products.xlsx`. Parsed on-device in a few seconds. |
| **Scan** | Point the camera at a label barcode. Counter at the top reads `3 / 30`. |
| **Pack** | Large product photos with quantities. Recording starts automatically; a timer runs. |
| **Next** | Scan the same label to finish, or scan a different one to finish this order and start that one in one move. |
| **Summary** | Per-order time, video size, and a save button for each clip. |

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

Verified against your real files (`Prep Orders.pdf`, `polices.pdf`,
`list of products.xlsx`), driven through the actual UI in a browser:

- 30 orders and 30 labels parsed, **30/30 matched** by order number
- 32 line items across the batch, including the two multi-item orders
- all 8 distinct products resolved to a catalog photo
- counter, timer, per-order duration, and IndexedDB persistence

**Not verified, because this environment has no camera:** live barcode
detection and video recording. The code paths are written and typed but have
never seen a real label or produced a real clip. Test those first on the phone,
with one order, before trusting a whole batch to it.

The specific thing to check: **the barcode on your Deliver Now labels must
encode the `DNL…` tracking number or the 9-digit order number.** Those are the
values the app matches against. If it encodes something else (an internal
courier id, say), scans will come back "باركود غير معروف" — tell me what it
reads and it is a small change.

There is a manual picker (**الطلبات** button) that selects any order without
scanning, so the app is still usable if the camera path disappoints.

---

## Notes and limits

- **Barcode scanning uses the browser's built-in `BarcodeDetector`**, which
  Chrome on Android supports. Safari/iOS does not; there the app shows a notice
  and you use the manual picker.
- **Videos live only on that phone**, in IndexedDB. They are not uploaded
  anywhere. Save the ones you need from the summary screen before starting a
  new batch — "دفعة جديدة" deletes all of them.
- **Video is picture-only, no audio.** Fewer permissions, smaller files.
- Roughly 1.5 Mbps, so a two-minute pack is about 20 MB. Thirty of those is
  ~600 MB; the summary screen shows current usage.
- **Product photos are hot-linked to Salla's CDN**, so the first view of each
  needs a connection. Everything else works offline.
- The Excel is optional — without it you still get names and quantities, just
  no photos.
