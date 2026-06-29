# FB Group New Posts Crawler

Extension Chrome/Edge (Manifest V3) để crawl **chỉ các bài viết MỚI** từ nhóm Facebook bạn đã tham gia, lưu dữ liệu đầy đủ vào IndexedDB và xuất ra JSON/CSV.

## Cấu trúc repo

```
.                      # Gốc repo = extension Chrome (load unpacked tại đây)
├── manifest.json      # Khai báo MV3
├── src/               # Mã nguồn extension (background, content, popup, dashboard)
├── test/              # Test client của extension (node --test)
└── server/            # Phần web để deploy lên server (TÁCH RIÊNG khỏi extension)
    ├── web/           # Backend Express + MySQL (API /api/*, JWT)
    ├── web-ui/        # Frontend Next.js (dashboard quản trị)
    └── DEPLOY.md      # Hướng dẫn deploy lên server đã chạy sẵn web khác
```

- **Extension** nằm ở thư mục gốc — load unpacked như mục [Cài đặt](#cài-đặt-chế-độ-developer) bên dưới.
- **Web (backend + frontend)** gom trong [`server/`](server/) để push lên VPS độc lập. Xem hướng dẫn deploy tại [`server/DEPLOY.md`](server/DEPLOY.md) và kiến trúc web tại [`server/web/README.md`](server/web/README.md).

## Tính năng

- Crawl **tăng dần**: chỉ lấy bài chưa có trong kho. Tự dừng sớm khi gặp nhiều bài cũ liên tiếp (vì feed sắp theo thời gian, phần sau toàn bài cũ).
- Lưu dữ liệu đầy đủ cho mỗi bài:
  - `postId`, `permalink`
  - `authorName`, `authorProfile`
  - `timestamp` / `timeText` (thời gian đăng)
  - `text` (toàn bộ nội dung, tự bấm "Xem thêm")
  - `images`, `videos`, `links` (link ngoài)
  - `reactions`, `comments` (số lượng, nếu lấy được)
  - `groupId`, `groupName`, `crawledAt`
- Lưu trong **IndexedDB** của extension (không phụ thuộc backend).
- **Xuất JSON / CSV** (CSV có BOM UTF-8 để Excel đọc đúng tiếng Việt).
- Thống kê số bài theo từng nhóm, nút xoá toàn bộ.
- **Selector AI**: dùng AI (API OpenAI-compatible) **một lần** để tự khám phá CSS selector cho từng trường rồi crawl theo selector đó. Khi Facebook đổi giao diện, chỉ cần bấm khám phá lại — không phải sửa code.
- **Bảng quản lý** (mở trong tab mới): quản lý nhóm đã tham gia, crawl theo từng nhóm, xem/lọc/xuất bài viết theo nhóm, và lập lịch **tự động đăng bài / tự động bình luận**.

## Cài đặt (chế độ Developer)

1. Mở `chrome://extensions` (hoặc `edge://extensions`).
2. Bật **Developer mode** (Chế độ nhà phát triển).
3. Bấm **Load unpacked** / **Tải tiện ích đã giải nén** và chọn thư mục dự án này (thư mục chứa `manifest.json`).
4. Ghim extension ra thanh công cụ cho tiện.

## Cách dùng

1. Mở nhóm Facebook trong tab: `https://www.facebook.com/groups/<id-nhóm>`.
2. Extension **tự** chuyển nhóm về chế độ **"Bài viết mới"** (thêm `?sorting_setting=CHRONOLOGICAL` vào URL, có lớp dự phòng bấm UI) để cơ chế "chỉ lấy bài mới" chạy đúng. Bạn không cần đặt thủ công nữa.
3. Bấm vào icon extension để mở popup.
4. Chỉnh tuỳ chọn nếu cần:
   - **Tối đa số bài mới**: dừng khi đã lấy đủ số này.
   - **Dừng sau N bài cũ liên tiếp**: gặp đủ N bài đã biết thì coi như hết bài mới và dừng.
   - **Chờ sau mỗi lần cuộn (ms)**: tăng nếu mạng/máy chậm để feed kịp tải.
5. Bấm **Bắt đầu crawl**. Trang sẽ tự cuộn; popup hiển thị tiến độ.
6. Khi xong, bấm **Xuất JSON** hoặc **Xuất CSV**.

> Lần đầu chạy trên một nhóm sẽ lấy nhiều bài (toàn bộ "đã biết" đang rỗng). Từ lần sau trở đi chỉ lấy phần mới phát sinh.

## Selector AI (crawl theo phần tử)

DOM của Facebook khác nhau tùy tài khoản/phiên bản giao diện và thay đổi thường xuyên. Thay vì hardcode selector, extension có thể nhờ AI **khám phá selector một lần** rồi crawl theo đó một cách xác định và nhanh (AI **không** chạy cho từng bài).

Cách dùng:

1. Mở 1 nhóm Facebook và cuộn tới phần feed (để có ít nhất 1 bài hiển thị).
2. Mở popup, tới mục **Selector AI**:
   - **API Base URL**: `https://danglamgiau.com/v1`
   - **API Key**: khóa của bạn (lưu cục bộ trong `chrome.storage`, gửi kèm header `Authorization: Bearer`).
   - **Model**: ví dụ `gpt-4o`.
3. Bấm **Lưu cấu hình**, rồi **Khám phá selector**.
   - Extension lấy `outerHTML` của 1 bài mẫu (đã cuộn vào tầm nhìn + mở "Xem thêm"), gửi cho AI và yêu cầu trả về JSON các CSS selector cho từng trường (text, tác giả, thời gian, ảnh, video, reaction, comment).
   - Kết quả lưu vào `chrome.storage` và hiển thị trong popup.
4. Từ lần crawl tiếp theo, các trường có selector sẽ được lấy theo selector AI; trường nào AI không tìm được sẽ tự **fallback về heuristic** mặc định nên không bao giờ rỗng nếu DOM có nội dung.

Nút **Xem selector** để xem bộ selector đang lưu, **Xoá selector** để quay về heuristic thuần.

> Lưu ý: việc khám phá selector gửi một phần HTML của trang nhóm tới API AI bạn cấu hình. Chỉ dùng API bạn tin tưởng. API key được lưu cục bộ trong trình duyệt.

## Bảng quản lý (Dashboard)

Mở popup rồi bấm **📊 Mở bảng quản lý** — dashboard hiện ra trong một tab mới (nếu đã mở sẵn thì chuyển về tab đó). Các trang:

- **Tổng quan**: số nhóm, tổng số bài, số job đang chờ/đang chạy; biểu đồ bài theo nhóm.
- **Nhóm**:
  - **Quét nhóm đã tham gia**: mở/duyệt trang nhóm của bạn để lấy danh sách nhóm (id, tên) và lưu lại.
  - Thêm nhóm thủ công bằng id/URL, xoá nhóm.
- **Bài viết**: chọn nhóm để xem danh sách bài đã crawl, lọc theo từ khoá, **Xuất JSON/CSV** theo nhóm, hoặc xoá bài của nhóm.
- **Crawl theo nhóm**: bấm crawl trên một nhóm — extension mở tab nhóm đó, chạy crawl tăng dần (như popup) và báo tiến độ realtime về dashboard.
- **Đăng bài** / **Bình luận**: tạo **job** tự động (đăng bài lên nhóm hoặc bình luận vào một bài), có thể hẹn giờ. Job được xử lý định kỳ qua `chrome.alarms`.

### ⚠️ Cảnh báo rủi ro automation

Tính năng **tự động đăng bài / tự động bình luận** mô phỏng thao tác người dùng trên giao diện Facebook (tìm ô soạn thảo, gõ nội dung, bấm nút). Vì vậy:

- **Rủi ro vi phạm Điều khoản Facebook**: hành vi tự động hoá có thể bị Facebook coi là spam và dẫn tới **hạn chế hoặc khoá tài khoản**. Bạn tự chịu trách nhiệm khi dùng.
- **Dễ hỏng khi Facebook đổi giao diện**: runner bám vào nút/ô soạn thảo theo heuristic; nếu FB đổi layout, job có thể thất bại (trạng thái `error` kèm log).
- **Khuyến nghị**: chạy **số lượng nhỏ**, **giãn thời gian** giữa các job, nội dung tự nhiên, và theo dõi kết quả. Không dùng để spam.

## Kiến trúc

| File | Vai trò |
|------|---------|
| `manifest.json` | Khai báo MV3, quyền (gồm `alarms`), content script, background, popup. |
| `src/db.js` | Lớp IndexedDB **v2**: store `posts` + `groups` + `jobs`. Hàm bài viết (`savePosts`, `getKnownIds`, `getAllPosts`, `getStats`, `clearPosts`), nhóm (`saveGroup(s)`, `getGroups`, `deleteGroup`), job (`createJob`, `updateJob`, `getJobs`, `getDueJobs`, `deleteJob`, `clearFinishedJobs`). |
| `src/background.js` | Service worker — sở hữu IndexedDB, trung gian message; mở dashboard, crawl theo nhóm (mở tab + inject), quét nhóm đã tham gia, runner auto-post/comment qua `executeScript({func})`, xử lý job định kỳ bằng `chrome.alarms`. |
| `src/content.js` | Chạy trên trang nhóm: cuộn feed, bóc tách bài, lọc bài mới, gửi theo lô. |
| `src/popup.html` / `src/popup.js` | Giao diện điều khiển nhanh, hiển thị tiến độ, xuất dữ liệu, nút mở bảng quản lý. |
| `src/dashboard.html` / `src/dashboard.css` / `src/dashboard.js` | Bảng quản lý mở trong tab mới: nhóm, crawl theo nhóm, bài viết, job đăng/bình luận tự động, cấu hình AI. |

Luồng dữ liệu:

```
popup ──START_CRAWL──> background ──START_CRAWL──> content (cuộn + bóc tách)
content ──GET_KNOWN_IDS──> background (trả tập postId đã lưu để lọc bài mới)
content ──SAVE_POSTS──────> background ──> IndexedDB
content ──CRAWL_PROGRESS/DONE──> popup (cập nhật realtime)
popup ──GET_STATS/GET_ALL_POSTS/CLEAR_POSTS──> background ──> IndexedDB

# Khám phá selector (chạy 1 lần):
popup ──DISCOVER_SELECTORS──> background ──GET_SAMPLE_HTML──> content (lấy HTML 1 bài)
background ──POST /v1/chat/completions──> API AI ──> JSON selector ──> chrome.storage
content (lúc crawl) ──loadSelectors()──> chrome.storage (dùng selector, fallback heuristic)
```

## Lưu ý & giới hạn

- **DOM Facebook thay đổi thường xuyên** và class được random hoá. Code bám vào các "mỏ neo" ổn định (`role="article"`, mẫu URL permalink, `scontent`/`fbcdn`...) kèm fallback, nhưng nếu Facebook đổi cấu trúc lớn thì selector trong `src/content.js` có thể cần cập nhật. Các điểm cần chỉnh nằm ở các hàm `extract*`.
- Một số số liệu (reaction/comment) phụ thuộc giao diện hiển thị; có thể `null` nếu không đọc được.
- Extension chỉ crawl những gì **tài khoản của bạn được phép xem** trong nhóm. Hãy tôn trọng [Điều khoản sử dụng của Facebook](https://www.facebook.com/terms) và quy định của từng nhóm; dùng cho mục đích cá nhân/hợp lệ.
- Tốc độ cuộn để mức vừa phải (`scrollDelay`) nhằm tránh tải nặng và giảm rủi ro bị giới hạn.

## Tuỳ biến nhanh

- Đổi tốc độ/giới hạn mặc định: sửa `opts` trong `runCrawl()` của [`src/content.js`](src/content.js:230).
- Thêm/bớt cột CSV: sửa mảng `CSV_COLUMNS` trong [`src/popup.js`](src/popup.js:150).
- Thêm gửi dữ liệu về backend: trong `case "SAVE_POSTS"` của [`src/background.js`](src/background.js:35) gọi thêm `fetch()` tới API của bạn.
