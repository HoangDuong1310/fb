# Rà soát tính năng “Nuôi tài khoản” và kế hoạch cải thiện hành vi tự nhiên

## 1. Mục tiêu tài liệu

Tài liệu này rà soát phần “Nuôi tài khoản” hiện có và ghi lại:

- Những điểm đang làm tốt.
- Những điểm cần **cải thiện**, không đề xuất loại bỏ tính năng.
- Các bug hoặc rủi ro kỹ thuật cần sửa.
- Thứ tự ưu tiên triển khai và tiêu chí nghiệm thu.

Phạm vi chính:

- `src/crawl.js`: cấu hình, lịch chạy, chọn hành động, điều hướng và thao tác trong trang.
- `src/background.js`: message handler và alarm.
- `src/db.js`: cấu hình và nhật ký lưu trên server.
- `ui/src/views/Tools.tsx`: giao diện cấu hình, chạy thủ công và nhật ký.
- `manifest.json`: quyền và phạm vi trang mà extension có thể thao tác.

> Nguyên tắc: “giống người hơn” nên được hiểu là hành vi có ngữ cảnh, có giới hạn, có nhịp nghỉ và có xác minh kết quả; không chỉ thêm `Math.random()` hoặc phát sự kiện chuột giả.

---

## 2. Tổng quan luồng hiện tại

### 2.1. Cấu hình

Cấu hình hiện có:

- Bật/tắt tự động.
- Chu kỳ 15–1440 phút.
- Số việc tối đa mỗi lượt 1–8.
- Các hành động:
  - Cuộn bảng tin.
  - Xem video.
  - Mở thông báo.
  - Lướt feed nhóm.
  - Lướt Reels.
  - Thả cảm xúc bài viết.
  - Thả cảm xúc Reels.

Cấu hình được lưu bằng key `warmingConfig` qua API settings theo tài khoản.

### 2.2. Lập lịch

- Dùng alarm một lần thay vì alarm lặp cố định.
- Mỗi lần có jitter ±40%.
- Có khung nghỉ cố định 00:00–06:00 theo giờ máy.
- Sau khi alarm chạy xong sẽ tự đặt lịch lượt tiếp theo.

### 2.3. Thực hiện

- Kiểm tra kill-switch trước khi bắt đầu.
- Ưu tiên dùng một tab Facebook đang mở; nếu không có thì mở tab mới.
- Dùng một tab cho toàn bộ lượt.
- Thử điều hướng mềm trong SPA, thất bại thì đổi URL trực tiếp.
- Chạy các hàm thao tác trong trang bằng `chrome.scripting.executeScript`.
- Ghi log từng hành động lên server.

### 2.4. Các điểm tốt nên giữ

1. Mặc định tắt tính năng.
2. Các hành động ghi không được bật mặc định.
3. Có kill-switch khi gặp checkpoint/login.
4. Có jitter giữa các lượt và giữa các hành động.
5. Có khung giờ nghỉ.
6. Chống chạy chồng bằng cờ `_warming`.
7. Có nút dừng và giấc ngủ có thể ngắt.
8. Chỉ đóng tab do extension tự mở.
9. Có nhật ký hoạt động trên server.
10. Một loại hành động không bị lặp nhiều lần trong cùng kế hoạch.

---

## 3. Các bug cần sửa

## P0 — Cần sửa trước khi mở rộng hành vi

### BUG-01 — UI có thể lưu danh sách hành động cũ do state React bị stale

**Vị trí:** `ui/src/views/Tools.tsx`, phần checkbox hành động.

Luồng hiện tại:

1. `onChange` gọi `toggleAction(a.id)` để cập nhật state bất đồng bộ.
2. `onBlur` gọi `save({ actions: config.actions })`.
3. `config.actions` trong closure có thể vẫn là giá trị trước khi toggle.

**Hậu quả:**

