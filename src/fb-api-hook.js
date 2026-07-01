/**
 * fb-api-hook.js — CHẠY Ở "MAIN world" (cùng ngữ cảnh JS với trang Facebook).
 *
 * VÌ SAO cần file riêng & MAIN world:
 *   Content script (content.js) chạy ở "isolated world" => KHÔNG thể vá (hook)
 *   `window.fetch` / `XMLHttpRequest` mà trang Facebook dùng. Muốn "dò" API
 *   GraphQL nội bộ của FB, ta phải vá fetch/XHR NGAY trong ngữ cảnh trang. File
 *   này được nạp qua manifest với "world": "MAIN", "run_at": "document_start"
 *   để bắt mọi request /api/graphql/ TỪ ĐẦU phiên.
 *
 * NÓ LÀM GÌ:
 *   - Vá window.fetch và XMLHttpRequest.
 *   - Lọc request tới ".../api/graphql/".
 *   - Bắt: body request (chứa fb_dtsg, doc_id, fb_api_req_friendly_name,
 *     variables) + TEXT response.
 *   - Gửi sang content.js (isolated world) qua window.postMessage. content.js
 *     mới có quyền chrome.* để LƯU bài (SAVE_POSTS) và phân tích.
 *
 * KHÔNG tự ý gọi API ở đây. Việc replay phân trang do content.js quyết định
 * (nó giữ logic dedup + tiến độ). File này chỉ là "tai nghe" thụ động + một
 * cổng để content.js nhờ thực thi fetch trong ngữ cảnh trang nếu cần.
 *
 * An toàn: bọc try/catch toàn bộ. Nếu FB đổi gì, hook im lặng bỏ qua, KHÔNG
 * bao giờ làm hỏng trang.
 */
