import type { BeatMap, BreathAnchor, BreathInterval, Project, Singer } from '../types';
import { beatToTime, timeToBeat } from './tempo';
import { fmtSec } from './format';

const EPS = 1e-6;

/** 记录换气段当前的起止拍位（锁定时调用）。 */
export function anchorOf(interval: BreathInterval, beatMap: BeatMap): BreathAnchor {
  return { startBeat: timeToBeat(interval.start, beatMap), endBeat: timeToBeat(interval.end, beatMap) };
}

/** 清洗外部锚定数据：非对象、非有限值或终点不晚于起点一律视为未锚定（缺省）。 */
export function sanitizeAnchor(raw: unknown): BreathAnchor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const startBeat = Number(o.startBeat);
  const endBeat = Number(o.endBeat);
  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat - startBeat <= 0) {
    return undefined;
  }
  return { startBeat, endBeat };
}

/** 切换锚定状态：未锚定 → 按当前节拍图锁定起止拍位；已锚定 → 解除。 */
export function toggleBreathAnchor(breath: BreathInterval, beatMap: BeatMap): BreathInterval {
  if (breath.anchor) {
    const { anchor, ...rest } = breath;
    return rest;
  }
  return { ...breath, anchor: anchorOf(breath, beatMap) };
}

/** 手动移动 / 缩放后解除锚定（未锚定时原样返回）。 */
export function clearAnchor(breath: BreathInterval): BreathInterval {
  if (!breath.anchor) return breath;
  const { anchor, ...rest } = breath;
  return rest;
}

/** 一次锚定重算的冲突：指出冲突歌手、区间与原因。 */
export interface AnchorConflict {
  singerId: string;
  singerName: string;
  intervalId: string;
  /** 重算后的新区间（秒） */
  start: number;
  end: number;
  reason: 'bounds' | 'overlap';
  /** overlap 时：与之重叠的同歌手另一换气段（重算后的秒区间） */
  other?: { start: number; end: number };
}

export type AnchorRemapResult =
  | { ok: true; singers: Singer[]; moved: boolean }
  | { ok: false; conflicts: AnchorConflict[] };

const overlaps = (aS: number, aE: number, bS: number, bE: number) =>
  aS < bE - EPS && bS < aE - EPS;

/**
 * 按新节拍图把锚定段的两端重新换算为秒（未锚定段保持原秒位置）。
 * 若任一锚定段越出全曲 [0, duration] 或与同歌手其它换气段重叠（半开语义），
 * 返回 ok:false 与全部冲突（歌手 + 区间）——调用方必须整体拒绝本次节拍图修改，
 * 保留原节拍图与全部换气段，不得只应用部分改动。
 * moved 表示是否有锚定段的秒位置实际发生变化（用于失效基于旧位置的预览）。
 */
export function remapAnchoredBreaths(project: Project, beatMap: BeatMap): AnchorRemapResult {
  let moved = false;
  const singers = project.singers.map((s) => ({
    ...s,
    breaths: s.breaths.map((b) => {
      if (!b.anchor) return b;
      const start = beatToTime(b.anchor.startBeat, beatMap);
      const end = beatToTime(b.anchor.endBeat, beatMap);
      if (Math.abs(start - b.start) > EPS || Math.abs(end - b.end) > EPS) moved = true;
      return { ...b, start, end };
    }),
  }));

  const conflicts: AnchorConflict[] = [];
  for (const s of singers) {
    for (const b of s.breaths) {
      if (!b.anchor) continue;
      if (b.start < -EPS || b.end > project.duration + EPS) {
        conflicts.push({
          singerId: s.id,
          singerName: s.name,
          intervalId: b.id,
          start: b.start,
          end: b.end,
          reason: 'bounds',
        });
        continue;
      }
      const hit = s.breaths.find((o) => o.id !== b.id && overlaps(b.start, b.end, o.start, o.end));
      if (hit) {
        conflicts.push({
          singerId: s.id,
          singerName: s.name,
          intervalId: b.id,
          start: b.start,
          end: b.end,
          reason: 'overlap',
          other: { start: hit.start, end: hit.end },
        });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, singers, moved };
}

/** 冲突的人话描述（整体拒绝时展示）：逐条列出冲突歌手、区间与原因。 */
export function describeAnchorConflicts(conflicts: AnchorConflict[], duration: number): string {
  const lines = conflicts.map((c) => {
    const range = `[${fmtSec(c.start)}, ${fmtSec(c.end)})`;
    if (c.reason === 'bounds') return `· ${c.singerName} ${range}：越出全曲 [0, ${fmtSec(duration)})`;
    const other = c.other ? ` [${fmtSec(c.other.start)}, ${fmtSec(c.other.end)})` : '';
    return `· ${c.singerName} ${range}：与同歌手另一换气段${other}重叠`;
  });
  return [
    `无法应用本次节拍图修改：${conflicts.length} 个锚定换气段将越出全曲或与同歌手其它换气段重叠：`,
    ...lines,
    '已保留原节拍图与全部换气段，未应用任何改动。',
  ].join('\n');
}