- Checkbox nhìn như đã đổi nhưng server có thể nhận danh sách cũ.
- Lần bật/tắt tiếp theo có thể ghi đè sai.
- Cấu hình sau khi reload không khớp giao diện trước đó.

**Cải thiện:**

- Tính `nextActions` ngay trong handler và truyền trực tiếp vào `save`.
- Không dùng `onBlur` để lưu checkbox.
- Có thể debounce nếu cần, nhưng payload phải lấy từ giá trị mới vừa tính.

**Tiêu chí nghiệm thu:**

- Bật hoặc tắt một checkbox rồi reload UI vẫn giữ đúng trạng thái.
- Bật/tắt liên tục nhiều mục không làm mất thay đổi trước đó.

---

### BUG-02 — Số `done` tăng cả khi hành động lỗi

**Vị trí:** `src/crawl.js`, trong vòng lặp `processWarming`.

Hiện tại `done += 1` chạy trước khi phân biệt `res.ok`.

**Hậu quả:**

- UI báo “Xong N hành động” dù một hoặc nhiều hành động lỗi.
- Log và kết quả tổng không nhất quán.
- Không thể đánh giá chất lượng thực thi.

**Cải thiện:**

Tách bộ đếm:

- `attempted`: đã thử.
- `succeeded`: thực sự thành công.
- `failed`: lỗi.
- `skipped`: không có đối tượng phù hợp hoặc bỏ qua theo chính sách.

Kết quả trả về nên có đủ bốn số này; giữ `done` để tương thích nhưng ánh xạ sang `succeeded`.

---

### BUG-03 — Nuốt exception toàn lượt rồi vẫn có thể trả `ok: true`

**Vị trí:** `src/crawl.js`, `catch` ngoài của `processWarming`.

Khối `catch` hiện bỏ qua lỗi hoàn toàn. Sau đó hàm trả `{ ok: true, done, blocked, stopped }`.

**Hậu quả:**

- Lỗi mở tab, lỗi API, lỗi scripting hoặc lỗi dữ liệu có thể bị che mất.
- UI hiển thị lượt chạy thành công hoặc “xong 0 hành động”.
- Không có log để chẩn đoán.

**Cải thiện:**

- Lưu `sessionError`.
- Ghi log `type: "session", status: "error"` cùng mã lỗi đã chuẩn hóa.
- Trả `ok: false` khi lỗi hạ tầng khiến cả lượt không thể tiếp tục.
- Không đưa stack trace hoặc dữ liệu nhạy cảm lên UI.

---

### BUG-04 — Có thể chạy trên sai tài khoản Facebook đang đăng nhập

**Vị trí:** luồng `acquireWarmingTab`/`processWarming` trong `src/crawl.js`.

Module đã import các hàm kiểm tra binding tài khoản, nhưng luồng warming chưa xác minh Facebook ID hiện tại có khớp tài khoản đã liên kết hay không.

**Hậu quả:**

- Nếu trình duyệt đổi nick Facebook, hệ thống vẫn thao tác trên nick đang mở.
- Cấu hình và nhật ký server thuộc tài khoản A nhưng hoạt động thực tế xảy ra trên Facebook B.

**Cải thiện:**

- Trước hành động đầu tiên, đọc Facebook ID hiện tại từ tab.
- So sánh với binding đã lưu.
- Nếu mismatch: dừng sạch, ghi log `blocked` hoặc `identity_mismatch`, không thao tác.
- Hiển thị rõ tài khoản dự kiến và tài khoản thực tế.

---

### BUG-05 — Race khi service worker vừa khởi động nhưng token chưa được nạp

**Vị trí:** các handler `GET_WARMING_CONFIG`, `SET_WARMING_CONFIG`, `WARMING_RUN_NOW`, `GET_WARMING_ACTIVITY` trong `src/background.js`.

Các handler warming không `await readyPromise` trước khi gọi DB/API. Trong khi đó `DB.getSetting` nuốt lỗi và trả mặc định.

