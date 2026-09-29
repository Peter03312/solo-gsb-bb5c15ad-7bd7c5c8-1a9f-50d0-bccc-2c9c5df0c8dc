import type { Project } from '../types';
import { partUnder, totalSeconds } from './coverage';

const EPS = 1e-9;

/** 一个声部的排练分钟预算输入界限。 */
export interface BudgetPart {
  partId: string;
  name: string;
  /** 该声部最少分钟数（非负整数） */
  min: number;
  /** 该声部最多分钟数（非负整数，且 ≥ min） */
  max: number;
}

/** 某声部分得的排练分钟数及作为依据的当前未达标秒数。 */
export interface BudgetAllocation {
  partId: string;
  name: string;
  /** 作为分配依据的未达标秒数（当前工程实时计算） */
  underSeconds: number;
  /** 分得的整数分钟数（所有声部合计恰好用完总预算） */
  minutes: number;
  min: number;
  max: number;
  /** 是否在余量重分配过程中触顶（minutes === max） */
  capped: boolean;
  /** 是否在尾差阶段因小数余量较大而补到一分钟 */
  remainderBonus: boolean;
}

export type BudgetErrorCode = 'empty' | 'invalid' | 'min-gt-max' | 'total-below-min' | 'total-above-max';

export interface BudgetFailure {
  ok: false;
  error: BudgetErrorCode;
  message: string;
}

export interface BudgetSuccess {
  ok: true;
  total: number;
  allocations: BudgetAllocation[];
}

export type BudgetResult = BudgetSuccess | BudgetFailure;

/** 各声部当前未达标总秒数（半开区间合并后），按 parts 顺序返回。 */
export function partUnderSeconds(project: Project): { partId: string; name: string; seconds: number }[] {
  return project.parts.map((p) => ({
    partId: p.id,
    name: p.name,
    seconds: totalSeconds(partUnder(project, p.id)),
  }));
}

const isNonNegInt = (v: number) => Number.isSafeInteger(v) && v >= 0;

/**
 * 排练前整数分钟预算分配。
 *
 * 规则：
 * 1. 先满足每个声部的最少量 min；
 * 2. 余量按各声部「未达标秒数」比例在未触顶声部间分配，达到上限 max 的声部退出，
 *    随后对其余声部按新比例重新分配（水填充，每声部保留此前累计）；
 * 3. 当前未封顶声部的缺口秒数全为零时，余量在这些声部间等权分配；
 * 4. 最后不足整分钟的尾差按小数余量降序、再按声部当前顺序（入参数组顺序）补足，
 *    直至恰好用完预算。
 *
 * total / min / max 须为非负整数、min ≤ max、Σmin ≤ total ≤ Σmax，
 * 否则返回带原因的失败结果。
 */
export function planRehearsalBudget(total: number, parts: BudgetPart[], underSeconds: number[]): BudgetResult {
  if (parts.length === 0) {
    return { ok: false, error: 'empty', message: '工程中还没有声部，无法分配排练预算。' };
  }
  if (!isNonNegInt(total) || parts.some((p) => !isNonNegInt(p.min) || !isNonNegInt(p.max))) {
    return {
      ok: false,
      error: 'invalid',
      message: '总分钟数与每声部最少 / 最多分钟数都必须是非负整数。',
    };
  }
  const badOrder = parts.findIndex((p) => p.min > p.max);
  if (badOrder >= 0) {
    return {
      ok: false,
      error: 'min-gt-max',
      message: `声部「${parts[badOrder].name}」的最少量（${parts[badOrder].min} 分钟）多于最多量（${parts[badOrder].max} 分钟）。`,
    };
  }
  const minSum = parts.reduce((acc, p) => acc + p.min, 0);
  if (total < minSum) {
    return {
      ok: false,
      error: 'total-below-min',
      message: `总预算 ${total} 分钟不足以满足各声部最少量之和（${minSum} 分钟）。`,
    };
  }
  const maxSum = parts.reduce((acc, p) => acc + p.max, 0);
  if (total > maxSum) {
    return {
      ok: false,
      error: 'total-above-max',
      message: `总预算 ${total} 分钟超过各声部最多量之和（${maxSum} 分钟），无法在不突破上限的情况下用完。`,
    };
  }

  const n = parts.length;
  const weights = parts.map((_, i) => Math.max(0, underSeconds[i] ?? 0));
  // 连续分配量 = minutes[i] + fraction[i]（fraction 可超过 1，水填充期间不取整）
  const minutes = parts.map((p) => p.min);
  const fraction = new Array<number>(n).fill(0);
  const capped = new Array<boolean>(n).fill(false);

  let active = parts.map((_, i) => i);
  let remainder = total - minSum;

  // 水填充：每轮把余量按当前比例摊给未触顶声部，最先触顶者退出后重算比例。
  while (remainder > EPS && active.length > 0) {
    const weightSum = active.reduce((acc, i) => acc + weights[i], 0);
    const ratioOf = (i: number) => (weightSum > 0 ? weights[i] / weightSum : 1 / active.length);

    // 让某声部恰好触顶需要花掉的全局余量（比例为 0 时永不触顶）
    let spend = remainder;
    for (const i of active) {
      const ratio = ratioOf(i);
      if (ratio <= 0) continue;
      const need = (parts[i].max - (minutes[i] + fraction[i])) / ratio;
      if (need < spend) spend = need;
    }
    for (const i of active) fraction[i] += spend * ratioOf(i);
    remainder -= spend;

    const next: number[] = [];
    for (const i of active) {
      if (minutes[i] + fraction[i] >= parts[i].max - EPS) {
        capped[i] = true;
        minutes[i] = parts[i].max;
        fraction[i] = 0;
      } else {
        next.push(i);
      }
    }
    active = next;
  }

  // 最终取整：未触顶声部各拿整数部分，尾差按小数余量降序、声部顺序升序逐分钟补足。
  const fractionalParts: { i: number; frac: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (capped[i]) continue;
    const whole = Math.floor(fraction[i] + EPS);
    minutes[i] += whole;
    const frac = fraction[i] - whole;
    fractionalParts.push({ i, frac: frac < 0 ? 0 : frac });
  }
  let leftover = total - minutes.reduce((a, b) => a + b, 0);
  const order = fractionalParts.slice().sort((a, b) => b.frac - a.frac || a.i - b.i);
  const bonus = new Set<number>();
  for (let k = 0; k < leftover; k++) {
    if (k >= order.length) break; // 理论上不会发生（total ≤ Σmax 保证有名额）
    const i = order[k].i;
    minutes[i] += 1;
    bonus.add(i);
  }

  // 浮点保险：正常不会触发，确保结果恰好用完预算且不突破上限。
  let guard = 0;
  while (minutes.reduce((a, b) => a + b, 0) < total && guard <= n) {
    const i = minutes.findIndex((m, idx) => m < parts[idx].max);
    if (i < 0) break;
    minutes[i] += 1;
    guard++;
  }

  return {
    ok: true,
    total,
    allocations: parts.map((p, i) => ({
      partId: p.partId,
      name: p.name,
      underSeconds: weights[i],
      minutes: minutes[i],
      min: p.min,
      max: p.max,
      capped: capped[i],
      remainderBonus: bonus.has(i),
    })),
  };
}
