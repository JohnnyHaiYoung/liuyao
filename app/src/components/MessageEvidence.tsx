'use client';

import type { MessageChartSnapshot, SseChartData, SseSourceRefData } from '@/shared/types';

/**
 * 本次回答的「盘面 + 依据」展示（阶段 4）。
 *
 * 渲染规则（安全边界）：
 *   - 只渲染**服务端给出**的字段：盘面摘要来自 SSE chart 事件或历史快照，
 *     出处链接来自服务端校验后的 SseSourceRefData.href；
 *   - 绝不解析模型正文里的 Sx 编号、磁盘路径或 URL，因此模型无法凭空造出可点击出处；
 *   - 质量为 needs_review 的来源显示「待核对」，并提供原页图入口（受控接口）。
 */
export function MessageEvidence({
  chart,
  sources,
}: {
  chart?: SseChartData | MessageChartSnapshot | null;
  sources?: SseSourceRefData[] | null;
}) {
  const chartData = chart && 'summary' in chart ? chart : null;
  const summary = chartData?.summary ?? null;
  const list = sources ?? [];

  if (!summary && list.length === 0) return null;

  return (
    <div className="message-evidence">
      {summary ? (
        <section className="evidence-chart">
          <div className="evidence-title">
            盘面（服务端计算，不可改写）
            {chartData && 'action' in chartData && chartData.action === 'follow_up' ? <span className="badge muted">沿用旧盘快照</span> : null}
          </div>
          <div className="evidence-line">
            <strong>{summary.originalHexagram}</strong>
            {summary.changedHexagram ? <> → <strong>{summary.changedHexagram}</strong></> : <span className="conversation-meta">（无变卦）</span>}
            {summary.movingPositions.length > 0 ? <span className="conversation-meta">动爻 {summary.movingPositions.join('、')}</span> : <span className="conversation-meta">六爻皆静</span>}
          </div>
          <div className="evidence-line">
            {summary.palace}
            {summary.palaceStage} · 世{summary.shiPosition} 应{summary.yingPosition}
            {summary.voidBranches.length > 0 ? <> · 旬空 {summary.voidBranches.join('')}</> : null}
          </div>
          <div className="evidence-line conversation-meta">
            {summary.dayGanzhi ? `${summary.dayGanzhi}日` : '（未提供日柱）'}
            {summary.monthBranch ? ` · ${summary.monthBranch}月` : ''}
            {summary.monthGanzhi ? ` · 月柱 ${summary.monthGanzhi}` : ''}
            {summary.castAt ? ` · 起卦 ${summary.castAt}` : ''}
            {summary.timezone ? ` · ${summary.timezone}` : ''}
            {summary.dayBoundary ? ` · 日界 ${summary.dayBoundary}` : ''}
          </div>
          {chartData && 'canonicalHash' in chartData ? (
            <div className="evidence-line conversation-meta">盘面哈希 {chartData.canonicalHash.slice(0, 16)}… · {chartData.ruleProfileVersion}</div>
          ) : null}
        </section>
      ) : null}

      {list.length > 0 ? (
        <details className="evidence-sources">
          <summary className="evidence-title">
            展开依据（{list.length} 条来源；仅服务端选中的本地资料）
          </summary>
          <ul className="evidence-list">
            {list.map((source) => (
              <li key={`${source.sid}-${source.sourceId}-${source.locatorValue ?? ''}`}>
                <span className="badge muted">{source.sid}</span>{' '}
                <a href={source.href} target="_blank" rel="noreferrer">
                  {source.label}
                </a>
                {source.qualityStatus === 'needs_review' ? <span className="badge warn">待核对（OCR/卦图转写）</span> : null}
                {source.locatorType === 'page' ? (
                  <>
                    {' '}
                    <a href={`/api/sources/${encodeURIComponent(source.sourceId)}/assets/page-${String(source.locatorValue ?? '').replace(/\D/g, '').padStart(3, '0')}.jpg`} target="_blank" rel="noreferrer">
                      原页图
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="conversation-meta">
            引用只来自服务端选中的编号；模型正文里的编号、路径或链接不会被渲染为出处。
          </div>
        </details>
      ) : null}
    </div>
  );
}