**Hậu quả:**

- Khi service worker vừa thức dậy, cấu hình có thể bị đọc thành mặc định/tắt dù server đã bật.
- Chạy tay có thể dùng cấu hình sai.
- Ghi log có thể lỗi im lặng do token chưa sẵn sàng.

**Cải thiện:**

- Bọc các handler warming trong async IIFE và `await readyPromise`.
- Alarm warming cũng cần chờ `readyPromise` trước `processWarming`.
- Phân biệt “không có cấu hình” và “không đọc được cấu hình”. Không dùng cùng một fallback im lặng cho cả hai trường hợp.

---

### BUG-06 — Hành động click có thể báo thành công dù Facebook không nhận click

**Vị trí:** `runReactPostInPage`, `runReactReelsInPage`, `warmingSoftNavigateInPage` trong `src/crawl.js`.

Code dùng `dispatchEvent` để tạo chuỗi mouse event rồi mặc định trả `reacted: true` hoặc `navigated: true` mà không xác minh trạng thái sau thao tác.

Sự kiện tạo từ script có `isTrusted = false`; tùy cấu trúc React/Facebook, sự kiện có thể không kích hoạt hành động thật hoặc kích hoạt không ổn định.

**Hậu quả:**

- Log ghi “Xong” nhưng reaction không được tạo.
- Điều hướng mềm được coi là thành công nhưng trang vẫn ở mục cũ.
- Hành động sau chạy sai ngữ cảnh.

**Cải thiện:**

- Ưu tiên `HTMLElement.click()` trên phần tử đã xác định rõ.
- Sau click reaction, chờ và xác minh `aria-pressed`, nhãn hoặc DOM feedback đã đổi.
- Sau điều hướng, xác minh URL hoặc landmark của trang đích.
- Nếu không xác minh được, trả `ok: false` hoặc `status: "unverified"`; không ghi “done”.

---

### BUG-07 — Xem video báo `watchedMs` dù video không phát

**Vị trí:** `runWatchVideoInPage` trong `src/crawl.js`.

`play()` bị catch rỗng, sau đó hàm vẫn ngủ 5–15 giây và trả `watchedMs` như thành công.

**Hậu quả:**

- Video bị autoplay policy chặn nhưng log vẫn báo đã xem.
- Không phân biệt “đứng trên trang video” với “video thực sự chạy”.

**Cải thiện:**

- Ghi `currentTime` trước và sau.
- Kiểm tra `paused`, `readyState`, `ended` và delta `currentTime`.
- Nếu không tiến thời gian, trả `played: false`, `note: "play-blocked"`.
- Chỉ tính thời gian xem thực tế bằng delta video, không dùng riêng thời gian sleep.

---

### BUG-08 — Xóa kill-switch có thể ghi đè trạng thái block mới từ tác vụ khác

**Vị trí:** cuối `processWarming` trong `src/crawl.js`.

Sau một lượt warming sạch, code gọi `clearCrawlBlock()`. Trong thời gian warming chạy, một tác vụ khác có thể vừa đặt block mới.

**Hậu quả:**

- Warming vô tình xóa cảnh báo/checkpoint do crawl, inbox hoặc watch vừa phát hiện.
- Các tác vụ tự động khác có thể chạy lại quá sớm.

**Cải thiện:**

- Không tự động xóa shared kill-switch chỉ vì warming thành công.
- Nếu cần phục hồi, dùng token/version của block: chỉ xóa trạng thái mà chính lượt này đã sở hữu hoặc đã quan sát trước đó.
- Tốt hơn: kill-switch chỉ được xóa khi hết hạn hoặc qua một health-check riêng có xác minh.

---

### BUG-09 — “Chạy ngay một lượt” bỏ qua giới hạn `actionsPerRun`

**Vị trí:** phần dựng `plan` trong `processWarming`.

