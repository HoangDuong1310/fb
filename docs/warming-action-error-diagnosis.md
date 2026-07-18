# Chẩn đoán và trạng thái sửa lỗi `reactReels: unverified` / `openNotifications: error`

## 1. Phạm vi và nguyên tắc bằng chứng

Tài liệu này mô tả:

- Ý nghĩa của `reactReels: unverified`.
- Các nhánh tạo `openNotifications: error`.
- Những thay đổi đã triển khai để tăng độ an toàn và khả năng chẩn đoán.
- Cách đọc log mới để xác định nguyên nhân của từng lần chạy.
- Kết quả kiểm thử sau khi sửa.

Mọi kết luận dưới đây dựa trên mã nguồn và test của repository. Tài liệu không suy đoán nguyên nhân của một bản ghi lịch sử khi chưa đọc được trường `data` của chính bản ghi đó.

### Giới hạn dữ liệu lịch sử

Trong lần điều tra ban đầu, truy vấn chỉ đọc tới bảng `warming_activity_log` không thực hiện được vì MySQL trả:

```text
DIAG_QUERY_FAILED: ECONNREFUSED
```

Vì vậy, chưa có bằng chứng để khẳng định nhánh runtime cụ thể đã tạo ra các bản ghi mà người dùng nhìn thấy trước khi bản sửa được triển khai.

Điều có thể khẳng định:

- Mã nguồn cho biết chính xác các nhánh có thể tạo từng trạng thái.
- Log mới lưu chẩn đoán có cấu trúc và UI hiển thị lý do đã được làm sạch.
- Muốn kết luận một lần chạy cụ thể vẫn phải đọc `entry.data` của bản ghi đó.

## 2. Ý nghĩa trạng thái

Hệ thống hiện chỉ chấp nhận các trạng thái warming sau:

| Trạng thái | Ý nghĩa |
|---|---|
| `done` | Hành động hoàn tất. |
| `success` | Hành động thành công. |
| `error` | Có lỗi thực thi hoặc dữ liệu kết quả không hợp lệ. |
| `blocked` | Facebook hoặc chính sách runtime chặn hành động. |
| `stopped` | Phiên warming bị dừng. |
| `no_op` | Không cần hoặc không có gì phù hợp để thao tác. |
| `unverified` | Đã thử thao tác nhưng không đủ tín hiệu xác minh hậu điều kiện. |
| `skipped` | Hành động được bỏ qua có chủ đích. |
| `deferred` | Hành động được hoãn theo chính sách/rủi ro. |

Giá trị status ngoài danh sách trên bị đổi thành `error` trước khi ghi log và khi đọc dữ liệu vào UI. Điều này ngăn status tùy ý hoặc dữ liệu cũ làm sai giao diện.

## 3. Luồng dữ liệu chẩn đoán sau khi sửa

### 3.1. Runtime tạo kết quả có cấu trúc

`executeWarmingAction()` và các hàm chạy trong trang trả `detail` có thể chứa:

```js
{
  stage,
  note,
  error,
  tabUrl,
  navigation,
  resultCount,
  verificationSignals
}
```

Không phải mọi bản ghi đều có tất cả các trường. Trường được ghi phụ thuộc vào stage và kết quả thực tế.

`processWarming()` chuyển `detail` thành status bằng `statusFromActionDetail()` rồi gọi:

```js
await DB.recordWarmingActivity({
  type: action,
  status,
  data: detail
});
```

### 3.2. Làm sạch trước khi gửi backend

`recordWarmingActivity()` trong `src/db.js` gọi `redactValue()` trước khi `JSON.stringify()` và trước khi gửi `POST /api/warming/log`.

Các dữ liệu sau được làm sạch:

- JWT.
- Bearer credential.
- `access_token`, `refresh_token`, `id_token`, token, API key, secret và password dạng inline.
- Giá trị nằm dưới object key nhạy cảm như `authorization`, `cookie`, `token`, `password`, `secret`, `session`.
- Query string hoặc fragment trong URL.
- Header `Authorization:` và `Cookie:` thông thường.
- Header `Authorization:` và `Cookie:` có continuation line dạng folded header.

Ví dụ:

```text
Authorization: Basic abc123
=> Authorization: [redacted]

Cookie: c_user=12345; xs=topsecret
=> Cookie: [redacted]

Authorization: Bearer abc\r\n TOPSECRET
=> Authorization: [redacted]
```

### 3.3. UI coi dữ liệu backend là không tin cậy

Trước khi render, `normalizeWarmingActivityEntries()` trong `ui/src/lib/warming-diagnostics.ts`:

