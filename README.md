# لَمّ — لتجهيز الطلبات

A single-screen packing tool for one person with a phone.

Upload the shipping-label PDF → pack the box → scan its label with the phone
camera → see exactly what should be inside → photograph the sealed box → the
photo is filed under that order number.

Everything runs on the phone. No server, no account, no database, and none of
your customer data leaves the device.

---

## The flow

| | |
|---|---|
| **Setup** (once per batch) | Pick the **تجهيز الطلبات** PDF (optional) and `polices.pdf`. The product list is built into the app. Parsed on-device in a few seconds, then a summary shows how many orders, labels and photos were resolved — check this before packing. |
| **Pack, then shoot** | Pack the box first. Then **تصوير طلب واحد** or **تصوير مجموعة طلبات** — one tap, straight to the camera. |
| **Scan** | Scan the label on the sealed box. The order appears over a live viewfinder so the contents can be checked one last time. |
| **Shoot** | Tap the shutter. The photo is saved as `SMSA - 276451900.jpg` — carrier, then order number. Group mode goes straight back to the scanner for the next box. |
| **Summary** | Customer name, time, photo size, **عرض** to look at one in place, **حفظ** to download, and **أرسل … + الجرد إلى Drive** — available at any time, not only once the batch is finished. |
| **Stocktake** | **جرد الكميات (Excel)** — one workbook, three sheets: what sold, every carton and cup that sale consumed, and what the day actually earned. |

Tapping an order in **الطلبات** opens a **read-only preview** — items, photos,
quantities — and never touches the camera. **صوّر هذا الطلب** inside it goes
straight to the shutter for that one box, skipping the scan, for when a label
will not read. An order that already has a photo offers to replace it, and says
so first.

## The product list is built in

Names, photos, prices and cost prices ship inside the app, so a batch needs
only the two PDFs and product photos appear with nothing to pick. The list
changes a few times a year; re-uploading it before every batch was friction
with no payoff.

**الإعدادات → قائمة المنتجات** replaces it on the device when it does change,
and re-links the batch already open so the new names and photos reach the
orders on screen rather than waiting for the next one. **العودة إلى القائمة
المضمَّنة** puts the built-in list back. To change the built-in copy:

```bash
node --experimental-strip-types scripts/make-catalog.mjs "<قائمة المنتجات محدثة.xlsx>" "<full Salla export.xlsx>"
```

Two sources because no single export carries everything: the short list has the
current names, prices and image URLs, and the full Salla export has the **cost
prices** and the option values (نوع الحليب, لون المق) that the short list
drops. They are matched by SKU, and the full export is only used to fill gaps —
including by product *name*, so a sticker sheet re-issued under a new SKU
inherits the cost it has always had instead of reading as free.

## Which Salla export to use

Use **تجهيز الطلبات**, not **الفواتير**. Salla's invoice export draws every
glyph as vector outlines, so the file looks perfectly normal on screen but
carries **no text layer at all** — nothing can be extracted from it by any
tool, and no parser change can help. The app now says exactly that instead of
"we did not recognise any order", which sent people hunting for a bug that was
never in the code.

### Packing from the labels alone

The orders PDF is therefore **optional**. Every carrier prints the order's
contents on the label itself, in the description-of-goods field —
*بكج الماتشا (1) ،بكج القهوة مع مق (1)* — so **تابع بملف البوليصات وحده**
rebuilds the whole batch from `polices.pdf`: order number, customer, city,
tracking barcode, carrier, and what goes in the box.

