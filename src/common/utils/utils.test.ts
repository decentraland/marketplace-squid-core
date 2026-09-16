import { stripNul } from "./utils";

describe("stripNul", () => {
  it("removes an embedded NUL byte that PostgreSQL TEXT would reject", () => {
    expect(stripNul("0,Estate\u0000Name,desc")).toEqual("0,EstateName,desc");
  });

  it("removes several NUL bytes wherever they appear", () => {
    expect(stripNul("\u0000a\u0000b\u0000")).toEqual("ab");
  });

  it("leaves a string without NUL bytes unchanged", () => {
    const value = "0,My Estate,A nice place,ipns://hash";
    expect(stripNul(value)).toEqual(value);
  });

  it("returns an empty string unchanged", () => {
    expect(stripNul("")).toEqual("");
  });

  it("keeps other control and multibyte characters", () => {
    expect(stripNul("tab\tnew\nline \u00f1 \u4e16")).toEqual("tab\tnew\nline \u00f1 \u4e16");
  });
});