Ở chế độ manual, `readCap = readonlyPool.length`, nên UI gửi `actionsPerRun` nhưng backend bỏ qua giới hạn này và chạy toàn bộ hành động read-only đã bật. Các hành động ghi cũng bị buộc chạy nếu đã bật.

**Hậu quả:**

- Hành vi khác với nhãn “Số việc tối đa mỗi lượt”.
- Người dùng nghĩ chạy thử 1–2 việc nhưng có thể chạy 5–7 việc.
- Hành động ghi có xác suất 30% ở tự động nhưng thành 100% khi bấm chạy tay.

**Cải thiện:**

- Tôn trọng `actionsPerRun` cho cả manual và auto.
- Nếu cần chế độ “test tất cả”, tạo nút hoặc option riêng với cảnh báo rõ.
- Manual không nên tự động biến xác suất reaction thành 100%; nên có nút test riêng cho từng action.

---

### BUG-10 — Comment và implementation mâu thuẫn về số hành động mỗi lượt

**Vị trí:** mô tả `WARMING_DEFAULT` và JSDoc `processWarming` so với code dựng `plan`.

Comment nói mỗi lượt bốc ngẫu nhiên từ `1..N`, nhưng implementation tự động luôn lấy `min(perRun, readonlyPool.length)`.

**Hậu quả:**

- Nhịp hoạt động đều hơn dự kiến.
- Tài liệu nội bộ gây hiểu nhầm khi bảo trì.

**Cải thiện:**

- Chọn ngẫu nhiên `targetCount` trong khoảng hợp lý, ví dụ `1..min(perRun, pool.length)`.
- Có trọng số theo lịch sử để không liên tục chọn cùng một số lượng.
- Cập nhật comment và UI cho đúng hành vi thực tế.

---

### BUG-11 — Điều hướng và cuộn làm thay đổi tab người dùng đang sử dụng

**Vị trí:** `acquireWarmingTab` ưu tiên bất kỳ tab Facebook đang mở và `releaseWarmingTab` giữ nguyên tab đó.

**Hậu quả:**

- Extension có thể lấy đúng tab người dùng đang đọc/dang soạn, điều hướng sang Watch/Reels/Notifications và làm mất vị trí.
- Sau lượt chạy, tab không được khôi phục URL và scroll position.
- Đây không giống hành vi tự nhiên của chính người dùng; đây là hành vi giành quyền điều khiển phiên đang làm việc.

**Cải thiện:**

- Không dùng tab Facebook đang active hoặc tab có form đang focus.
- Ưu tiên tab warming chuyên dụng do extension sở hữu.
- Nếu tái sử dụng tab người dùng, lưu URL, history state và scroll position; khôi phục sau lượt.
- Có setting rõ: “Dùng tab riêng” là mặc định; “Cho phép dùng tab đang mở” là tùy chọn.

---

### BUG-12 — Tab nền có thể bị Chrome throttle làm hành động không thực thi đúng

**Vị trí:** `acquireWarmingTab` mở tab theo `focusTabs`, mặc định `active: false`; các action dùng smooth scroll, video và DOM lazy-loading.

**Hậu quả:**

- Feed/Reels/video ở tab nền có thể không render hoặc không phát như kỳ vọng.
- Hành động trả kết quả nhưng trang thực tế không thay đổi đáng kể.

**Cải thiện:**

- Thêm kiểm tra sau action: scroll delta, số item mới, video currentTime, URL/landmark.
- Nếu tab bị discard/frozen/hidden và action không có tiến triển, trả `deferred` thay vì “done”.
- Không tự động focus cửa sổ người dùng; có thể chờ tới khi có tab Facebook phù hợp đang foreground hoặc dùng chế độ activity nhẹ không phụ thuộc rendering.

---

## P1 — Rủi ro logic và độ tin cậy

### BUG-13 — Chọn tab Facebook đầu tiên không có chiến lược

`tabs.find(...)` chọn tab đầu tiên Chrome trả về, không xét:

