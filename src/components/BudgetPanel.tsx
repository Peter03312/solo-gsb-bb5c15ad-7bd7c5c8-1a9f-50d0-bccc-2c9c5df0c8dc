import { useMemo, useState } from 'react';
import type { Project } from '../types';
import { partUnderSeconds, planRehearsalBudget } from '../lib/budget';
import { fmtSec } from '../lib/format';

interface Props {
  /** 当前工程：分配依据始终为当前覆盖，工程改动后自动重算（结果不写入工程） */
  project: Project;
}

interface BoundState {
  min: string;
  max: string;
}

/** 严格非负整数字符串：拒绝空串、小数点、负号、指数与 NaN/Infinity。 */
function parseNonNegInt(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const v = Number(t);
  return Number.isSafeInteger(v) ? v : null;
}

export default function BudgetPanel({ project }: Props) {
  const [totalText, setTotalText] = useState('30');
  /** 按声部 ID 保存用户已填过的界限；新增 / 缺省声部走默认值（min 0 / max 总预算）。 */
  const [bounds, setBounds] = useState<Map<string, BoundState>>(new Map());

  const totalParsed = parseNonNegInt(totalText);

  const under = useMemo(() => partUnderSeconds(project), [project]);

  const rows = useMemo(
    () =>
      project.parts.map((p, i) => {
        const saved = bounds.get(p.id);
        return {
          partId: p.id,
          name: p.name,
          color: p.color,
          underSeconds: under[i]?.seconds ?? 0,
          minText: saved?.min ?? '0',
          maxText: saved?.max ?? (totalParsed !== null ? String(totalParsed) : ''),
        };
      }),
    [project.parts, under, bounds, totalParsed],
  );

  const setBound = (partId: string, field: keyof BoundState, value: string) => {
    setBounds((m) => {
      const next = new Map(m);
      const cur = next.get(partId) ?? { min: '0', max: totalParsed !== null ? String(totalParsed) : '' };
      next.set(partId, { ...cur, [field]: value });
      return next;
    });
  };

  /**
   * 校验顺序：总量/界限非负整数 → 最少量不超过最多量 → 预算在两个总和之间。
   * 任一不通过都只显示原因，不展示（旧的）分配结果。
   */
  const outcome = useMemo(() => {
    if (project.parts.length === 0) {
      return { ok: false as const, message: '工程中还没有声部，请先在左侧添加声部。' };
    }
    if (totalParsed === null) {
      return { ok: false as const, message: '总分钟数必须是非负整数。' };
    }
    const parsed = rows.map((r) => ({
      partId: r.partId,
      name: r.name,
      min: parseNonNegInt(r.minText),
      max: parseNonNegInt(r.maxText),
    }));
    const bad = parsed.find((p) => p.min === null || p.max === null);
    if (bad) {
      return {
        ok: false as const,
        message: `声部「${bad.name}」的最少 / 最多分钟数必须是非负整数。`,
      };
    }
    const result = planRehearsalBudget(
      totalParsed,
      parsed.map((p) => ({ partId: p.partId, name: p.name, min: p.min!, max: p.max! })),
      rows.map((r) => r.underSeconds),
    );
    return result;
  }, [project.parts.length, totalParsed, rows]);

  const minSum = rows.reduce((acc, r) => acc + (parseNonNegInt(r.minText) ?? 0), 0);
  const maxSum = rows.reduce((acc, r) => acc + (parseNonNegInt(r.maxText) ?? 0), 0);
  const underTotal = under.reduce((acc, u) => acc + u.seconds, 0);

  return (
    <section className="optimizer budget-panel">
      <h3>⏱ 排练预算分配（按当前未达标秒数）</h3>
      <p className="hint">
        输入本次排练总分钟数与每声部最少 / 最多分钟数：先满足最少量，余量按各声部
        <b>当前未达标秒数</b>比例分配，触顶声部退出后对其余声部重新分配；未封顶声部缺口秒数全为零时等权分配，
        尾差按小数余量降序、再按声部顺序补足，<b>恰好用完预算</b>。工程改动后按当前覆盖自动重算，方案不写入工程。
      </p>

      <div className="relay-form">
        <label className="relay-field">
          <span>总预算</span>
          <input
            type="number"
            min={0}
            step={1}
            style={{ width: 72 }}
            value={totalText}
            onChange={(e) => setTotalText(e.target.value)}
          />
          <em className="relay-sep">分钟</em>
        </label>
        <span className="muted budget-range-hint">
          可行区间：各声部最少量之和 <b>{minSum}</b> ～ 最多量之和 <b>{maxSum}</b> 分钟
        </span>
      </div>

      {rows.length > 0 && (
        <table className="budget-table">
          <thead>
            <tr>
              <th>声部</th>
              <th>未达标（依据）</th>
              <th>最少（分钟）</th>
              <th>最多（分钟）</th>
              <th>分得（分钟）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const alloc = outcome.ok ? outcome.allocations.find((a) => a.partId === r.partId) : undefined;
              return (
                <tr key={r.partId}>
                  <td>
                    <span className="dot" style={{ background: r.color }} />
                    <b>{r.name}</b>
                  </td>
                  <td className={r.underSeconds > 0 ? 'budget-under' : 'ok'}>{fmtSec(r.underSeconds)}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={r.minText}
                      onChange={(e) => setBound(r.partId, 'min', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={r.maxText}
                      onChange={(e) => setBound(r.partId, 'max', e.target.value)}
                    />
                  </td>
                  <td className="budget-result">
                    {alloc ? (
                      <>
                        <b>{alloc.minutes}</b>
                        {alloc.capped && <span className="badge budget-badge">触顶</span>}
                        {alloc.remainderBonus && <span className="badge budget-badge bonus">尾差 +1</span>}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!outcome.ok ? (
        <p className="relay-error bad">⚠ {outcome.message}（修正前不显示分配结果）</p>
      ) : (
        <div className="opt-result">
          <div className="diff">
            <span>
              合计分配 <b>{outcome.total}</b> 分钟，已用完预算；全曲当前未达标合计{' '}
              <b className={underTotal > 0 ? 'bad' : 'ok'}>{fmtSec(underTotal)}</b>
            </span>
            <span className="badge ok">未写入工程</span>
          </div>
        </div>
      )}
    </section>
  );
}
