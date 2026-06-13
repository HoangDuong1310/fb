# Thiết kế: Web backend MySQL + Giá Group + Đăng nhập đa người dùng

Ngày: 2026-06-13
Trạng thái: Đã chốt (chờ user review trước khi viết plan)

## 1. Mục tiêu

Nâng cấp lớn cho extension "FB Group New Posts Crawler" với ba khối tính năng:

1. **Giá Group**: trích dữ liệu giá sản phẩm của người bán lẻ trong nhóm Facebook
   từ chính các bài đã crawl. Người bán lẻ thường rẻ hơn cửa hàng, nên đây là
   nguồn so giá quý cho AI tư vấn.
2. **Web backend MySQL**: chuyển kho dữ liệu từ IndexedDB sang một backend
   Node.js + Express + MySQL làm nguồn chân lý duy nhất (single source of truth).
3. **Đăng nhập đa người dùng**: email/mật khẩu, mỗi user có danh tính riêng;
   dữ liệu chia sẻ chung trong nhóm tài khoản nhưng có phân quyền chia sẻ theo
   từng phần và ghi nhận attribution (ai crawl, ai comment).

## 2. Quyết định kiến trúc

**Chọn Option B**: Extension trở thành client mỏng gọi trực tiếp API MySQL,
**bỏ IndexedDB**. Lý do người dùng chọn: một nguồn chân lý duy nhất, không cần
logic đồng bộ hai chiều, không lo dữ liệu lệch (staleness).

Điều chỉnh an toàn: việc crawl vẫn chạy trên DOM trình duyệt (không phụ thuộc
mạng tới backend); chỉ phần đọc/ghi kho dữ liệu là đi qua API. Giữ một cache nhỏ
trong `chrome.storage.session` cho tập "post ID đã biết" để crawl tăng dần vẫn
nhanh, không gọi API mỗi lần cuộn feed.

### Ba thành phần

1. **`web/` — Node.js + Express + MySQL** (thư mục mới, nguồn chân lý)
   - Auth: email/mật khẩu → JWT. Endpoint `/api/auth/*`.
   - Data API: posts, group-prices, comments/conversations, advisories, products,
     sources, learned-keywords — tất cả dưới `/api/*`, mỗi bản ghi gắn attribution
     theo `userId`.
   - Truy cập MySQL qua `mysql2` connection pool; schema tạo bằng script migration
     chạy lúc khởi động.

2. **Extension (client mỏng)**
   - `src/db.js` được viết lại từ lớp IndexedDB thành **API client** GIỮ NGUYÊN
     tên hàm (`savePosts`, `getAllPosts`, `getKnownIds`, ...) để `crawl.js`,
     `advisory.js`, và các view dashboard gọi y như cũ. Cô lập việc viết lại vào
     đúng một file.
   - `background.js` giữ JWT (từ `chrome.storage.local`), đính vào mọi request.
   - Cache nhỏ tập post ID đã biết trong session để crawl tăng dần vẫn nhanh.

3. **Đăng nhập trong popup**
   - `popup.html` / `popup.js` thêm form email/mật khẩu → gọi `/api/auth/login`
     → lưu JWT. Trạng thái chưa đăng nhập thì ẩn các nút crawl.

**Nguyên tắc dẫn đường**: giữ nguyên chữ ký các hàm public mà `db.js` phơi ra,
để phần còn lại của extension gần như không đổi — chỉ thay phần lưu trữ phía sau
từ IndexedDB sang HTTP.

## 3. Mô hình dữ liệu MySQL

Pool chung có phân quyền chia sẻ + ghi nhận attribution. Các bảng:

- **`users`** — `id`, `email` (unique), `password_hash` (bcrypt), `display_name`,
  `created_at`.
- **`user_share_prefs`** — `user_id`, `share_crawled_default` (BOOL),
  `share_commented_default` (BOOL), `share_group_prices_default` (BOOL). Công tắc
  tổng. **Mặc định cả ba = TRUE** khi tạo user (chia sẻ tất cả, ai không muốn tự tắt).
- **`posts`** — `post_id` (PK, id FB), `group_id`, `group_name`, `author_name`,
  `author_profile`, `text`, `images` (JSON), `timestamp`, `permalink`,
  `crawled_by_user_id` (FK→users), `crawled_at`, `updated_at`,
  `share_crawled` (BOOL, kế thừa default). Pool chung; `crawled_by` ghi ai mang
  bài về đầu tiên.
