import { describe, expect, it } from "vitest";
import { parseTrace } from "../src/core/dbc/trace";

describe("trace 导入解析", () => {
  it("带表头 CSV：通道/id/kind/数据/时间/代次", () => {
    const csv = `channel,arb_id,kind,data,hw_time,gen
can0,0x100,std,"A0 03 41",0.1,g1
can1,0x18f001,ext,"0F A0",1.2,g2`;
    const { frames, errors } = parseTrace(csv, "f.csv");
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      channel: "can0",
      arbId: 0x100,
      kind: "std",
      data: [0xa0, 0x03, 0x41],
      hwTime: 0.1,
      gen: "g1",
      seq: 1,
    });
    expect(frames[1].kind).toBe("ext");
    expect(frames[1].arbId).toBe(0x18f001);
  });

  it("空白分隔行：index id d dlc bytes time，X 后缀=扩展", () => {
    const text = `  1   100X   d  3  0F A0 01   0.250  channel:can1 gen:g9`;
    const { frames } = parseTrace(text, "f.trc");
    expect(frames[0].arbId).toBe(0x100);
    expect(frames[0].kind).toBe("ext");
    expect(frames[0].data).toEqual([0x0f, 0xa0, 0x01]);
    expect(frames[0].hwTime).toBe(0.25);
    expect(frames[0].channel).toBe("can1");
    expect(frames[0].gen).toBe("g9");
  });

  it("注释与空行被忽略，非法字节报错", () => {
    const text = `# comment
can0,0x100,std,zz,0.1,g1`;
    const { frames, errors } = parseTrace(text, "x");
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});