- Tab đang active.
- Tab vừa dùng gần nhất.
- Tab đang soạn nội dung.
- Tab thuộc profile/domain `www`, `web` hay `m`.
- Tab có đúng account binding.

**Cải thiện:** tạo bộ chấm điểm tab và loại trừ tab không an toàn trước khi chọn.

---

### BUG-14 — Quiet hours cố định và comment không khớp code

- Code dùng 00:00–06:00 và đặt lại từ 06:00 cộng 0–90 phút.
- Comment ghi “khoảng 7–8h sáng”.
- Dùng timezone máy, không phải timezone cấu hình của tài khoản.

**Cải thiện:**

- Cho phép cấu hình giờ ngủ theo tài khoản.
- Mặc định dùng timezone đã xác định rõ.
- Thêm sai lệch theo ngày, không cố định mỗi ngày cùng một cửa sổ.
- Sửa comment khớp implementation.

---

### BUG-15 — Không có test cho warming

Không thấy test cho:

- Chuẩn hóa config.
- Tính lịch có jitter và quiet hours.
- Dựng kế hoạch action.
- Xác suất/giới hạn action ghi.
- Stop giữa sleep.
- Xử lý block.
- Đếm success/error.
- Race token/config.

**Cải thiện:** tách các phần thuần thành hàm export nội bộ hoặc module riêng để test bằng Node, không cần Chrome runtime thật.

---

## 4. Cải thiện để hành vi tự nhiên hơn — không loại bỏ tính năng

## 4.1. Chuyển từ random độc lập sang “phiên hành vi” có ngữ cảnh

Hiện tại phần lớn action được shuffle và random độc lập. Nên dựng session có cấu trúc:

1. **Mở phiên:** ở trang chủ hoặc vị trí hợp lý.
2. **Hành vi chính:** chọn 1 mục tiêu chính như feed, groups hoặc reels.
3. **Hành vi phụ:** đôi khi mở notifications hoặc xem video liên quan.
4. **Kết phiên:** dừng sau khoảng thời gian hợp lý, không nhất thiết chạy hết quota.

Ví dụ session:

- Feed → dừng đọc → mở video đang thấy → quay lại feed.
- Notifications → xem 2–3 mục → về Home → cuộn nhẹ.
- Groups → xem một số bài → kết thúc.
- Reels → xem 2–5 reel → kết thúc, không bắt buộc reaction.

Không nên mỗi lượt luôn đi qua nhiều khu vực không liên quan chỉ vì chúng đều được bật.

---

## 4.2. Thêm hồ sơ nhịp sinh hoạt theo tài khoản

Nên bổ sung cấu hình:

- Timezone.
- Khung giờ hoạt động trong ngày.
- Số phiên tối đa/ngày.
- Tổng thời gian tối đa/ngày.
- Khoảng nghỉ tối thiểu giữa hai phiên.
- Ngày hoạt động thấp hoặc ngày nghỉ.
- Mức độ tài khoản: mới, ổn định, lâu năm.

Không nên dùng một cấu hình giống nhau cho mọi tài khoản.

Đề xuất preset:

### Thận trọng

- 1–3 phiên/ngày.
- 1–2 action/session.
- Không bật write action mặc định.
- Nghỉ dài sau lỗi hoặc trang tải bất thường.

### Bình thường

- 2–5 phiên/ngày.
- 1–3 action/session.
- Write action có ngân sách riêng và xác suất thấp.

### Tùy chỉnh

- Cho người dùng chỉnh chi tiết nhưng vẫn có hard safety caps.

---

## 4.3. Dùng phân phối thời gian hợp lý hơn

Uniform random trong khoảng rộng vẫn tạo pattern cơ học. Nên dùng:

- Log-normal hoặc gamma cho thời gian dừng đọc.
- Weighted distribution cho số lần cuộn.
- Session duration làm giới hạn chính thay vì chỉ action count.
- Correlation: bài dài dừng lâu hơn, video dài xem lâu hơn, trang không có nội dung thì rời sớm.

