import type { DatabaseSync } from "node:sqlite";
import { decodeUnknownMessage, decodeWithMessage } from "./decode";
import {
  getMessages,
  listFrames,
  listVersions,
  replayOrder,
} from "../server/repo";
import type {
  DbcVersion,
  DecodedFrame,
  MessageDef,
  RawFrame,
} from "./types";
import { selectVersionAt } from "./version";

export interface ReplayOptions {
  /** 强制使用指定 DBC 版本（对比功能）；缺省按每帧硬件时间选生效版本。 */
  forcedVersionId?: number;
  gen?: string;
}

export function loadReplayFrames(db: DatabaseSync): RawFrame[] {
  return replayOrder(listFrames(db));
}

export function versionsFor(db: DatabaseSync): DbcVersion[] {
  return listVersions(db);
}

/**
 * 按采集时点重放：版本由半开生效区间 [from,to) 唯一确定。
 * 解码结果携带确切 bit 区间、字节序、缩放、偏置、枚举与 mux 分支证据。
 */
export function replay(db: DatabaseSync, opts: ReplayOptions = {}): DecodedFrame[] {
  const versions = listVersions(db);
  const messagesByVersion = new Map<number, MessageDef[]>();
  for (const v of versions) messagesByVersion.set(v.id, getMessages(db, v.id));

  let frames = loadReplayFrames(db);
  if (opts.gen) frames = frames.filter((f) => f.gen === opts.gen);

  return frames.map((frame) => {
    let version: DbcVersion | null;
    if (opts.forcedVersionId !== undefined) {
      version = versions.find((v) => v.id === opts.forcedVersionId) ?? null;
      if (!version) {
        throw new Error(`DBC 版本 ${opts.forcedVersionId} 不存在`);
      }
    } else {
      version = selectVersionAt(versions, frame.hwTime);
    }

    if (!version) {
      return decodeUnknownMessage(frame, -1, "无生效 DBC 版本");
    }
    const msg = (messagesByVersion.get(version.id) ?? []).find(
      (m) => m.arbId === frame.arbId && m.kind === frame.kind,
    );
    if (!msg) return decodeUnknownMessage(frame, version.id, version.name);
    return decodeWithMessage(frame, msg, version.id, version.name);
  });
}

/** 某条已解码结果在“当前 DBC 集合”下是否过期（其版本不再覆盖该帧时间或已非同一定义）。 */
export function isDecodeStale(
  db: DatabaseSync,
  decoded: Pick<DecodedFrame, "dbcVersionId" | "frameId" | "arbId" | "kind" | "hwTime">,
): boolean {
  const versions = listVersions(db);
  const current = selectVersionAt(versions, decoded.hwTime);
  if (!current) return true;
  return current.id !== decoded.dbcVersionId;
}

export function decodeSingle(db: DatabaseSync, frameId: number, versionId?: number): DecodedFrame | null {
  const all = replay(db, versionId !== undefined ? { forcedVersionId: versionId } : {});
  return all.find((f) => f.frameId === frameId) ?? null;
}
