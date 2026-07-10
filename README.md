# FB Group Radar — Crawler + Trợ lý bán hàng AI

Bộ công cụ cho người bán hàng / chủ shop nhỏ (chủ yếu mảng linh kiện máy tính & đồ công nghệ) tại Việt Nam:

- **Extension Chrome/Edge (Manifest V3)** — crawl **chỉ bài viết MỚI** từ các nhóm Facebook đã tham gia, lọc khách tiềm năng, trích giá thị trường, và để AI soạn nháp tư vấn / trả lời.
- **Backend web (Express + MySQL)** — lưu dữ liệu tập trung theo **từng tài khoản**, phát lệnh điều khiển từ xa, phục vụ trang quản trị.
- **Frontend quản trị (Next.js)** — dashboard đọc dữ liệu và điều khiển.

> **Dữ liệu cá nhân hoá theo từng tài khoản.** Mỗi người dùng chỉ thấy dữ liệu của chính mình (bài, giá group, sản phẩm, nguồn, hồ sơ ngành, từ khoá học). Không còn cơ chế chia sẻ dùng chung.

## Cấu trúc repo

```
.                      # Gốc repo = EXTENSION Chrome (load unpacked tại đây)
├── manifest.json      # Khai báo MV3
├── src/               # Mã nguồn extension (background, content, popup, dashboard)
├── test/              # Test client của extension (node --test)
└── server/            # Phần web deploy lên server — TÁCH RIÊNG (repo riêng, .gitignore)
    ├── web/           # Backend Express + MySQL (API /api/*, JWT, WebSocket)
    ├── web-ui/        # Frontend Next.js (dashboard quản trị)
    └── DEPLOY.md      # Hướng dẫn deploy
```