- Chỉ nhận mảng.
- Chỉ nhận ID số nguyên dương an toàn hoặc chuỗi thập phân canonical như `"5"`.
- Loại các ID như `null`, `""`, `0`, boolean, `"01"`, `"1e2"`, `"4.0"`, số lẻ và số không an toàn.
- Chuẩn hóa ID chuỗi thành số.
- Loại ID trùng sau chuẩn hóa; ví dụ `5` và `"5"` không thể cùng trở thành React key.
- Chỉ giữ activity type đã biết; type lạ được đổi thành chuỗi cố định `unknown`.
- Đổi status lạ thành `error`.

Nhờ đó, type độc hại như:

```text
token=topsecret
```

không được hiển thị nguyên văn.

### 3.4. UI làm sạch lần hai trước khi hiển thị

`sanitizeWarmingDiagnostic()` làm sạch lại diagnostic trước khi đưa vào text hoặc thuộc tính `title`.

Đây là lớp phòng thủ thứ hai trong trường hợp:

- Dữ liệu cũ đã tồn tại trước bản sửa.
- Một đường ghi khác không áp dụng sanitizer phía client.
- Backend trả dữ liệu bất thường.

UI sanitizer cũng loại toàn bộ normal/folded `Authorization:` và `Cookie:` header, bao gồm trường hợp:

```text
Authorization: Bearer abc\r\n TOPSECRET
```

Kết quả hiển thị chỉ còn:

```text
Authorization: [redacted]
```

## 4. `reactReels` / `reactPost: unverified`

### 4.1. Kết luận được phép

`unverified` có nghĩa:

1. Mã đã tìm thấy một nút reaction phù hợp và chưa thấy trạng thái reacted trước thao tác.
2. Mã đã thử thực hiện click.
3. Sau khoảng chờ hữu hạn, bộ xác minh không quan sát được đủ tín hiệu để chứng minh trạng thái reaction đã thay đổi.

`unverified` không đồng nghĩa với:

- Chắc chắn reaction thất bại.
- Chắc chắn reaction thành công.

Nó chỉ nói rằng hậu điều kiện chưa được xác minh.

### 4.2. Sửa lỗi click không an toàn

Trước đây, khi `HTMLElement.click()` ném exception, code có thể thử tiếp synthetic mouse events. Cách này không an toàn vì exception không chứng minh click đầu tiên chưa tạo side effect. Click thứ hai có thể bỏ reaction vừa tạo.

Sau khi sửa:

- Nếu native `.click()` đã được gọi và ném exception, hàm trả ngay:

```js
{
  ok: true,
  reacted: true,
  verified: false,
  status: "unverified",
  note: "react-click-uncertain",
  error,
  pressedBefore,
  labelBefore
}
```

- Không phát synthetic click thứ hai.
- Synthetic mouse events chỉ được dùng khi phần tử không có hàm `.click()` khả dụng.

Đây là yêu cầu an toàn quan trọng nhất của hành động ghi: không retry một write action khi side effect của lần đầu còn không chắc chắn.

### 4.3. Hậu kiểm reaction

Sau click, runtime không chỉ đọc lại một reference cũ. Bộ hậu kiểm:

- Theo dõi thay đổi DOM bằng `MutationObserver`.
- Poll trong timeout hữu hạn.
- Tìm lại candidate khi Facebook thay node trong quá trình SPA render.
- Đọc các tín hiệu như `aria-pressed` và reaction-related label.
- Ghi `verificationSignals` để cho biết tín hiệu trước/sau mà runtime đã quan sát.

Nếu không có tín hiệu đủ mạnh, trạng thái vẫn là `unverified` và không có click lần hai.

### 4.4. Cách đọc log reaction mới

Kiểm tra các trường:

- `data.note`.
- `data.error` nếu có.
- `data.pressedBefore`.
- `data.labelBefore`.
- `data.verificationSignals`.

Phân loại:

| Diagnostic | Kết luận |
|---|---|
| `note: "react-click-uncertain"` | Native click đã được gọi nhưng ném exception; side effect không chắc chắn; runtime chủ động không click lần hai. |
| `note: "react-unverified"` | Click không ném exception nhưng không quan sát được tín hiệu xác minh trong timeout. |
| `note: "no-like-button"` | Không tìm thấy nút reaction phù hợp; đây là `no_op`, không phải bằng chứng selector chắc chắn hỏng trên mọi giao diện. |
| `verificationSignals` có trạng thái reacted | Kết quả phải được đối chiếu với version extension và timestamp nếu status vẫn là `unverified`. |
| Không có `data` | Có thể là bản ghi từ phiên bản cũ; không được suy ra trạng thái DOM. |