Ví dụ:

- Phần lớn pause ngắn 1–3 giây.
- Một số pause trung bình 4–10 giây.
- Hiếm khi pause dài hơn.
- Không dùng cùng phân phối cho feed, notification và reels.

---

## 4.4. Dựa vào nội dung/DOM thật thay vì cuộn theo số pixel cố định

Hiện tại feed dùng các khoảng pixel gần giống nhau. Nên:

- Nhận diện card/post/reel đang ở viewport.
- Cuộn tới ranh giới item tiếp theo.
- Thời gian dừng dựa trên lượng text/media.
- Nếu item đã thấy trước đó thì lướt nhanh hơn.
- Nếu trang không tải thêm item thì kết thúc sớm.

Kết quả action nên ghi:

- Số item thực sự đã xem.
- Scroll distance thực tế.
- Thời gian foreground/visible.
- Có lazy-load thành công hay không.

---

## 4.5. Hạn chế chuỗi điều hướng lặp lại

Mặc dù thứ tự có shuffle, mỗi action luôn điều hướng tới một URL/mục cố định. Cần lưu lịch sử gần đây:

- Action nào vừa chạy.
- Khu vực nào đã ghé trong 24 giờ.
- Số lần liên tiếp một action được chọn.
- Thời điểm reaction gần nhất.

Dùng lịch sử để giảm trọng số action vừa chạy, thay vì chỉ shuffle danh sách trong một lượt.

---

## 4.6. Reaction cần ngân sách và điều kiện ngữ cảnh riêng

Giữ `reactPost` và `reactReels`, nhưng cải thiện:

- Ngân sách tối đa/ngày và/tuần.
- Cooldown tối thiểu giữa hai reaction.
- Không reaction ngay sau khi vào trang; phải có thời gian đọc/xem trước.
- Chỉ reaction item đang thực sự visible.
- Không reaction nội dung quảng cáo, suggested item không rõ nguồn hoặc nút không xác minh được.
- Không reaction khi account mới hoặc vừa gặp checkpoint.
- Không buộc reaction 100% trong manual run.
- Xác minh trạng thái sau click.

Nên có `writeBudget` riêng, không trộn với action count read-only.

---

## 4.7. Không phát mousemove ngẫu nhiên toàn viewport

`mousemove` ngẫu nhiên tới bất kỳ tọa độ nào dễ tạo đường đi không tự nhiên và không có tác dụng với `isTrusted`.

Cải thiện:

- Chỉ hover phần tử có ý nghĩa mà action đang đọc.
- Không cần giả lập chuột nếu không phục vụ tương tác cụ thể.
- Tập trung vào trạng thái trang thật: visibility, scroll, dwell time, media progress.
- Nếu cần click, dùng phần tử đích và xác minh hậu điều kiện.

---

## 4.8. Thêm thích ứng theo sức khỏe tài khoản

Mỗi session nên có risk score dựa trên:

- Checkpoint/login redirect.
- Tải trang thất bại.
- Nhiều action không xác minh được.
- Facebook trả giao diện bất thường.
- Gần đây có lỗi gửi/crawl/reaction.
- Tần suất hoạt động thực tế trong 24 giờ.

Theo score:

- Giảm số action.
- Tăng khoảng nghỉ.
- Chuyển sang read-only.
- Tạm ngừng write action.
- Chỉ khôi phục sau health-check an toàn.

Đây là cải thiện, không loại bỏ action; action được giữ nhưng chỉ chạy khi điều kiện phù hợp.

---

## 4.9. Phân biệt `success`, `no-op`, `skipped`, `unverified`, `error`

Hiện tại kết quả chủ yếu là done/error. Nên dùng trạng thái chi tiết:

