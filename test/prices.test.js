/**
 * prices.test.js — Regression tests for website price normalization.
 *
 * Hura's `price` field is not canonical across stores: some shops expose the
 * build-PC promotional price there and put the real retail price in
 * `specialOffer`. These tests lock the verified DOM/API patterns so future
 * seed/source changes cannot silently regress to build-case pricing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractHuraPrices, normalizeItems, HURA_MAPPING } from "../src/prices.js";

function source(id = "hura") {
  return {
    id,
    name: id,
    url: "https://example.test/ajax/get_json.php?action=product",
    itemsPath: "list",
    mapping: HURA_MAPPING,
  };
}

test("extractHuraPrices: Nguyễn Công prefers Giá bán lẻ over Build PC", () => {
  const raw = {
    other: [
      {
        title:
          '<p><span style="font-size: 18pt;">🔹 Giá ưu đãi Build PC: <strong>9.500.000đ</strong></span><br /><span style="font-size: 18pt;">🔹 Giá bán lẻ: <span style="color: #ff6600;"><strong>10.200.000đ</strong></span></span></p>',
      },
    ],
  };

  assert.deepEqual(extractHuraPrices(raw), {
    retail: 10_200_000,
    build: 9_500_000,
  });
});

test("extractHuraPrices: Hoàng Hà ignores build-only lines and returns retail", () => {
  const raw = {
    other: [
      {
        title:
          "<p>Giá khuyến mại CPU chỉ còn 5.990.000đ áp dụng khi build PC</p><p>Giá CPU khi build máy không VGA là: 6.490.000đ</p><p>Giá bán lẻ CPU là: 6.790.000đ</p>",
      },
    ],
  };

  assert.deepEqual(extractHuraPrices(raw), {
    retail: 6_790_000,
    build: 5_990_000,
  });
});

test("normalizeItems: Hura retailOffer overwrites build-case price", () => {
  const rows = normalizeItems(
    {
      list: [
        {
          id: 1650,
          productName: "Card Màn Hình ASUS Dual GeForce RTX 3060 OC 12GB GDDR6",
          price: 9_500_000,
          marketPrice: 10_500_000,
          productUrl: "/card-man-hinh-asus-dual-geforce-rtx-3060-oc-12gb",
          specialOffer: {
            other: [
              {
                title:
                  '<p><span>🔹 Giá ưu đãi Build PC: <strong>9.500.000đ</strong></span><br /><span>🔹 Giá bán lẻ: <strong>10.200.000đ</strong></span></p>',
              },
            ],
          },
        },
      ],
    },
    source("nguyencong"),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 10_200_000);
  assert.equal(rows[0].buildPrice, 9_500_000);
});

test("normalizeItems: Hura keeps price when no labelled retail offer exists", () => {
  const rows = normalizeItems(
    {
      list: [
        {
          id: 1025,
          productName: "CPU Intel Core i5 12400F",
          price: "3799000",
          marketPrice: "4499000",
          productUrl: "/cpu-intel-core-i5-12400f",
          specialOffer: { all: [] },
        },
      ],
    },
    source("anphat"),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 3_799_000);
  assert.equal(rows[0].buildPrice, null);
});

test("normalizeItems: HACOM maps public price and build price from embedded fields", () => {
  const rows = normalizeItems(
    {
      list: [
        {
          itemCode: "CPU-7500F",
          itemName: "CPU AMD Ryzen 5 7500F",
          giaBuildPcKoVga: 3_499_000,
          unitSellingPrice: 2_999_000,
          marketPrice: 4_599_000,
          coBanLe: "Y",
          hasStock: true,
          onhandQuantity: 12,
          url: "/cpu-amd-ryzen-5-7500f",
          primaryImage: "/images/cpu-7500f.jpg",
        },
      ],
    },
    {
      id: "hacom",
      name: "HACOM",
      url: "https://hacom.vn/cpu-bo-vi-xu-ly",
      itemsPath: "list",
      mapping: {
        productId: "itemCode",
        name: "itemName",
        price: "giaBuildPcKoVga",
        priceFallback: "marketPrice",
        buildPrice: "unitSellingPrice",
        list: "marketPrice",
        brand: "brandName",
        url: "url",
        image: "primaryImage",
        stock: "onhandQuantity",
        stockFlag: "hasStock",
        retailFlag: "coBanLe",
        sku: "itemCode",
        warranty: "warrantyDescrition",
      },
    },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 3_499_000);
  assert.equal(rows[0].buildPrice, 2_999_000);
});