That text arrives mangled. It is the smallest type on the label, it mixes
Arabic with Latin runs, and the bidi reordering leaves brackets mirrored and
the odd token out of place — *شاي ماتشا (150g (1*, *بكج ال (1) 99*. So the
names are never trusted as strings: each line is matched against the product
catalog **by token**, which survives all of it, and the quantity is whatever
number is left once the product name has been accounted for — which is why the
150 in `150g` is never read as a quantity. Where a token has been thrown across
a separator the whole description is matched as one run instead.

Anything that cannot be tied to a catalog product is **named on the setup
screen and flagged in amber on the order card**, never quietly dropped, and the
same goes for a quantity that had to be guessed. The setup screen also says
plainly that the batch came from the labels rather than the orders file.

A declared value (`DV:SAR 203.97`) is **not** money to collect. SMSA prints the
COD amount under a `COD/SAR` heading rather than inline, so the old pattern
never matched and the declared value was used instead — which would have told
the packer to collect for an order that was already paid. The heading's own
line is read now.

## Photographing the packed box

Two buttons on the home screen, each one tap from the camera: **تصوير طلب
واحد** and **تصوير مجموعة طلبات**. There is no video anywhere in the app — you
pack first, and the camera comes out at the end.

1. Scan the label on the box you have just finished.
2. The order appears over a live viewfinder, so the contents can be checked one
   last time against what is in front of you.
3. Tap the shutter. The photo is saved as **`SMSA - 283255858.jpg`** — carrier,
   then order number.

**طلب واحد** stops there and returns home. **مجموعة طلبات** goes straight back
to the scanner for the next box: scan, shoot, scan, shoot, with a running count
in the header. **Every order gets its own photo under its own number** — a
picture of one box is only evidence for that box.

In a group session the first order scanned sets what the session is, and every
later scan is held to it. Anything that differs stops the flow *before* the
shutter screen opens and names the reason — *صنف إضافي: ملعقة ماتشا*,
*الكمية 3 بدل 1* — offering **تخطَّ هذا الطلب** or **صوّره رغم الاختلاف**. The
manual picker runs the same check, so choosing a box by hand cannot slip past it.

In **الملخص**: **عرض** to look at a photo in place, **حفظ** to download one,
**تحميل جميع الصور** to save every one of them to the phone as its own file
(no archive to unpack — Chrome asks once whether the site may download several,
and they are spaced out because it drops them when they arrive too fast), and
one button that sends every photo *and* the stocktake workbook to Drive.
**دفعة جديدة** deletes them all.

## جرد الكميات — the stocktake

**جرد الكميات (Excel)** on the home screen (and in **الملخص**) downloads one
workbook with three sheets, covering **every order in the batch**, packed or
not — the question is how much stock to write down and what the day earned, not
how far the packing has got. The file is named for the day and the batch:
`جرد الكميات - 14 Sep - 10 طلب - 4 منتج.xlsx`.

| Sheet | What it answers |
|---|---|
| **المنتجات المباعة** | What was sold: product, chosen variant, SKU, Salla id, units, and how many orders those units are spread over. |
| **المواد المستهلكة** | What that costs the shelves: every carton, cup, sticker sheet, card and tin actually consumed. |
| **المبيعات والأرباح** | What the day earned: one row per order with its VAT, shipping cost, cost of goods, net profit and margin, and a totals row. |

The second sheet is the point. Selling one **بكج الجمعات** consumes a large
carton, ten printed cups, four sticker sheets, a card, a matcha tin and a litre
of oat drink — none of which is called "بكج الجمعات" anywhere in the warehouse.
Counting sold products alone leaves exactly the packaging that runs out
unnoticed.

The recipes come from your own sheet (**كمية المخزون المستهلكة من كل منتج**),
baked into the app so the button works on a fresh phone with nothing to set up.
When a recipe changes, upload the new sheet under **الإعدادات → ملف الجرد**; it
is kept on the device and **العودة إلى الجدول المضمَّن** puts the built-in one
back. To change the built-in copy instead:

```bash
node --experimental-strip-types scripts/make-bom.mjs "<the .xlsx>"
```

A row is found by SKU first — the sheet lists «استكر شيت من تصميم قوت» three
times for three printings and only the SKU tells them apart — then by exact
name, then by the variant rows whose names carry the option inline
(«بكج الجمعات - اسود/مشروب اوتلي»), scored against the option on the order.
Where the sheet splits a product by something the order never states (the
carton colour) both rows consume the same things, so nothing is flagged.

Anything the sheet cannot cost is **named on screen and marked in the
ملاحظة column** rather than silently dropped — a missing product, or one whose
row has no components filled in yet.

### المبيعات والأرباح — what the day actually earned

Three things have to be kept apart or the answer is wrong, and the sheet keeps
them in their own columns:

- **VAT is not income.** It is collected for ZATCA and comes out of the total
  before anything is called revenue. Everything downstream is net of VAT,
  because that is the only basis on which revenue and cost are comparable.
- **Shipping is charged *and* paid for.** What the customer paid is already
  inside the order total; what the carrier bills us is a real cost and is
  subtracted net of its own VAT, which is reclaimable.
- **Cost of goods** is the product's cost price times the units in the box.

The tariffs live in **الإعدادات → الشحن والضريبة**, so a renegotiated rate is a
number to edit rather than a redeploy. Out of the box:

| Service | Costs us | Charged |
|---|---|---|
| دليفر ناو | 14.00 excl. VAT | 22.98 incl. VAT |
| سمسا — توصيل منزلي | 29.00 incl. VAT (25.22 net) | 29.99 incl. VAT |
| سمسا — استلام من الفرع | 14.00 excl. VAT | 22.99 incl. VAT |

Which SMSA tariff applies is **read off the label**, which states the service
twice: `EDHD` / *HAL Delivery* is home delivery, `EDDL` / *Delivery Lite* is
branch pickup. An order with no label to say — read from the invoice alone —
is charged at home-delivery rates and the row says so, because understating a
cost flatters the profit.

A product with no cost price is **counted as zero and named**, in the row's
ملاحظة, in the totals row, and on screen when the file downloads. The profit is
then too high, and saying so is the whole point.

Scanning is **only** active while the scanner is on screen. Once a shot is
being framed the detector is off, so a label lying on the bench cannot jump to
a different order.

**الإعدادات** (on the main screen) holds: read the order aloud when a label
scans, the product list, the shipping tariffs and VAT rate, the stocktake
sheet, the Drive credentials, and photo resolution —
**فائقة** 1440p, **عالية** 1080p (the default), **متوازنة** 900p and
**موفّرة** 720p. On a phone that supports `ImageCapture` the shot is taken at
the sensor's own photo resolution and this governs the viewfinder only.

Because the label is scanned on the sealed box moments before the shot, every
photo record is stamped **✓ تحقّق** on the spot — there is no separate
confirming scan to do.

### The camera comes back by itself

Locking the screen, taking a call, or switching apps ends or mutes the camera
track, and Chrome does not restore it: the element keeps a dead stream and the
preview stays black until the page is reloaded. The camera now watches for
`visibilitychange`, `pageshow`, `focus`, and the track's own `ended`/`mute`
events, and repairs itself — playing again if the track survived, and throwing
the stream away and asking for a new one if it did not, retried a few times
because the dialer can still be holding the camera for a moment after a call.
The shutter is disabled and the screen says *جارٍ إعادة تشغيل الكاميرا…* while
that happens, so a shot is never taken of a frozen frame.

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

The camera **requires HTTPS**, so this has to be deployed
(or run behind an HTTPS tunnel) — `http://localhost` on a phone will not get
camera permission.

```bash
git init && git add -A && git commit -m "Initial commit"
```

Push to GitHub, then import at [vercel.com/new](https://vercel.com/new) and set
the **Root Directory to `lamlem-lite`**. No environment variables, no database,
nothing to configure.

## Getting photos into Drive

**أرسل … صورة + الجرد إلى Drive** in **الملخص** needs no setup. It hands the
photos — **and the stocktake workbook** — to Android's share sheet, where Drive
is a target using the Google account the phone is already signed in to. The
figures and the evidence for them land in the same place, on the same trip.

The files are wrapped up *when the summary opens*, not when the button is
tapped. `navigator.share()` only works while the browser still counts the tap
as active — roughly a second — and reading tens of megabytes out of storage
inside the handler blew past that every time, which is what produced
*"تعذّرت المشاركة"*.

### Why a big share is sent in batches

Ten photos shared fine and forty were refused outright. That is Chrome, not
this app: `navigator.canShare()` returns false once the set is past its limit,
and the limit is on payload size as well as count. There is no way to raise it
from a web page, so a large set is split into batches of **10 files / 45 MB**
and the button becomes **تابع المشاركة (2 من 4)** after each one. Every batch
is its own tap, which is what keeps the browser's user-activation check happy,
and nothing is dropped — cancel halfway and the queue is still there to resume.

The direct Drive upload below has no such limit and sends everything, photos
and stocktake, in one go.

### Unattended upload into your own Drive folder

Set this up in the app: **الإعدادات → الرفع إلى Drive**. Paste an OAuth client
id and your folder link (the full share URL is fine — the id is extracted from
it), then **اختبر الاتصال** proves it end to end by creating today's folder.
Both are stored on the device, so changing them needs no redeploy. The screen
shows the exact origin to authorise in Google Cloud.

Uploads land in a dated folder — **10 Sep 2026** — inside the folder you named:
every photo, the **جرد الكميات** workbook, and a `… - الملخّص.csv` manifest
listing each order, its customer and which file it is in, so a shared photo can
still be traced back.

Creating that OAuth client in Google Cloud is the one step that cannot be
removed. Google will not let a page write to your Drive merely because Chrome
is signed in, and a credential shipped inside the app to fake it would be
readable by anyone who opened the page — so that is not something to build. The
share-sheet route above stays available and needs nothing at all.

Photo file names lead with the carrier — `SMSA - 283255858.jpg` — so a folder
sorts by courier at a glance, and the same name is used whether you save to the
phone or upload. The stocktake is named for the day and the batch:
`جرد الكميات - 10 Sep - 44 طلب - 9 منتج.xlsx`.

It needs a Google OAuth client, which only you can create:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → add yourself under *Test users*.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under *Authorised JavaScript origins* add your Vercel URL
   (e.g. `https://lamlem-lite-two.vercel.app`).
5. Paste the client ID into **الإعدادات → الرفع إلى Drive** in the app.

The scope requested is `drive.file`, which lets the app touch **only files it
creates itself** — it cannot read anything already in your Drive. Note that
uploading does send photos of packed boxes, which show customer labels, to
Google.

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
and photo capture need a real device.

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
- **labels-only batch**, against a real 5 Sep SMSA export whose invoice PDF has
  zero text: the app named the cause and offered the labels-only route, which
  produced **35 orders, 35/35 labels, 40 line items, 40/40 matched to a catalog
  product with a photo, nothing flagged**. All 35 tracking barcodes and all 35
  order numbers resolve to the right order, every label read as prepaid (COD 0),
  and جرد الكميات ran on the result — 9 products, 18 components
- **photo mode**, driven through the real UI against a synthetic camera: a group
  session shot boxes into their own JPEGs — `SMSA - 283255858.jpg`, real JPEG
  magic bytes — and a box holding different contents stopped before the shutter.
  Single mode shot one order and returned home; photos survived a reload
- **the camera recovering by itself**: the live track was stopped outright — the
  same thing a screen lock or a phone call does — and the preview went dead.
  Firing `visibilitychange` had the camera re-acquired within seconds (a *new*
  stream, track `live`, frames flowing) with no reload, and the next shot was
  captured through it
- **جرد الكميات** against the real 14 Sep batch: 10 orders, **11/11 line items
  matched to a product with a photo using the built-in list and no file
  uploaded**, exploded into 11 components, with the sales sheet reporting
  865.10 net sales, 129.76 VAT, 162.43 shipping cost and 445.28 net profit —
  each SMSA order charged at the tariff its own label named, three at branch
  rates and two at home rates. Raising the Deliver Now cost from 14 to 20 in
  الإعدادات moved the profit to 427.28, exactly 18 less across its three orders
- **تحميل جميع الصور** saved three photos as three separate files —
  `SMSA - 285590802.jpg`, `DN - 285628027.jpg` — with no archive
- **the share split**: 40 files become four batches of ten with nothing dropped,
  and a set that is few but heavy splits on bytes instead

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
- **The camera stays open for the whole session** rather than being re-acquired
  per scan, which used to leave the preview black for a few hundred
  milliseconds each time. It is released on reset and on leaving the page.
- **Photos live only on that phone**, in IndexedDB, unless you upload them.
  "دفعة جديدة" deletes all of them. The summary shows current usage.
- **A photo is taken at the sensor's photo resolution** where the browser
  supports `ImageCapture`, and falls back to a frame off the live preview
  (which follows the resolution setting) where it does not.
- **Old video clips are deleted** when the app first opens after this version:
  nothing can play them any more, and they were megabytes each.
- **Product photos are hot-linked to Salla's CDN**, so the first view of each
  needs a connection.
- The product list is technically optional, but without it there are no photos
  and no variant repair — the setup screen now reports the photo count so a
  missing or stale file is obvious before you start packing.