- `success`: đã xác minh hậu điều kiện.
- `no_op`: trang hợp lệ nhưng không có nội dung phù hợp.
- `skipped`: chính sách quyết định không chạy.
- `deferred`: tab/background/visibility chưa phù hợp, để lượt sau.
- `unverified`: có thao tác nhưng không xác minh được kết quả.
- `blocked`: checkpoint/login/risk gate.
- `error`: lỗi kỹ thuật.
- `stopped`: người dùng dừng.

Nhật ký chi tiết giúp hệ thống thích ứng thay vì tiếp tục lặp lỗi.

---

## 4.10. Thêm giới hạn phiên và giới hạn ngày

Ngoài `actionsPerRun`, cần:

- `maxSessionDurationMs`.
- `maxSessionsPerDay`.
- `maxReadActionsPerDay`.
- `maxWriteActionsPerDay`.
- `minSessionGapMs`.
- `maxConsecutiveErrors`.

Các hard cap phải được kiểm tra server-side hoặc trong nguồn trạng thái dùng chung, tránh nhiều thiết bị cùng tài khoản vượt tổng giới hạn.

---

## 5. Cải thiện UI/UX

### 5.1. Làm rõ chạy tự động và chạy kiểm thử

Tách hai hành động:

- **Chạy một phiên theo chính sách:** giữ xác suất và giới hạn như tự động.
- **Kiểm thử một hành động:** người dùng chọn đúng một action và xem kết quả kỹ thuật.

Không nên dùng manual run để buộc chạy mọi action ghi.

### 5.2. Hiển thị lần chạy kế tiếp

Backend nên lưu/return:

- `nextRunAt`.
- Lý do bị lùi lịch.
- Quiet hours hiện tại.
- Số phiên còn lại trong ngày.

### 5.3. Hiển thị thống kê đúng

Thay “Xong N hành động” bằng:

- Thành công.
- Bỏ qua.
- Chưa xác minh.
- Lỗi.
- Bị chặn.

### 5.4. Cảnh báo riêng cho write action

Khi bật reaction:

- Hiển thị daily cap.
- Hiển thị cooldown.
- Không dùng wording khiến người dùng hiểu reaction chắc chắn chạy trong mỗi lượt.

### 5.5. Hiển thị tài khoản Facebook đang được thao tác

Trước khi chạy tay:

- Tài khoản đã liên kết.
- Tài khoản đang đăng nhập.
- Trạng thái khớp/không khớp.

---

## 6. Đề xuất kiến trúc refactor

Nên tách phần warming khỏi file `src/crawl.js` lớn thành các module:

```text
src/warming/
  config.js          # normalize, defaults, policy
  scheduler.js       # next run, quiet hours, daily/session caps
  planner.js         # dựng session plan theo history/risk
  executor.js        # tab acquisition, navigation, action execution
  actions/
    feed.js
    groups.js
    notifications.js
    video.js
    reels.js
    reactions.js
  result.js          # status model và aggregation
  history.js         # recent action/session state
```

Lợi ích:

- Test được planner/scheduler mà không cần Chrome.
- Không trộn crawl, inbox, posting và warming trong một file hơn 4.000 dòng.
- Dễ thêm chính sách theo account age/risk mà không sửa DOM action.
- Dễ mock tab/scripting/API trong test.

---

## 7. Test cần bổ sung

## Unit test

1. `normalizeWarmingActions` loại action lạ, không trùng.
2. Config clamp đúng giới hạn.
3. Scheduler không đặt lịch trong quiet hours.
4. Scheduler xử lý timezone/ngày chuyển giờ.
5. Planner chọn số action trong giới hạn.
6. Planner không lặp action vừa chạy quá nhiều.
7. Write budget và cooldown hoạt động đúng.
8. Manual run tôn trọng policy.
9. Aggregator không tính error thành success.
10. Stop làm ngắt sleep.
11. Shared kill-switch không bị clear nhầm.

## Integration test với mock Chrome API

