import assert from "node:assert";
import { describe, it } from "node:test";
import { stripNul } from "./utils";

describe("stripNul", () => {
  it("removes an embedded NUL byte that PostgreSQL TEXT would reject", () => {
    assert.strictEqual(stripNul("0,Estate\u0000Name,desc"), "0,EstateName,desc");
  });

  it("removes several NUL bytes wherever they appear", () => {
    assert.strictEqual(stripNul("\u0000a\u0000b\u0000"), "ab");
  });

  it("leaves a string without NUL bytes unchanged", () => {
    const value = "0,My Estate,A nice place,ipns://hash";
    assert.strictEqual(stripNul(value), value);
  });

  it("returns an empty string unchanged", () => {
    assert.strictEqual(stripNul(""), "");
  });

  it("keeps other control and multibyte characters", () => {
    assert.strictEqual(stripNul("tab\tnew\nline \u00f1 \u4e16"), "tab\tnew\nline \u00f1 \u4e16");
  });
});