- **`groups`** — `group_id` (PK), `group_name`, attribution + timestamps.
- **`comments`** — `id`, `post_id` (FK), `user_id` (ai comment), `content`,
  `commented_at`, `share_commented` (BOOL). Là chìa khóa cho quy tắc "né trùng":
  trước khi AI soạn nháp, tải tất cả comment của bài để prompt tránh lặp.
- **`conversations`** — `post_id`, `user_id`, permalink comment của ta,
  `replies` (JSON), `status`, timestamps.
- **`advisories`** — keyed theo cặp `(post_id, user_id)`, nội dung nháp, `status`,
  `used_products` (JSON), các cờ (`needs_human_check`, `check_note`). Hai user có
  thể mỗi người một nháp riêng cho cùng một bài.
- **`products`** — catalog bán lẻ (HACOM/Hura), `product_id` (PK), giữ nguyên các
  trường hiện tại. Dùng chung, không scope theo user.
- **`group_prices`** — tính năng mới: `id`, `post_id` (FK, bài nguồn), `name`,
  `price`, `condition`, `warranty`, `category`, `seller_name`, `seller_profile`,
  `group_id`, `posted_at`, `parsed_at`, `parser` (ai/regex), `confidence`,
  `crawled_by_user_id` (FK→users), `share_group_prices` (BOOL, kế thừa default).
  Một bài có thể sinh nhiều dòng. Cờ chia sẻ khớp công tắc tổng
  `share_group_prices_default`.
- **`sources`** — cấu hình nguồn (giữ shape hiện tại).
- **`learned_keywords`** — cửa lọc tự học: `id`, `keyword`, `type`
  (sell_signal/condition/unit), `added_by` (ai/user), `enabled`, `created_at`.
  Dashboard đọc/sửa; bộ lọc regex nạp các dòng `enabled`.

**Ghi chú thiết kế**: `post_id` là PK tự nhiên nên bất kỳ ai re-crawl cũng upsert
chứ không nhân bản; attribution nằm ở cột/bảng phụ riêng thay vì tách dữ liệu
theo từng user.

## 4. Phễu trích giá Group + vòng lặp tự học

Ba tầng lọc dần để AI chỉ phải đọc phần thực sự đáng đọc (không gửi cả 10k bài
cho LLM):

**Tầng 1 — Lọc rẻ tại chỗ (không AI, chạy trên toàn bộ bài):**
Một bài qua cửa chỉ khi có ĐỒNG THỜI: (a) mẫu số tiền — tái dùng
`extractMoneyFigures` sẵn có ("4tr5", "4.500.000", "4500k"); và (b) một tín hiệu
BÁN nạp từ `learned_keywords` (enabled): "bán", "pass", "thanh lý", "ib giá",
"fix nhẹ"... Bài hỏi/mua bị loại sớm. 10k bài thường còn vài trăm.

**Tầng 2 — Khử trùng + tăng dần:**
Chỉ bài MỚI (theo `post_id`, chưa có `parsed_at`) mới lên AI. Parse xong đánh dấu
`parsed_at` → không gửi lại. Sau lần đầu, mỗi lần crawl chỉ còn vài bài mới.

**Tầng 3 — AI trích + hậu kiểm + tự học:**
- Gom ~10–15 bài/lần gọi (batch, không từng-bài-một); AI trả mỗi bài một danh sách
  `{name, price, condition, warranty, category}`.
- **Hậu kiểm regex**: mọi giá AI trả phải thực sự xuất hiện trong text bài đó —
  không khớp thì loại (đúng triết lý chống bịa của `advisory.js`).
- **Tự học**: cùng lần gọi, AI trả thêm `new_keywords` — từ/lóng báo hiệu BÁN nó
  thấy nhưng chưa có trong từ điển. Ghi vào `learned_keywords` với `added_by='ai'`,
  `enabled=true` → Tầng 1 lần sau thông minh hơn. Dashboard hiện danh sách để
  tắt/xóa từ sai.

**Cốt lõi**: AI KHÔNG sinh regex; regex là cửa lọc tất định. AI chỉ (1) trích cấu
trúc và (2) đề xuất từ khóa mới để nuôi cửa lọc — giống con người gặp lóng mới
thì nhớ thêm.

## 5. AI né nội dung đã comment, gen góc khác

Luồng khi soạn nháp cho một bài:

1. **Tải ngữ cảnh comment đã có** — API trả tất cả bản ghi `comments` của bài đó
   (nội dung + ai viết), kèm cờ chia sẻ. Đây là "danh sách cần né".