### 4.5. Bản ghi `reactPost` production đã xác minh ngày 16/07/2026

Bản ghi mới nhất được đọc từ API production có `type: "reactPost"`, `status: "unverified"` và các tín hiệu chính:

```json
{
  "note": "react-unverified",
  "reacted": true,
  "verified": false,
  "navigation": {
    "method": "soft",
    "target": "home",
    "verified": true,
    "navigated": true
  },
  "pressedBefore": null,
  "pressedAfter": null
}
```

Kết luận dựa trực tiếp trên bản ghi:

- Soft navigation tới Trang chủ đã thành công và được xác minh; đây không phải lỗi navigation.
- Runtime đã tìm thấy candidate và đã gọi thao tác reaction.
- Nút ban đầu không cung cấp `aria-pressed`, và reference cũ vẫn không cung cấp thuộc tính này sau click.
- Phiên bản tạo bản ghi chỉ đọc lại reference cũ một lần; nó không ghi `labelBefore`, `labelAfter`, `nodeReplaced` hoặc `verificationSignals`.
- Vì vậy bản ghi không chứng minh Facebook đã từ chối click. Nó chỉ chứng minh bộ hậu kiểm cũ không quan sát được hậu điều kiện trên reference đang giữ.

Bản sửa cho `reactPost` áp dụng cùng nguyên tắc đã dùng cho Reels:

- Không phát synthetic click thứ hai nếu native `.click()` đã được gọi rồi ném exception.
- Theo dõi mutation và poll trong timeout hữu hạn.
- Tìm lại candidate gần vị trí nút ban đầu để nhận biết React/SPA đã thay node.
- Ghi `labelBefore`, `labelAfter`, `pressedBefore`, `pressedAfter`, `nodeReplaced` và `verificationSignals`.

### 4.6. Bản ghi `reactReels` production đã xác minh ngày 16/07/2026

Bản ghi mới nhất được đọc từ backend mà extension thực sự đang cấu hình sử dụng có các tín hiệu:

```json
{
  "type": "reactReels",
  "status": "unverified",
  "data": {
    "note": "react-unverified",
    "reacted": true,
    "verified": false,
    "labelBefore": "thích",
    "labelAfter": "gỡ thích",
    "pressedBefore": null,
    "pressedAfter": null,
    "nodeReplaced": false,
    "navigation": {
      "method": "soft",
      "target": "reels",
      "verified": true,
      "navigated": true
    }
  }
}
```

Kết luận dựa trực tiếp trên bản ghi:

- Navigation tới Reels đã thành công; không phải lỗi navigation.
- Facebook đã đổi nhãn từ `Thích` thành `Gỡ thích`, nên click đã tạo hậu điều kiện reaction quan sát được.
- Giao diện này không cung cấp `aria-pressed`; cả trước và sau đều là `null`.
- Bộ xác minh cũ chỉ nhận `Bỏ thích`, `Unlike` và `Remove like`, nhưng thiếu nhãn tiếng Việt thực tế `Gỡ thích`.
- Vì vậy `react-unverified` trong bản ghi này là false negative của bộ xác minh, không phải bằng chứng reaction thất bại.

Bản sửa thêm `gỡ thích` vào cả bộ xác minh `reactPost` và `reactReels`, gồm kiểm tra node hiện tại và candidate được tìm lại sau SPA render. Regression test mô phỏng chính xác chuyển đổi `Thích` → `Gỡ thích` và yêu cầu kết quả `done`, `verified: true`.

Lưu ý môi trường: MySQL local đã được xác nhận hoạt động nhưng không có bản ghi mới này. Extension hiện lấy backend từ `src/config.js`, nên việc MySQL local đang chạy không có nghĩa extension tự động ghi vào local. Phải đọc log từ backend đang được cấu hình thực tế trước khi kết luận.

## 5. `openNotifications: error`

### 5.1. Không có thông báo không tự động là lỗi

`runNotificationsInPage()` phân biệt:

- Trang/landmark notification hợp lệ nhưng không có item để hover.
- Trang không được xác minh là notification content.
- Lỗi ở navigation, injection hoặc action result.

Không có item phù hợp có thể là `no_op`; không cần biến thành `error`.

### 5.2. Không dùng global notification bell để xác minh nội dung trang

Global header bell tồn tại trên nhiều trang Facebook. Sự tồn tại của bell không chứng minh tab đã tới trang hoặc dialog thông báo.

Sau khi sửa, verification chỉ dựa trên:

- Pathname notification phù hợp; hoặc
- Notification content nằm trong main/dialog landmark phù hợp.

Test regression xác nhận chỉ có global header bell thì hành động không được đánh dấu là đã xác minh.

