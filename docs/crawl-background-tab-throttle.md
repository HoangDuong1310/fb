# Crawl ở tab NỀN — gốc rễ throttle & cách seed khuôn từ storage

Ghi chú kiến trúc quan trọng cho phần thu thập (crawl) nhóm Facebook. Đọc file
này trước khi động vào `runApiCrawl` (src/content.js) hoặc `crawlGroupApiSmart`
(src/crawl.js).

## Triệu chứng

Khi tắt "Focus tab khi chạy nhiệm vụ", extension mở tab nhóm ở chế độ NỀN
(`active:false`). Trước khi sửa: **để yên tab nền thì KHÔNG cào được, phải bấm
vào tab đó nó mới bắt đầu cào**.

## Gốc rễ (ROOT CAUSE)

Chrome (MV3) **đóng băng** các cơ chế phụ thuộc render ở tab KHÔNG focus:

- `requestAnimationFrame` — dừng hẳn.
- `IntersectionObserver` — không bắn callback (đây chính là cơ chế lazy-load
  feed của Facebook).
- `setTimeout` / `setInterval` — bị kẹp về ~1 lần/giây.

FB chỉ bắn request GraphQL feed KHI lazy-load kích hoạt (người dùng/observer
cuộn tới). Ở tab nền lazy-load bị băng => **FB không bao giờ tự phát request
feed** => bước "sniff lại từ đầu" của `runApiCrawl` treo mãi tới khi ta bấm vào
tab (lúc đó tab thành foreground, rAF/observer chạy lại).

**Điểm mấu chốt:** `fetch` KHÔNG bị Chrome throttle ở tab nền. Chỉ cơ chế
render/lazy-load bị băng. => Nếu ta có sẵn KHUÔN request (doc_id + body + token)
thì replay bằng `fetch` vẫn chạy đủ ở tab nền, không cần lazy-load.

## Cách sửa: SEED khuôn từ storage (không DNR — giữ TIER-2 an toàn)

Trong `runApiCrawl` (src/content.js), việc lấy khuôn đi theo 3 nguồn ưu tiên:

1. **(a) Kéo gói đệm từ hook** — `pullBufferedGql()` + chờ NGẮN (~3s, KHÔNG
   cuộn). Hook chạy `document_start` nên có thể đã đệm sẵn gói feed đầu. Nguồn
   tốt nhất vì kèm `lastChunks` (trang 1 khỏi gọi mạng) + token tươi. Việc pull
   tự phát lại nên không phụ thuộc lazy-load => tab nền vẫn nhận được.

2. **(b) SEED từ `chrome.storage.local.fbcGqlTemplate`** — MẤU CHỐT cho tab nền.
   Dùng lại khuôn đã lưu từ lần crawl trước; chỉ **làm mới `fb_dtsg`/`lsd`** từ
   `document.documentElement.outerHTML` (DOM vẫn có sẵn dù tab nền, chỉ lazy-load
   bị băng), rồi ghi token tươi vào body `raw` qua `URLSearchParams`. Regex trích
   token giống `extractTokensFromHtml` (src/crawl.js). Không có `lastChunks` tươi
   => TRANG 1 phải replay như các trang sau.

3. **(c) Sniff trực tiếp** (cuộn + click "Mới nhất") — CHỈ chạy được khi tab
   focus. Là phương án CHÓT cho lần crawl ĐẦU TIÊN khi storage còn trống. Ở tab
   nền vòng này sẽ treo hết thời gian do lazy-load bị băng.

Sau khi có khuôn, mọi trang (kể cả trang 1 khi seed) replay qua
`replayViaPage` — chạy fetch trong MAIN world (`origFetch.call(window, ...)`),
**header do trình duyệt tự đặt** => KHÔNG spoof Origin/Referer/sec-fetch, KHÔNG
dùng DNR. Đây là điểm giữ an toàn TIER-2.

## Vì sao lần crawl ĐẦU vẫn cần 1 tab foreground

Storage trống => chưa có khuôn để seed => phải để FB lazy-load feed 1 lần cho
hook bắt khuôn. Tab nền bị băng lazy-load nên không làm được. Do đó
`crawlGroupApiSmart` buộc mở **1 tab foreground DUY NHẤT 1 lần** (khi focus TẮT
mà chưa có khuôn). Có khuôn rồi thì các lần/nhóm sau tự chuyển sang tab nền.

## Ba TIER crawl & mức an toàn

| Tier | Hàm | Cơ chế | Header | Rủi ro |
|------|-----|--------|--------|--------|
| TIER-2 | `crawlGroupApiInTab` → `runApiCrawl` | replay TRONG trang, MAIN-world fetch | trình duyệt tự đặt | THẤP NHẤT (mặc định) |
| TIER-3 | `crawlGroupApiTabless` | service-worker fetch + DNR `ensureFbGqlHeaderRule` | extension dựng lại (ghi đè Origin/Referer/...) | Cao hơn — chỉ khi `preferTabless=true` |

**Không đổi header liên tục + dùng cookie ở TIER-2** vì fetch chạy ngay trong
trang FB, header sinh ra y như FB tự gọi. Chỉ TIER-3 (tabless) mới dựng lại
header thủ công qua DNR — đó là lý do TIER-3 rủi ro hơn và không dùng mặc định.

## Lưu ý crawl hàng loạt

Dashboard vẫn ở foreground khi tab crawl chạy ngầm => `setTimeout` của hàng đợi
(Tools.tsx `advanceQueue`) KHÔNG bị throttle => crawl chạy hết mọi nhóm thay vì
dừng sau nhóm đầu.
