/**
 * 盘面摘要（阶段 4）：SSE 的 chart 事件与历史回看必须给出**同一份**摘要。
 *
 * 单一实现避免"实时事件"与"历史读取"两处各写一遍导致漂移。
 */
import type { SseChartData } from '@/shared/types';

export interface ChartSummaryMeta {
  chartRunId: string;
  canonicalHash: string;
  ruleProfileVersion: string;
  coreVersion: string;
  action: 'new' | 'follow_up';
}

type ChartLike = {
  chart: {
    original: { name: string };
    changed: { name: string } | null;
    palace: { name: string; stage: string };
    shiPosition: number;
    yingPosition: number;
    voidBranches: [string, string] | null;
  };
  input: { movingPositions: number[] };
  calendar: {
    dayGanzhi?: string;
    monthBranch?: string;
    monthGanzhi?: string;
    localCivilTime?: string;
    timezone?: string;
    dayBoundary?: string;
  } | null;
};

export function summarizeChart(chart: ChartLike): SseChartData['summary'] {
  return {
    originalHexagram: chart.chart.original.name,
    changedHexagram: chart.chart.changed?.name ?? null,
    movingPositions: chart.input.movingPositions,
    palace: `${chart.chart.palace.name}宫`,
    palaceStage: chart.chart.palace.stage,
    shiPosition: chart.chart.shiPosition,
    yingPosition: chart.chart.yingPosition,
    dayGanzhi: chart.calendar?.dayGanzhi ?? null,
    monthBranch: chart.calendar?.monthBranch ?? null,
    monthGanzhi: chart.calendar?.monthGanzhi ?? null,
    voidBranches: chart.chart.voidBranches ?? [],
    castAt: chart.calendar?.localCivilTime ?? null,
    timezone: chart.calendar?.timezone ?? null,
    dayBoundary: chart.calendar?.dayBoundary ?? null,
  };
}

/** 由快照里的 canonical JSON 还原摘要（历史回看不重算）。 */
export function summarizeStoredChart(chartJson: string, meta: ChartSummaryMeta): SseChartData | null {
  try {
    const parsed = JSON.parse(chartJson) as ChartLike;
    if (!parsed?.chart?.original) return null;
    return {
      action: meta.action,
      chartRunId: meta.chartRunId,
      canonicalHash: meta.canonicalHash,
      ruleProfileVersion: meta.ruleProfileVersion,
      coreVersion: meta.coreVersion,
      summary: summarizeChart(parsed),
    };
  } catch {
    return null;
  }
}