### 5.3. Navigation có chẩn đoán cấu trúc

`executeWarmingAction()` giữ một object `navigation` để ghi lại soft/hard navigation thay vì nuốt exception.

Các lỗi có thể được phân loại theo:

```js
{
  stage: "soft-navigation" | "hard-navigation" | "action-injection" | "action-result",
  note,
  error,
  tabUrl,
  navigation,
  resultCount
}
```

`tabUrl` được loại query string và fragment trước khi đưa vào diagnostic.

### 5.4. Không inject action sau hard-navigation timeout

Nếu hard navigation không hoàn tất trong timeout:

- Runtime trả kết quả `unverified` tại stage navigation.
- Không inject `runNotificationsInPage()` hoặc action function khác vào trang chưa hoàn tất.

Điều này tránh chạy thao tác trên DOM cũ, trang chuyển tiếp hoặc trang chưa ổn định.

### 5.5. Chỉ chấp nhận main-frame result

`chrome.scripting.executeScript()` có thể trả nhiều frame result. Runtime không còn lấy mặc định `res[0]`.

Sau khi sửa:

- Chỉ entry có `frameId === 0` được dùng làm action result.
- Mảng rỗng hoặc chỉ có subframe result được phân loại là thiếu main-frame result.
- Diagnostic ghi `stage: "action-result"`, `note` và `resultCount` thay vì fallback mơ hồ `{ ok: false }`.

Điều này ngăn subframe vô tình quyết định status của toàn hành động.

### 5.6. Cách đọc log notification mới

| Diagnostic | Kết luận |
|---|---|
| `stage: "soft-navigation"` | Có vấn đề trong lần thử điều hướng SPA; xem `navigation` và `error`. |
| `stage: "hard-navigation"`, note timeout | Hard navigation không hoàn tất; action không được inject sau timeout. |
| `stage: "action-injection"` | `chrome.scripting.executeScript()` ném exception khi inject action. |
| `stage: "action-result"`, note missing main-frame result | Injection không cung cấp result hợp lệ từ frame 0; xem `resultCount` và `tabUrl`. |
| `status: "no_op"` | Trang hợp lệ nhưng không có item phù hợp để thao tác. |
| Không có `data` | Không đủ bằng chứng; có thể là log của phiên bản cũ. |

## 6. Cách lấy dữ liệu của một lần lỗi cụ thể

### 6.1. Qua extension background

Trong context extension đã đăng nhập:

```js
chrome.runtime.sendMessage(
  { type: "GET_WARMING_ACTIVITY", limit: 100 },
  (response) => console.log(response)
);
```

Lọc bản ghi:

```js
const affected = response.entries.filter(
  (entry) =>
    (entry.type === "reactReels" && entry.status === "unverified") ||
    (entry.type === "openNotifications" && entry.status === "error")
);
```

Lưu lại:

- `id`.
- `type`.
- `status`.
- `createdAt`.
- `data` đã sanitize.
- Version extension thực tế đã chạy, nếu có telemetry version.

### 6.2. Qua HTTP API

```http
GET /api/warming/log?limit=100
Authorization: Bearer <token>
```

Không đưa bearer token, cookie hoặc raw response chứa dữ liệu cá nhân vào ảnh chụp/tài liệu hỗ trợ.

### 6.3. Qua MySQL chỉ đọc

Chỉ thực hiện trên đúng môi trường có dữ liệu thật và với quyền phù hợp:

```sql
SELECT
  id,
  user_id,
  type,
  status,
  created_at,
  data
FROM warming_activity_log
WHERE user_id = ?
  AND type IN ('reactReels', 'openNotifications')
  AND status IN ('unverified', 'error')
ORDER BY id DESC
LIMIT 100;
```

Không dùng `UPDATE` hoặc `DELETE` để sửa log lịch sử. Log phải được giữ làm bằng chứng runtime.

## 7. UI sau khi sửa

Lịch sử warming hiện hiển thị diagnostic đã sanitize bên dưới action/status, thay vì chỉ hiện `Lỗi` hoặc `Chưa xác minh`.

Thông tin có thể hiển thị gồm:

- `stage`.
- `note`.
- `error` đã làm sạch và giới hạn độ dài.
- `tabUrl` đã bỏ query/hash.
- Thông tin navigation.
- `resultCount`.
- Các `verificationSignals` phù hợp.

UI không được hiển thị nguyên văn:

- Authorization credential.
- Cookie.
- JWT/token/API key/password/secret.
- URL query/hash chứa dữ liệu nhạy cảm.
- Unknown activity type từ backend.

