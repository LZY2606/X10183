import { describe, expect, it } from "vitest";
import { rangesOverlap, selectVersionAt, versionCovers } from "../src/core/version";

const v1 = { id: 1, name: "v1", effectiveFrom: 0, effectiveTo: 10, sourceText: "", importedAt: 0 };
const v2 = { id: 2, name: "v2", effectiveFrom: 10, effectiveTo: null, sourceText: "", importedAt: 0 };

describe("DBC 生效端点：半开 [from,to)", () => {
  it("to 端点不包含，from 端点包含", () => {
    expect(versionCovers(v1, 0)).toBe(true);
    expect(versionCovers(v1, 9.999)).toBe(true);
    expect(versionCovers(v1, 10)).toBe(false);
    expect(versionCovers(v2, 10)).toBe(true);
    expect(versionCovers(v2, 1e9)).toBe(true);
  });

  it("采集时点唯一定位版本", () => {
    expect(selectVersionAt([v1, v2], 5)?.id).toBe(1);
    expect(selectVersionAt([v1, v2], 10)?.id).toBe(2);
    expect(selectVersionAt([v1, v2], -1)).toBeNull();
  });

  it("区间重叠判定（含开放端）", () => {
    expect(rangesOverlap({ effectiveFrom: 0, effectiveTo: 10 }, { effectiveFrom: 10, effectiveTo: null })).toBe(false);
    expect(rangesOverlap({ effectiveFrom: 0, effectiveTo: 10 }, { effectiveFrom: 9, effectiveTo: null })).toBe(true);
    expect(rangesOverlap({ effectiveFrom: 0, effectiveTo: null }, { effectiveFrom: 100, effectiveTo: 200 })).toBe(true);
  });
});