2. **Đưa vào prompt với ràng buộc né** — `draftAdvisory` trong `advisory.js` thêm
   khối: "Các bình luận ĐÃ TỒN TẠI dưới bài này: [...]. Hãy viết góc tiếp cận
   KHÁC: nếu người trước chào giá, bạn nhấn bảo hành/giao hàng; nếu người trước
   nói kỹ thuật, bạn chào sản phẩm cụ thể. KHÔNG lặp ý, câu chữ, hay cùng sản phẩm
   đã nhắc."
3. **Hậu kiểm trùng lặp** — so khớp tương đồng (chuẩn hóa chữ thường + n-gram đơn
   giản) với comment cũ. Giống quá ngưỡng → gắn `needs_human_check` + ghi chú
   "trùng ý với bình luận đã có".
4. **Khóa chống trùng theo `(post_id, user_id)`** — mỗi user một nháp/bài; nếu tôi
   đã comment bài đó (`conversations` có bản ghi), mặc định không soạn lại trừ khi
   tôi chủ động yêu cầu "viết thêm góc khác".

**Cốt lõi**: né trùng dựa trên dữ liệu comment THẬT trong DB (cả của mình lẫn của
người chia sẻ), không đoán.

## 6. Xác thực & phiên đăng nhập

- **Đăng ký/đăng nhập**: form email + mật khẩu trong `popup.html`. Mật khẩu băm
  bcrypt ở server (không lưu thô).
- **Cấp token**: `POST /api/auth/login` trả JWT hạn **30 ngày**. Extension lưu vào
  `chrome.storage.local`.
- **Gắn token**: `background.js` đọc token, đính `Authorization: Bearer <jwt>` vào
  mọi request. Server có middleware xác thực, gắn `req.userId` cho mọi route dữ liệu.
- **Hết hạn**: bất kỳ response 401 → extension xóa token, phát thông báo, popup
  hiện lại form đăng nhập. Không dán token thủ công.
- **Đăng xuất**: nút trong popup/dashboard xóa token local.

## 7. UI/UX

Theo đúng pattern thẻ-card hiện có của dashboard.

**a) View "Giá Group" (mới)** — song song view "Sản phẩm/Giá":
- Mỗi dòng: tên, **giá** (in đậm), tình trạng (mới/cũ/likenew), bảo hành, người
  bán, nhóm, thời gian đăng, link về bài gốc.
- Gom theo sản phẩm: nhiều người bán cùng món → gộp nhóm, hiện khoảng giá
  thấp–cao để so nhanh với giá lẻ cửa hàng.
- Bộ lọc: theo nhóm, danh mục, khoảng giá, tình trạng, và công tắc
  **"Tất cả (chung) / Chỉ của tôi"**.
- Mỗi thẻ có icon chia sẻ 🌐/🔒 bấm nhanh.

**b) View "Từ khóa học" (mới)** — quản lý `learned_keywords`:
- Cột: từ, loại (tín hiệu bán/tình trạng/đơn vị), nguồn (AI/tôi), công tắc
  bật/tắt, nút xóa.
- Badge "mới do AI thêm" để soát từ rác. Ô thêm từ thủ công.

**c) Trang "Cài đặt chia sẻ"** — 3 công tắc tổng (crawl / comment / group-price),
kèm giải thích ngắn mỗi cái.

**d) Đăng nhập** — màn login trong popup; chưa đăng nhập thì dashboard hiện trạng
thái "Cần đăng nhập" thay vì dữ liệu trống gây hiểu nhầm.

**e) Dấu hiệu attribution** — thẻ bài/comment hiện "bạn crawl" hoặc
"do <tên> chia sẻ", và nhãn "bạn đã comment".

## 8. Quy tắc lọc chia sẻ (tầng API)

Mọi truy vấn đọc dữ liệu chung trả về: bản ghi của **chính tôi** (luôn thấy) +
bản ghi của người khác **có cờ share = true**. Tắt chia sẻ → bài biến mất khỏi
view người khác ngay, nhưng chủ vẫn thấy và dữ liệu không bị xóa. Lọc thực hiện
ở tầng API, không ở client.

## 9. Cấu hình

- `DATABASE_URL="mysql://root:@localhost:3306/<db>"` (env local).
- `JWT_SECRET`, `JWT_EXPIRES=30d` trong env.
- File `web/.env.example` mô tả các biến.

## 10. Phạm vi loại trừ (YAGNI)

- Không làm refresh token (token 30 ngày + login lại khi 401 là đủ).
- Không làm role/permission phức tạp (chỉ user thường + cờ chia sẻ).
- Không làm realtime websocket (poll/refresh thủ công đủ dùng).
- Không migrate dữ liệu IndexedDB cũ (bắt đầu sạch trên web backend).
