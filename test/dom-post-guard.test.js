/**
 * dom-post-guard.test.js — Test hồi quy cho bug "bài Không rõ" do bộ bóc tách DOM.
 *
 * BỐI CẢNH (đã XÁC MINH bằng dữ liệu thật, không phỏng đoán):
 *   Soi DB qua GET_ALL_POSTS thấy 20 record rác, 14/20 có postId dạng "fp:" và
 *   text là metadata thẻ nhóm:
 *     "Có 3,4K người theo dõi", "Có 148 người theo dõi", "Có 1,2K người theo dõi",
 *     "40K thành viên • 10+ bài viết/ngày"
 *   Nguyên nhân: thẻ NHÓM GỢI Ý trong feed cũng chứa link
 *   /groups/{gid}/user/{uid}/ nên lọt qua isPostContainer, rồi extractText rơi
 *   xuống nhánh "khối text DÀI NHẤT" và trúng đúng metadata đó. Chuỗi rác đó chỉ
 *   tồn tại trong DOM feed nên nguồn gốc là extractPost (src/content.js).
 *
 * ĐÍNH CHÍNH (kết luận cũ đã bị PHỦ NHẬN):
 *   Trước đây test này lập luận "20/20 record thiếu field `source` => do DOM
 *   sinh". Lập luận đó SAI. Chẩn đoán trên toàn DB thật cho thấy 0/2840 bài có
 *   field `source` — kể cả bài do nhánh API sinh — vì phía server LOẠI field này
 *   khi lưu. Thiếu `source` KHÔNG suy ra được bộ bóc tách nào. Bằng chứng còn
 *   giá trị là bản thân CHUỖI TEXT của thẻ nhóm gợi ý, dùng nguyên văn dưới đây.
 *
 * CÁCH TEST: src/content.js là IIFE chạy trong tab nên không export được. Ta
 * TRÍCH nguyên văn 2 hàm cần kiểm tra từ source rồi chạy trong sandbox với
 * phần tử DOM giả. Nhờ vậy test soi ĐÚNG code đang chạy thật, và sẽ ĐỎ ngay nếu
 * ai đó xoá điều kiện chặn thẻ nhóm.
 *
 *   Chạy: node --test test/dom-post-guard.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

/** Trích nguyên văn 1 khai báo `function ten(...) { ... }` bằng cách đếm ngoặc. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `không tìm thấy function ${name} trong content.js`);
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      seenOpen = true;
    } else if (ch === "}") {
      depth -= 1;
      if (seenOpen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`không đóng được ngoặc cho function ${name}`);
}

/**
 * Phần tử DOM giả tối thiểu: chỉ cần querySelector theo tập href có sẵn và
 * innerText. Đủ để chạy isPostContainer (không cần jsdom).
 */
function fakeEl({ hrefs = [], text = "" } = {}) {
  return {
    innerText: text,
    textContent: text,
    querySelector(sel) {
      // Bắt đúng 2 mẫu selector mà isPostContainer dùng.
      if (sel.includes('[href*="/user/"]')) {
        return hrefs.some((h) => h.includes("/groups/") && h.includes("/user/"))
          ? { href: "x" }
          : null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

// Dựng sandbox chứa isPostContainer thật + stub getPostIdFrom điều khiển được.
function buildIsPostContainer(postIdResult) {
  const body = extractFunction(SRC, "isPostContainer");
  const factory = new Function(
    "getPostIdFrom",
    `${body}; return isPostContainer;`
  );
  return factory(() => postIdResult);
}

/* --------------------------- Fixtures dữ liệu THẬT ------------------------ */

// Text lấy NGUYÊN VĂN từ các record rác trong DB.
const REAL_GROUP_CARD_TEXTS = [
  "Có 3,4K người theo dõi",
  "Có 148 người theo dõi",
  "Có 1,2K người theo dõi",
  "Có 458 người theo dõi",
  "Có 2,7K người theo dõi",
  "40K thành viên • 10+ bài viết/ngày",
];

/* -------------------------------- Tests ---------------------------------- */

test("isPostContainer: LOẠI thẻ nhóm gợi ý (chính là nguồn bài 'Không rõ')", () => {
  const isPostContainer = buildIsPostContainer(null); // không có postId thật

  for (const text of REAL_GROUP_CARD_TEXTS) {
    const el = fakeEl({
      // Thẻ nhóm VẪN có link kiểu /groups/{gid}/user/{uid}/ => đây là lý do
      // điều kiện cũ (chỉ check link này) để nó lọt vào và sinh bài rác.
      hrefs: ["https://www.facebook.com/groups/806718611360517/user/61553801835622/"],
      text,
    });
    assert.equal(
      isPostContainer(el),
      false,
      `phải loại thẻ nhóm có text: ${text}`
    );
  }
});

test("isPostContainer: GIỮ bài thật (có link tác giả, text bài viết bình thường)", () => {
  const isPostContainer = buildIsPostContainer(null);

  const el = fakeEl({
    hrefs: ["https://www.facebook.com/groups/927304395556619/user/100001/"],
    text: "Mình có ít màn hình cũ cần bán, ai cần inbox mình nhé. Giá thương lượng.",
  });
  assert.equal(isPostContainer(el), true);
});

test("isPostContainer: có postId THẬT thì luôn nhận, không bị marker loại oan", () => {
  const isPostContainer = buildIsPostContainer("1545077007112685");

  // Bài dài tình cờ chứa chữ "thành viên" vẫn phải được nhận vì có postId thật.
  const el = fakeEl({
    hrefs: [],
    text: "Nhóm mình đông thành viên quá, mình xin phép bán con máy này...",
  });
  assert.equal(isPostContainer(el), true);
});

test("isPostContainer: không có link tác giả và không có postId => loại", () => {
  const isPostContainer = buildIsPostContainer(null);
  assert.equal(isPostContainer(fakeEl({ hrefs: [], text: "abc" })), false);
});

test("isPostContainer: bài DÀI chứa chữ 'thành viên' KHÔNG bị loại (ngưỡng 400 ký tự)", () => {
  const isPostContainer = buildIsPostContainer(null);

  const longText =
    "Chào cả nhà, mình là thành viên mới của nhóm. " +
    "Mình đang cần thanh lý một số linh kiện PC cũ còn dùng tốt. ".repeat(8);
  assert.ok(longText.length >= 400, "fixture phải dài >= 400 ký tự");

  const el = fakeEl({
    hrefs: ["https://www.facebook.com/groups/927304395556619/user/100002/"],
    text: longText,
  });
  assert.equal(isPostContainer(el), true);
});

test("extractPost: có gắn source:'dom' để phân biệt với nhánh API", () => {
  // Đối xứng với mapEdgeToPost (gql-parse.js) gắn source:"api". Trước khi sửa,
  // nhánh DOM KHÔNG gắn field này nên không thể truy nguồn record trong DB.
  assert.match(
    SRC,
    /source:\s*"dom"/,
    'extractPost phải gắn source: "dom" vào bản ghi trả về'
  );
});

test("extractPost: có ĐIỀU KIỆN TỐI THIỂU chặn node thiếu cả postId lẫn tác giả", () => {
  // Bài THẬT luôn có ít nhất postId thật HOẶC tên tác giả. Thiếu cả hai nghĩa là
  // ô không phải bài viết => không được lưu (nếu không sẽ ra "Không rõ" + "fp:").
  assert.match(
    SRC,
    /if\s*\(\s*!postId\s*&&\s*!finalAuthor\s*\)\s*return\s+null\s*;/,
    "extractPost phải có guard: !postId && !finalAuthor => return null"
  );
});
