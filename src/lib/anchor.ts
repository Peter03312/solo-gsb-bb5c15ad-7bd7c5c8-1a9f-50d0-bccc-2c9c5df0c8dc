import type { BeatMap, Project } from '../types';
import { beatToTime, normalizeBeatMap, timeToBeat } from './tempo';

const EPS = 1e-6;

/** 节拍图重算冲突：越出全曲或与同歌手其它换气段重叠。 */
export interface AnchorConflict {
  singerId: string;
  singerName: string;
  intervalId: string;
  /** 重算后该段的区间（秒，半开） */
  start: number;
  end: number;
  kind: 'bounds' | 'overlap';
  /** overlap 时与之相撞的另一段（秒，半开） */
  other?: { id: string; start: number; end: number };
}

export type BeatMapEditResult =
  | { ok: true; project: Project; /** 是否有锚定段因重算实际移动了位置 */ movedAnchors: boolean }
  | { ok: false; conflicts: AnchorConflict[] };

/**
 * 应用一次节拍图修改：
 * - 锚定（anchored）换气段的两端先按旧节拍图换算回拍位，再按新节拍图换算为秒，
 *   即锁定在原起止拍位；未锚定段保持原秒位置；
 * - 若重算使任一段越出 [0, duration] 或与同歌手其它换气段（半开）重叠，
 *   拒绝本次修改：返回冲突列表，原工程（原节拍图与全部换气段）保持不变；
 * - 成功时返回新工程与「锚定段是否实际位移」标志（实际位移时调用方应清除
 *   基于旧位置的寻优预览）。
 */
export function applyBeatMapChange(project: Project, next: Partial<BeatMap>): BeatMapEditResult {
  const oldMap = project.beatMap;
  const newMap = normalizeBeatMap({ ...oldMap, ...next });

  let movedAnchors = false;
  /** 每位歌手重算后的换气段（保持原顺序）。 */
  const nextSingers = project.singers.map((singer) => ({
    singer,
    breaths: singer.breaths.map((b) => {
      if (!b.anchored) return b;
      const startBeat = timeToBeat(b.start, oldMap);
      const endBeat = timeToBeat(b.end, oldMap);
      const start = beatToTime(startBeat, newMap);
      const end = beatToTime(endBeat, newMap);
      if (Math.abs(start - b.start) > EPS || Math.abs(end - b.end) > EPS) movedAnchors = true;
      return { ...b, start, end };
    }),
  }));

  const conflicts: AnchorConflict[] = [];
  const push = (c: AnchorConflict) => {
    const dup = conflicts.some(
      (x) => x.intervalId === c.intervalId && x.kind === c.kind && x.other?.id === c.other?.id,
    );
    if (!dup) conflicts.push(c);
  };

  for (const { singer, breaths } of nextSingers) {
    const before = singer.breaths;
    for (let i = 0; i < breaths.length; i++) {
      const b = breaths[i];
      const oldB = before[i];
      // 越界检查（未锚定段秒位置不变，原本就在界内；这里对所有段统一校验）
      if (b.start < -EPS || b.end > project.duration + EPS) {
        push({
          singerId: singer.id,
          singerName: singer.name,
          intervalId: b.id,
          start: Math.max(0, b.start),
          end: Math.min(project.duration, b.end),
          kind: 'bounds',
        });
      }
      // 重叠检查：仅报告本次重算新引入的重叠（编辑约束保证正常数据本不重叠）
      for (let j = i + 1; j < breaths.length; j++) {
        const o = breaths[j];
        const oldO = before[j];
        const nowOverlap =
          b.start < o.end - EPS && o.start < b.end - EPS;
        if (!nowOverlap) continue;
        const wasOverlap =
          oldB.start < oldO.end - EPS && oldO.start < oldB.end - EPS;
        if (wasOverlap) continue;
        // 至少一侧是锚定段（未锚定段不动，不可能新撞）；锚定侧各自生成一条冲突
        if (b.anchored) {
          push({
            singerId: singer.id,
            singerName: singer.name,
            intervalId: b.id,
            start: b.start,
            end: b.end,
            kind: 'overlap',
            other: { id: o.id, start: o.start, end: o.end },
          });
        }
        if (o.anchored) {
          push({
            singerId: singer.id,
            singerName: singer.name,
            intervalId: o.id,
            start: o.start,
            end: o.end,
            kind: 'overlap',
            other: { id: b.id, start: b.start, end: b.end },
          });
        }
      }
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  return {
    ok: true,
    movedAnchors,
    project: { ...project, beatMap: newMap, singers: nextSingers.map(({ singer, breaths }) => ({ ...singer, breaths })) },
  };
}

/** 把重算冲突格式化为给指挥看的拒绝提示：指出冲突歌手与区间（秒，半开）。 */
export function formatAnchorConflicts(conflicts: AnchorConflict[]): string {
  const sec = (v: number) => `${Math.round(v * 100) / 100}s`;
  const lines = conflicts.map((c) => {
    const range = `[${sec(c.start)}, ${sec(c.end)})`;
    if (c.kind === 'bounds') return `· ${c.singerName} ${range} 重算后越出全曲`;
    return `· ${c.singerName} ${range} 与同歌手换气段 [${sec(c.other!.start)}, ${sec(c.other!.end)}) 重叠`;
  });
  return `节拍图修改被拒绝：以下换气段锁定在原拍位，按新节拍图重算后发生冲突，原节拍图与全部换气段保持不变：\n${lines.join('\n')}`;
}

/** 设置换气段的锚定状态（指挥把选中段锁定 / 解锁在当前起止拍位）。 */
export function setIntervalAnchored(
  project: Project,
  singerId: string,
  intervalId: string,
  anchored: boolean,
): Project {
  return {
    ...project,
    singers: project.singers.map((s) =>
      s.id !== singerId
        ? s
        : {
            ...s,
            breaths: s.breaths.map((b) => (b.id !== intervalId ? b : { ...b, anchored })),
          },
    ),
  };
}