Dữ liệu không hợp lệ bị bỏ qua hoặc thay bằng giá trị kiểm soát như `unknown`/`error`.

## 8. Test regression đã bổ sung

### 8.1. Runtime action

Các test kiểm tra:

- Hard-navigation timeout không inject action tiếp theo.
- Action result rỗng bị phân loại có cấu trúc.
- Subframe-only result không được chấp nhận.
- Main-frame result được chọn dù không đứng đầu mảng.
- Global notification bell không được dùng làm page-content verification.
- Native Reels click ném exception không phát synthetic click thứ hai.

### 8.2. Persistence và status

Các test kiểm tra:

- Diagnostic được redaction trước khi gửi backend.
- Sensitive object keys bị redaction.
- URL query/hash bị loại.
- Header `Authorization:` và `Cookie:` bị redaction.
- Folded Authorization continuation bị loại toàn bộ.
- Status ngoài vocabulary được chuẩn hóa thành `error`.

### 8.3. UI trust boundary

Các test kiểm tra:

- UI redaction đối với bearer, token, URL và header credential.
- Folded Authorization continuation không lộ continuation text.
- Malformed/noncanonical ID bị loại.
- ID trùng sau chuẩn hóa bị loại trước khi trở thành React key.
- Unknown type trở thành `unknown` và không lộ secret-bearing raw text.
- Unknown status trở thành `error`.

## 9. Kết quả xác minh cuối

Sau bản sửa cuối cùng:

- Focused warming/security test suite: đạt.
- `test/warming-diagnostics.test.js`: 9/9 đạt.
- Toàn bộ Node test suite: 320/320 đạt, 0 thất bại.
- `git diff --check`: đạt.
- UI production build sau thay đổi regex folded-header cuối cùng:

```text
npm run build
tsc -b && vite build
✓ built
```

- Final merge-readiness review:
  - Không có Critical issue.
  - Không có Important issue.
  - Kết luận: merge-ready.

Reviewer ghi nhận hai thiếu sót test coverage mức Minor, không phải production defect:

1. Chưa có assertion riêng cho folded `Cookie:` continuation ở cả hai sanitizer test suite.
2. Chưa có integration assertion đưa folded header qua toàn bộ đường `recordWarmingActivity()`.

Implementation hiện dùng cùng continuation-aware expression cho cả `Authorization:` và `Cookie:`, nhưng hai test bổ sung trên vẫn nên được thêm trong một đợt hardening tiếp theo.

## 10. Checklist xử lý sự cố vận hành

1. Ghi `id`, `createdAt`, `type` và `status` của bản ghi.
2. Lấy `entry.data` qua `GET_WARMING_ACTIVITY` hoặc API.
3. Đọc `stage`, `note`, `error`, `navigation`, `resultCount` và `verificationSignals`.
4. Không retry `reactReels` hoặc `reactPost` khi trạng thái click/reaction còn mơ hồ.
5. Nếu `stage` là `hard-navigation`, kiểm tra timeout, URL đã sanitize và trạng thái tab.
6. Nếu `stage` là `action-injection`, xử lý theo exception cụ thể.
7. Nếu `stage` là `action-result`, xác minh extension có nhận result từ `frameId === 0` hay không.
8. Đối chiếu version extension đã tạo log; bản ghi cũ có thể không có diagnostic mới.
9. Không yêu cầu người dùng cung cấp token/cookie để debug.
10. Chỉ kết luận nguyên nhân khi diagnostic của chính lần chạy cung cấp bằng chứng.

## 11. Kết luận

### `reactReels` / `reactPost: unverified`

Trạng thái này nói rằng runtime đã thử reaction nhưng không xác minh được hậu điều kiện. Bản sửa cho cả hai hành động bảo đảm không có write click thứ hai sau một native click không chắc chắn, đồng thời tăng chất lượng hậu kiểm bằng observer, polling, tìm lại node và `verificationSignals`.

### `openNotifications: error`

Trạng thái này không đồng nghĩa với “không có thông báo”. Lỗi nằm ở navigation, injection, main-frame result hoặc exception khác và được phân loại bằng diagnostic có cấu trúc. Hard-navigation timeout dừng luồng trước action injection; global header bell không còn được dùng làm bằng chứng trang thông báo.

### Trạng thái sửa chữa

Các sửa đổi runtime, persistence, UI sanitization, status normalization và untrusted-data normalization đã được triển khai và kiểm thử. Tuy nhiên, nguyên nhân của các bản ghi lịch sử ban đầu vẫn chưa thể khẳng định nếu chưa đọc được `data` của chính các bản ghi đó; tài liệu không thay thế bằng một giả thuyết không có bằng chứng.
