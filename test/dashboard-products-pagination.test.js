import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  productStore,
  changeProductPage,
} from "../src/dashboard/views/products.js";

function makeProductListHost() {
  return {
    innerHTML: "",
    classList: { toggle() {} },
  };
}

beforeEach(() => {
  const productList = makeProductListHost();
  globalThis.document = {
    getElementById(id) {
      if (id === "productList") return productList;
      if (id === "prodHint") return { textContent: "" };
      return null;
    },
  };
  productStore.sources = [];
  productStore.mode = "list";
  productStore.page = 1;
  productStore.pageSize = 2;
  productStore.products = [
    { productId: "p1", name: "Product 1", source: "A", price: 100 },
    { productId: "p2", name: "Product 2", source: "A", price: 200 },
    { productId: "p3", name: "Product 3", source: "A", price: 300 },
    { productId: "p4", name: "Product 4", source: "A", price: 400 },
    { productId: "p5", name: "Product 5", source: "A", price: 500 },
  ];
});

test("changeProductPage moves forward and renders the next product slice", () => {
  const changed = changeProductPage("next");
  const html = document.getElementById("productList").innerHTML;

  assert.equal(changed, true);
  assert.equal(productStore.page, 2);
  assert.match(html, /Product 3/);
  assert.match(html, /Product 4/);
  assert.doesNotMatch(html, /Product 1/);
});

test("changeProductPage clamps at the last page", () => {
  productStore.page = 3;
  const changed = changeProductPage("next");

  assert.equal(changed, false);
  assert.equal(productStore.page, 3);
});

test("changeProductPage supports delegated pager click events", () => {
  const event = {
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
    target: {
      closest(selector) {
        assert.equal(selector, "[data-pg]");
        return { dataset: { pg: "next" }, disabled: false };
      },
    },
  };

  const changed = changeProductPage(event);

  assert.equal(changed, true);
  assert.equal(event.preventDefaultCalled, true);
  assert.equal(productStore.page, 2);
});