- **Extension** nằm ở thư mục gốc — load unpacked như mục [Cài đặt](#cài-đặt-chế-độ-developer).
- **Web** gom trong [`server/`](server/) và được đẩy lên **repo server riêng** (không nhúng vào repo extension). Xem [`server/DEPLOY.md`](server/DEPLOY.md).

## Tính năng chính

### Crawl bài viết mới
- Crawl **tăng dần**: chỉ lấy bài chưa có trong kho của bạn. Tự dừng sớm khi gặp nhiều bài cũ liên tiếp.
- Ba cơ chế crawl: cuộn feed trong tab đang mở, crawl theo nhóm (mở tab ẩn), và **crawl qua GraphQL API** của Facebook (nhanh, ít phụ thuộc DOM).
- Tự chuyển nhóm về chế độ **"Bài viết mới"** (`?sorting_setting=CHRONOLOGICAL`) để cơ chế lấy-bài-mới chạy đúng.
- Lưu đầy đủ mỗi bài: `postId`, `permalink`, tác giả, thời gian, nội dung (tự bấm "Xem thêm"), ảnh/video/link, reaction/comment, nhóm.

### Lọc thông minh (không tốn token AI)
- Chấm điểm ngay trên máy để phân loại bài: **cần mua** / **cần hỗ trợ** / **người bán** / **khác**.
- Phân biệt người MUA với người BÁN bằng tín hiệu đối nghịch, tránh gom nhầm.
- Bộ từ khoá gốc + **từ khoá bạn tự thêm/để AI học** (bảng `learned_keywords` riêng theo tài khoản).

### Giá Group
- Trích giá từ bài rao bán trong nhóm bằng **phễu 3 tầng** (lọc thô → chọn bài chưa parse → AI trích một lần cho nhiều bài) kèm **hậu kiểm** chống bịa giá.
- Gom theo sản phẩm, sắp xếp giá thấp → cao để xem mặt bằng giá.

### Tư vấn AI (chỉ tạo nháp)
- AI soạn **nháp** chào giá / hỗ trợ từ bài đã crawl. **Người dùng duyệt thì mới gửi** — không bao giờ tự động bình luận.
- AI **chỉ dùng giá & sản phẩm thật** trong kho của bạn; mọi con số tiền được hậu kiểm, lệch thì gắn cờ cần kiểm tra tay.

### Hội thoại
- Theo dõi **reply của khách** dưới bình luận của bạn (nền, qua `chrome.alarms`), AI soạn nháp trả lời. Bạn duyệt mới đăng.

### Sản phẩm & Kho của tôi
- **Nguồn dữ liệu**: cấu hình các nguồn giá để đồng bộ, có thể tự động theo chu kỳ.
- **Sản phẩm/Giá**: so sánh giá cùng một sản phẩm giữa nhiều cửa hàng.
- **Kho của tôi**: nhập sản phẩm cửa hàng từ Google Sheet công khai và so giá với bên khác.

### Tự động hoá
- **Đăng bài / Bình luận**: tạo job (có thể hẹn giờ), AI xào nội dung thành nhiều biến thể. Job tạo ở trạng thái **chờ duyệt** — không tự chạy cho tới khi bạn duyệt.

### Hồ sơ ngành (prompt profile)
- Tùy biến "giọng" và đặc thù ngành của AI (bán điện thoại, bất động sản, thuê phòng...) mà không cần sửa code. Hồ sơ **lưu riêng theo tài khoản**, một hồ sơ đang kích hoạt là hồ sơ AI dùng.

### Selector AI
- Nhờ AI **khám phá CSS selector một lần** rồi crawl theo đó (AI không chạy cho từng bài). Khi Facebook đổi giao diện, chỉ cần khám phá lại. Trường nào AI không tìm được sẽ **fallback về heuristic**.

### Lệnh từ Web (remote control)
- Extension **poll** server (và nhận **WebSocket push**) để thực thi lệnh điều khiển từ dashboard: đăng bài, bình luận, crawl nhóm, quét nhóm, duyệt tư vấn/hội thoại, xoá bài. Có khử trùng lệnh để không chạy hai lần.

## Cài đặt (chế độ Developer)

1. Sửa backend URL: mở [`src/config.js`](src/config.js) và đặt `BACKEND_BASE_URL` trỏ tới server của bạn. Thêm domain đó vào `host_permissions` trong [`manifest.json`](manifest.json).
2. Mở `chrome://extensions` (hoặc `edge://extensions`).
3. Bật **Developer mode**.
4. Bấm **Load unpacked** và chọn thư mục dự án này (thư mục chứa `manifest.json`).
5. Ghim extension ra thanh công cụ.

## Bắt đầu dùng

1. Bấm icon extension để mở popup, **đăng ký / đăng nhập** tài khoản web (token JWT được service worker giữ; mọi API đi qua service worker).
2. Mở một nhóm Facebook: `https://www.facebook.com/groups/<id-nhóm>`.
3. Trong popup, chỉnh tuỳ chọn crawl nếu cần rồi bấm **Bắt đầu crawl**; hoặc bấm **📊 Mở bảng quản lý** để dùng dashboard đầy đủ.

> Lần đầu chạy trên một nhóm sẽ lấy nhiều bài (kho "đã biết" đang rỗng). Từ lần sau chỉ lấy phần mới phát sinh.

## Bảng quản lý (Dashboard)

Mở trong tab mới, sidebar gom theo nhóm việc:

- **Khám phá** — Tổng quan, Nhóm, Bài viết.
- **Tự động hoá** — Đăng bài, Bình luận, Hội thoại, Tư vấn AI.
- **Giá & Kho** — Giá Group, Sản phẩm/Giá, Kho của tôi, Nguồn dữ liệu.
- **Hệ thống** — Từ khoá học, Hồ sơ ngành, Lệnh từ Web, Cài đặt.

## Kiến trúc

### Extension (thư mục gốc)

| File / thư mục | Vai trò |
|---|---|
| [`manifest.json`](manifest.json) | Khai báo MV3, quyền (`storage`, `tabs`, `scripting`, `alarms`, `declarativeNetRequestWithHostAccess`), content script, background, popup. |
| [`src/config.js`](src/config.js) | **Nơi duy nhất** đổi URL backend khi deploy. |
| [`src/api.js`](src/api.js) | Client HTTP (JWT), lưu/đọc token. |
| [`src/background.js`](src/background.js) | Service worker — trung gian message, mở dashboard, điều phối crawl/job/auth/remote-commands. |
| [`src/content.js`](src/content.js) / [`src/fb-api-hook.js`](src/fb-api-hook.js) | Chạy trên trang nhóm: cuộn feed + bóc tách bài; hook GraphQL để crawl qua API. |
| [`src/crawl.js`](src/crawl.js) | Điều phối crawl (tab/tab ẩn/API), runner đăng bài & bình luận, theo dõi reply, auto-crawl/sync nền. |
| [`src/gql-parse.js`](src/gql-parse.js) | Parse response GraphQL của Facebook thành bài viết. |
| [`src/advisory.js`](src/advisory.js) | Tư vấn AI: phân loại ý định, soạn nháp, hậu kiểm giá. |
| [`src/group-prices.js`](src/group-prices.js) | Trích giá group (phễu 3 tầng + hậu kiểm). |
| [`src/prompts.js`](src/prompts.js) | Hồ sơ ngành + builder system prompt cho AI. |
| [`src/sheets.js`](src/sheets.js) | Nhập "Kho của tôi" từ Google Sheet công khai. |
| [`src/remote-commands.js`](src/remote-commands.js) | Poll + WebSocket, thực thi lệnh điều khiển từ web, khử trùng. |
| [`src/db.js`](src/db.js) | Lớp truy cập dữ liệu qua API backend + job store cục bộ. |
| [`src/popup.html`](src/popup.html) / [`src/popup.js`](src/popup.js) | Popup: đăng nhập, crawl nhanh, xuất dữ liệu, mở dashboard. |
| [`ui/`](ui/) → [`dist/ui/`](dist/ui/) | Dashboard React (Vite). `background.js` mở `dist/ui/index.html`. Views: Feed, Tools, Keywords, Comments, Compose, Messenger, Prices. |
| [`src/dashboard/`](src/dashboard/) | Logic dùng chung phía extension: `leadfilter.js` (phân loại lead), `core.js`, `views/groupprices.js` + `views/products.js` (dùng bởi `lead-classify.js` / `group-prices.js`). |

### Web (thư mục [`server/`](server/) — repo riêng)

| Thư mục | Vai trò |
|---|---|
| [`server/web/`](server/) | Backend Express + MySQL: API `/api/*`, JWT, WebSocket realtime, migration schema (cá nhân hoá theo `user_id`). |
| [`server/web-ui/`](server/) | Frontend Next.js — dashboard quản trị đọc dữ liệu & phát lệnh. |

## Mô hình dữ liệu cá nhân hoá

Mọi bảng dữ liệu đều gắn khoá người dùng để cô lập theo tài khoản:

- `posts` / `comments` / `group_prices`: gắn `crawled_by_user_id` — mỗi người chỉ thấy bài & giá mình crawl.
- `products` / `sources` / `prompt_profiles`: khoá kép `(user_id, id)`; `prompt_profiles.is_active` tính theo từng user.
- `learned_keywords`: unique theo `(user_id, keyword, type)`.

Khi **đăng ký tài khoản mới**, backend tự seed hồ sơ ngành & từ khoá mặc định cho riêng user đó (`seedUserDefaults`).

## Kiểm thử

```bash
# Test client extension (từ thư mục gốc)
node --test "test/**/*.test.js"

# Kiểm tra cú pháp module
node --check src/<file>.js

# Test backend (trong server/web — chạy tuần tự để tránh tranh chấp DB)
cd server/web && npm test          # đã cấu hình --test-concurrency=1
```

## ⚠️ Cảnh báo rủi ro automation

Tính năng **tự động đăng bài / bình luận** mô phỏng thao tác người dùng trên giao diện Facebook:

- **Rủi ro vi phạm Điều khoản Facebook** — có thể bị coi là spam và dẫn tới hạn chế/khoá tài khoản. Bạn tự chịu trách nhiệm.
- **Dễ hỏng khi Facebook đổi giao diện** — runner bám nút/ô soạn theo heuristic; FB đổi layout thì job có thể `error`.
- **Khuyến nghị**: chạy số lượng nhỏ, giãn thời gian giữa các job, nội dung tự nhiên. Không dùng để spam.

## Lưu ý & giới hạn

- **DOM Facebook thay đổi thường xuyên** và class bị random hoá. Code bám các "mỏ neo" ổn định (`role="article"`, mẫu URL permalink, `scontent`/`fbcdn`...) kèm fallback; nếu FB đổi cấu trúc lớn thì các hàm `extract*` trong [`src/content.js`](src/content.js) có thể cần cập nhật.
- Một số số liệu (reaction/comment) phụ thuộc giao diện; có thể `null`.
- Extension chỉ crawl những gì **tài khoản của bạn được phép xem**. Hãy tôn trọng [Điều khoản Facebook](https://www.facebook.com/terms) và quy định từng nhóm; dùng cho mục đích cá nhân/hợp lệ.
- Selector AI gửi một phần HTML trang nhóm tới API AI bạn cấu hình — chỉ dùng API bạn tin tưởng. API key lưu cục bộ trong trình duyệt.

## Bảo mật

- Backend dùng **JWT**; token do service worker giữ, không lộ ra content script.
- API AI (base URL / key / model) lưu cục bộ trong `chrome.storage`, gửi kèm header `Authorization: Bearer`.
- Dữ liệu tách bạch theo `user_id` ở tầng DB — không rò rỉ chéo giữa các tài khoản.
