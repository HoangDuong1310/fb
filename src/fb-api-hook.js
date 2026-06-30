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

  // Gửi gói bắt được sang content.js.
  const emit = (url, reqBody, respText) => {
    try {
      const chunks = splitChunks(respText);
      window.postMessage(
        {
          __FBC_GQL: 1,
          url: String(url || ""),
          reqBody: bodyToString(reqBody),
          // Gửi cả chunks ĐÃ parse (đỡ phải parse lại) và một mẫu text ngắn để
          // chẩn đoán khi cần. Không gửi nguyên text dài để tránh nặng bộ nhớ.
          chunks,
          respSample: typeof respText === "string" ? respText.slice(0, 2000) : "",
          at: Date.now(),
        },
        "*"
      );
    } catch (e) {
      // im lặng — không làm phiền trang
    }
  };

  // ---- Vá fetch ---------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
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
    if (!d || typeof d !== "object" || d.__FBC_GQL_REPLAY !== 1) return;
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
