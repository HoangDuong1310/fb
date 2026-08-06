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

## Khuôn GQL là tài nguyên DÙNG CHUNG — đừng nới lỏng bộ lọc

`isGroupFeedRequest` (src/gql-parse.js) quyết định gói GraphQL nào được coi là
"feed nhóm". Gói nào lọt qua sẽ **ghi đè** `apiSniff.template` **và**
`chrome.storage.local.fbcGqlTemplate` — khuôn dùng chung cho MỌI nhóm, MỌI lần
crawl sau. Nhận nhầm một gói là hỏng khuôn trên diện rộng.

Đây không phải rủi ro lý thuyết. Hook chạy ở `document_start` trên **mọi** tab
`facebook.com/groups/*`, nên trong lúc tab crawl chạy mà người dùng lướt Facebook
ở tab khác, mọi request FB tự bắn đều đi qua hook. Điều kiện lỏng ban đầu
(`JSON.stringify(variables)` chứa `"group"` và `"feed"|"stories"`) khớp cả:

| Truy vấn | Vì sao lọt | Hậu quả |
|---|---|---|
| `CometUFICommentsProviderQuery` | `feedback_source: "group_feed"` | replay trả về cây **bình luận** |
| `CometSinglePostContentQuery` | có `groupID` + `feedLocation` | replay trả về **một bài** |

Khuôn feed đang tốt bị ghi đè giữa chừng → trang kế replay bằng `doc_id` sai →
`mapEdgeToPost` nhặt các node trong response đó thành bài `fp:` không permalink.
Đúng triệu chứng **"lướt tab khác thì tab crawl cào về một đống bài rác"**.

Bộ lọc hiện tại theo ba tầng, **thứ tự quan trọng**:

1. **DENY theo friendly name trước** (`comment`, `ufi`, `singlepost`,
   `permalink`, `discussionroot`, `reaction`, `reels`, `story`, `search`…).
   Tầng này thắng mọi luật nhận bên dưới: truy vấn đã tự khai tên là comment thì
   dù `variables` trông giống feed đến đâu cũng không được nhận. Lưu ý `story` có
   ngoại lệ cho `stories` (số nhiều) vì feed thật tên là
   `GroupsCometFeedRegularStoriesPaginationQuery`.
2. **ACCEPT theo friendly name** (`groupsfeed`, `groupscometfeed`…) — đường tin
   cậy nhất, FB đặt tên rất ổn định.
3. **Chỉ khi KHÔNG có friendly name** mới xét `variables`, và xét theo **đúng
   khoá** (`groupID`/`group_id`/`id` + `count`/`cursor`/`after`/`feedType`) chứ
   **không quét chuỗi JSON**. Quét chuỗi chính là lỗ hổng cũ.

Khuôn đã lưu còn được **thẩm định lại lúc đọc** ở cả hai đầu —
`getStoredGqlTemplate` (src/crawl.js) và nhánh SEED trong `runApiCrawl`
(src/content.js) — rồi **xoá nếu không đạt**. Lý do: bản sửa chỉ chặn ghi đè
MỚI; máy nào đã dính khuôn hỏng từ trước sẽ mang nó vĩnh viễn. Thẩm định lúc đọc
buộc bắt lại khuôn sạch một lần rồi mọi thứ trở lại bình thường.

Regression test: `test/gql-feed-guard.test.js`.

## Response feed còn chứa thứ KHÔNG phải bài viết

`mapEdgeToPost` phải qua `looksLikePostNode` / `looksLikeGroupCard` trước khi bóc
tách. FB nhét thẻ nhóm gợi ý, rail "Khám phá", ô mời tham gia vào giữa `edges`.
Các node đó có `name` + `url` nên `looksLikeUser` khớp, và `extractTextFromNode`
nhặt được chuỗi mô tả dài ("Có 3,4K người theo dõi · 40K thành viên · 10+ bài
viết/ngày") — đủ để vượt cửa "có tác giả" rồi thành bài `fp:` rác.

Bài THẬT luôn có ít nhất một trong: `__typename` Story, `creation_time`, khối
`feedback`, hoặc `message.text`. Thẻ gợi ý không có cái nào.

Điểm dễ sai khi sửa: node mang `__typename: "Group"` **không** đương nhiên là thẻ
quảng bá — bài đăng *trong* nhóm cũng tham chiếu tới nhóm. Vì vậy
`looksLikeGroupCard` chỉ loại khi node **đồng thời** không có dấu hiệu bài thật.

## Lưu ý crawl hàng loạt

Dashboard vẫn ở foreground khi tab crawl chạy ngầm => `setTimeout` của hàng đợi
(Tools.tsx `advanceQueue`) KHÔNG bị throttle => crawl chạy hết mọi nhóm thay vì
dừng sau nhóm đầu.