1. Tab bị checkpoint trước action.
2. Điều hướng mềm thất bại và fallback URL.
3. Tab bị đóng giữa lượt.
4. `executeScript` throw.
5. Tab background không có scroll progress.
6. Reaction click nhưng trạng thái không đổi.
7. Video `play()` reject.
8. Account binding mismatch.
9. Token chưa load khi alarm bắn.
10. Lỗi ghi log không làm mất kết quả action nhưng được báo telemetry.

## UI test

1. Toggle action lưu đúng ngay lần đầu.
2. Toggle nhanh nhiều action không mất state.
3. Reload giữ config.
4. UI hiển thị success/error/skipped chính xác.
5. Nút dừng không cho chạy chồng.

---

## 8. Thứ tự triển khai đề xuất

## Giai đoạn 1 — Sửa tính đúng đắn

1. Sửa stale state khi lưu checkbox.
2. Chờ `readyPromise` cho toàn bộ warming handler/alarm.
3. Tách `attempted/succeeded/failed/skipped`.
4. Không nuốt exception toàn lượt.
5. Không clear shared kill-switch tùy tiện.
6. Xác minh account binding trước thao tác.
7. Xác minh hậu điều kiện của navigate/reaction/video.

## Giai đoạn 2 — Chuẩn hóa policy

1. Manual run tôn trọng giới hạn.
2. Tách test action khỏi run session.
3. Thêm daily/session caps.
4. Thêm cooldown cho write action.
5. Thêm trạng thái `no_op/deferred/unverified`.
6. Không chiếm tab người dùng mặc định.

## Giai đoạn 3 — Tự nhiên theo ngữ cảnh

1. Session planner có chủ đề.
2. Lịch sử và trọng số action.
3. Dwell time theo nội dung.
4. Quiet hours/timezone tùy tài khoản.
5. Risk score và adaptive throttling.

## Giai đoạn 4 — Refactor và kiểm thử

1. Tách `src/warming/`.
2. Viết unit test cho planner/scheduler.
3. Mock Chrome API cho executor.
4. Thêm telemetry và dashboard thống kê.

---

## 9. Tiêu chí hoàn thành tổng thể

Tính năng được xem là cải thiện đạt yêu cầu khi:

1. Không thao tác nếu Facebook account không khớp binding.
2. Không báo success nếu không xác minh được hậu điều kiện.
3. Không tính action lỗi vào số action hoàn thành.
4. Không tự xóa block do subsystem khác đặt.
5. Config UI lưu đúng trong mọi thao tác toggle.
6. Manual run không vượt giới hạn người dùng đặt.
7. Có giới hạn phiên/ngày và cooldown write action.
8. Có lịch sử để tránh action pattern lặp lại.
9. Không chiếm hoặc làm thay đổi tab người dùng mà không khôi phục.
10. Có test cho scheduler, planner, executor và UI config.
11. Nhật ký đủ chi tiết để phân biệt success/no-op/skipped/unverified/error/blocked.
12. Hành vi được quyết định theo session và ngữ cảnh trang, không chỉ dựa vào random pixel/delay.

---

## 10. Kết luận

Phần warming hiện tại đã có nền tảng an toàn tương đối tốt: mặc định tắt, có jitter, quiet hours, kill-switch, stop và log. Tuy nhiên, nhiều chỗ đang đánh đồng “đã chờ/đã phát event” với “đã thực hiện thành công”. Đây là vấn đề lớn nhất cần sửa trước.

Ưu tiên đúng không phải là tăng thêm thao tác giả, mà là:

1. Xác minh đúng tài khoản.
2. Xác minh kết quả thực tế.
3. Có session policy, ngân sách và lịch sử.
4. Thích ứng với trạng thái tài khoản.
5. Báo cáo trung thực khi action không chạy hoặc không xác minh được.

Các cải thiện trên giữ nguyên toàn bộ nhóm tính năng hiện có, nhưng làm cho hệ thống ít máy móc hơn, dễ kiểm soát hơn và đáng tin cậy hơn.