(() => {
  if (window.__FBC_GQL_HOOK__) return;
  window.__FBC_GQL_HOOK__ = true;

  const GQL = "/api/graphql/";

  const isGqlUrl = (u) => {
    try {
      return typeof u === "string" && u.indexOf(GQL) !== -1;
    } catch (e) {
      return false;
    }
  };

  // Chuẩn hoá body request về chuỗi (fetch có thể nhận string | URLSearchParams |
  // FormData...). Ta chỉ cần chuỗi urlencoded để content.js bóc tham số.
  const bodyToString = (body) => {
    try {
      if (body == null) return "";
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const p = new URLSearchParams();
        for (const [k, v] of body.entries()) {
          if (typeof v === "string") p.append(k, v);
        }
        return p.toString();
      }
      return "";
    } catch (e) {
      return "";
    }
  };

  // Tách response GraphQL thành các "chunk" JSON. FB hay trả NHIỀU dòng JSON
  // (do @defer/@stream) trong CÙNG một response => phải tách theo xuống dòng và
  // parse từng dòng, không thể JSON.parse cả khối.
  const splitChunks = (text) => {
    const out = [];
    if (!text) return out;
    const lines = text.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch (e) {
        // bỏ dòng không phải JSON
      }
    }
    // Trường hợp cả response là MỘT object (không xuống dòng).
    if (out.length === 0) {
      try {
        out.push(JSON.parse(text));
      } catch (e) {}
    }
    return out;
  };

  // Bộ đệm các gói GraphQL bắt được GẦN NHẤT.
  //
  // VÌ SAO cần đệm: hook này chạy ở document_start (sớm), còn content.js (nơi
  // lắng nghe __FBC_GQL để lưu template) chỉ chạy ở document_idle (muộn hơn).
  // Facebook thường bắn request feed nhóm ĐẦU TIÊN trong khoảng document_start
  // -> document_idle. Nếu ta chỉ postMessage đúng LÚC bắt được, content.js chưa
  // kịp gắn listener => MẤT gói đó => runApiCrawl chờ template mãi không có =>
  // "không crawl được gì". Giải pháp: đệm lại vài gói gần nhất; khi content.js
  // sẵn sàng, nó gửi __FBC_GQL_PULL và hook PHÁT LẠI toàn bộ gói đã đệm.
  const BUFFER_MAX = 8;
  const buffer = [];

  // ĐỆM RIÊNG cho gói FEED NHÓM.
  //
  // VÌ SAO cần đệm riêng: hook đệm MỌI request /api/graphql/ (like, seen,
  // notification, presence, badge…). Trong tab popup/ẩn, Facebook bắn gói feed
  // nhóm SỚM NHẤT rồi tiếp tục bắn 8+ gói non-feed khác. Với buffer chung chỉ
  // giữ BUFFER_MAX=8 gói gần nhất, gói feed (đến đầu tiên) bị .shift() ĐẨY RA
  // trước khi content.js kịp __FBC_GQL_PULL => khi pull chỉ còn toàn gói
  // non-feed => isGroupFeedRequest FALSE hết => feedCount=0 mãi. Đây CHÍNH là
  // gốc rễ "popup lấy 0 bài". Khắc phục: nhận diện gói feed ngay tại hook
  // (inline, không import gql-parse.js) và giữ trong đệm RIÊNG, cap lớn hơn,
  // để gói feed không bao giờ bị gói non-feed đẩy ra.
  const FEED_BUFFER_MAX = 24;
  const feedBuffer = [];

  // Nhận diện gói feed nhóm CHỈ dựa trên chuỗi body request (không cần parse
  // JSON, không cần gql-parse.js). fb_api_req_friendly_name của feed nhóm luôn
  // chứa các dấu hiệu dưới đây (đã lowercase). Cố ý "rộng tay" một chút: thà
  // giữ dư vài gói còn hơn để lọt gói feed thật.
  const FEED_SIGNS = [
    "groupsfeed",
    "groupscometfeed",
    "groupscometnewsfeed",
    "group_feed",
    "groupscometregularstories",
  ];
  const isFeedBody = (bodyStr) => {
    try {
      if (!bodyStr) return false;
      const low = bodyStr.toLowerCase();
      for (const sign of FEED_SIGNS) {
        if (low.indexOf(sign) !== -1) return true;
      }
      // Dự phòng: friendly không khớp nhưng variables có "group" + feed/stories.
      return (
        low.indexOf("group") !== -1 &&
        (low.indexOf("feed") !== -1 || low.indexOf("stories") !== -1)
      );
    } catch (e) {
      return false;
    }
  };

  // CHẨN ĐOÁN runtime: đối tượng thống kê đọc được từ ngoài (qua
  // chrome.scripting.executeScript world:"MAIN"). Dùng để phân biệt 2 gốc rễ
  // khi popup lấy 0 bài:
  //   - Nếu window.__FBC_GQL_HOOK__ undefined => hook KHÔNG chạy trong popup.
  //   - Nếu installed=true nhưng seen=0 => hook chạy nhưng Facebook KHÔNG bắn
  //     request /api/graphql/ nào (bị throttle / redirect login / checkpoint).
  window.__FBC_GQL_STAT__ = {
    installed: true,
    fetchPatched: false,
    xhrPatched: false,
    seen: 0,       // tổng số gói /api/graphql/ đã bắt (mọi loại, không chỉ feed)
    feedSeen: 0,   // số gói được nhận diện là feed nhóm
    buffered: 0,
    feedBuffered: 0,
    lastUrl: "",
    lastAt: 0,
  };

  // Dựng message chuẩn để phát cho content.js.
  const buildMsg = (url, reqBody, respText) => ({
    __FBC_GQL: 1,
    url: String(url || ""),
    reqBody: bodyToString(reqBody),
    // Gửi cả chunks ĐÃ parse (đỡ phải parse lại) và một mẫu text ngắn để
    // chẩn đoán khi cần. Không gửi nguyên text dài để tránh nặng bộ nhớ.
    chunks: splitChunks(respText),
    respSample: typeof respText === "string" ? respText.slice(0, 2000) : "",
    at: Date.now(),
  });

  // Gửi gói bắt được sang content.js + LƯU vào đệm để phát lại khi được yêu cầu.
  const emit = (url, reqBody, respText) => {
    try {
      const msg = buildMsg(url, reqBody, respText);
      buffer.push(msg);
      if (buffer.length > BUFFER_MAX) buffer.shift();
      // GÓI FEED NHÓM: giữ trong đệm RIÊNG để KHÔNG bị gói non-feed đẩy ra.
      // msg.reqBody đã là chuỗi urlencoded (bodyToString) nên detect inline được.
      const isFeed = isFeedBody(msg.reqBody);
      if (isFeed) {
        feedBuffer.push(msg);
        if (feedBuffer.length > FEED_BUFFER_MAX) feedBuffer.shift();
      }
      // Cập nhật stat để probe MAIN-world đọc được.
      try {
        const s = window.__FBC_GQL_STAT__;
        if (s) {
          s.seen++;
          s.buffered = buffer.length;
          s.feedBuffered = feedBuffer.length;
          if (isFeed) s.feedSeen++;
          s.lastUrl = String(url || "").slice(0, 120);
          s.lastAt = Date.now();
        }
      } catch (_) {}
      window.postMessage(msg, "*");
    } catch (e) {
      // im lặng — không làm phiền trang
    }
  };

  // ---- Vá fetch ---------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.__FBC_GQL_STAT__.fetchPatched = true;
    window.fetch = function (input, init) {
      let url = "";
      try {
        url = typeof input === "string" ? input : input && input.url ? input.url : "";
      } catch (e) {}
      const reqBody = init && init.body !== undefined ? init.body : null;
      const p = origFetch.apply(this, arguments);
      if (isGqlUrl(url)) {
        p.then((res) => {
          try {
            // clone để không "tiêu thụ" body của trang.
            res
              .clone()
              .text()
              .then((txt) => emit(url, reqBody, txt))
              .catch(() => {});
          } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ---- Vá XMLHttpRequest ------------------------------------------------
  try {
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    window.__FBC_GQL_STAT__.xhrPatched = true;

    XHR.prototype.open = function (method, url) {
      try {
        this.__fbc_url = url;
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        if (isGqlUrl(this.__fbc_url)) {
          this.addEventListener("load", () => {
            try {
              const txt = this.responseText;
              emit(this.__fbc_url, body, txt);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  } catch (e) {}

  // ---- Cổng REPLAY cho content.js --------------------------------------
  // content.js (isolated world) KHÔNG dùng chung session credential header
  // "tinh vi" của trang, nên để CHẮC CHẮN request replay giống hệt FB, ta cho
  // content.js nhờ MAIN world fetch hộ. content.js gửi:
  //   postMessage({ __FBC_GQL_REPLAY: 1, id, url, body })
  // MAIN world fetch rồi trả:
  //   postMessage({ __FBC_GQL_REPLAY_RES: 1, id, ok, chunks, error })
  // LƯU: KHÔNG check `ev.source !== window` — vì MAIN world và isolated world
  // có 2 đối tượng `window` khác nhau. Khi isolated world postMessage, ev.source
  // là isolated window còn `window` ở đây là MAIN window => check đó LUÔN
  // đúng => listener return sớm => MẤT HẾT message từ content.js. Chỉ cần
  // check ev.data có đúng "dấu hiệu" (__FBC_GQL_REPLAY) là đủ.
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;

    // (0) content.js vừa sẵn sàng => PHÁT LẠI mọi gói GraphQL đã đệm. Đây là
    // cách khắc phục đua thời điểm document_start (hook) vs document_idle
    // (content.js): gói feed FB bắn sớm sẽ không bị mất.
    if (d.__FBC_GQL_PULL === 1) {
      try {
        // PHÁT feedBuffer TRƯỚC: đảm bảo content.js nhận gói feed nhóm dù đệm
        // chung đã bị gói non-feed đẩy hết ra. Sau đó phát nốt đệm chung phòng
        // khi có gói feed lọt qua bộ nhận diện inline.
        const sent = new Set();
        for (const msg of feedBuffer) {
          sent.add(msg);
          window.postMessage(msg, "*");
        }
        for (const msg of buffer) {
          if (!sent.has(msg)) window.postMessage(msg, "*");
        }
      } catch (e) {}
      return;
    }

    if (d.__FBC_GQL_REPLAY !== 1) return;
    const id = d.id;
    const reply = (payload) =>
      window.postMessage({ __FBC_GQL_REPLAY_RES: 1, id, ...payload }, "*");
    try {
      origFetch
        .call(window, d.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-fb-friendly-name":
              d.friendly || "GroupsCometFeedRegularStoriesPaginationQuery",
          },
          body: d.body,
          credentials: "include",
        })
        .then((res) => res.text())
        .then((txt) => reply({ ok: true, chunks: splitChunks(txt) }))
        .catch((err) => reply({ ok: false, error: String(err) }));
    } catch (err) {
      reply({ ok: false, error: String(err) });
    }
  });

  try {
    console.log(
      "%c[FBC]",
      "color:#1877f2;font-weight:bold",
      "GraphQL hook đã cài (MAIN world). Đang lắng nghe /api/graphql/ …"
    );
  } catch (e) {}
})();
