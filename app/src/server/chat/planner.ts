/**
 * 编排层：计划对象与意图判定（阶段 4 任务书第 3、4、5 节）
 *
 * 原则：
 *   - 最终选页、文件读取、排盘调用与预算**都由服务端执行**；模型不选文件、不传路径、不确认爻值；
 *   - 含糊时优先追问，不开启无界自动工具循环；
 *   - 计划对象可落库（messages.plan_json），便于事后审计"当时为什么这样选"。
 */
import { selectWikiEvidence, type SelectResult } from '../wiki/select.ts';
import type { WikiCatalog } from '../wiki/catalog.ts';
import { createChartRun, extractChartInputFromText, type ChartInput, type ChartRunResult } from '../chart/service.ts';

export type Intent = 'general' | 'concept' | 'source_comparison' | 'chart' | 'chart_follow_up';
export type ChartAction = 'none' | 'new' | 'follow_up';

export interface PlanObject {
  intent: Intent;
  chartAction: ChartAction;
  selectedPageIds: string[];
  selectedSids: string[];
  missingInputs: string[];
  reasons: string[];
  ambiguities: string[];
  budgetExceeded: boolean;
  promptVersion: string;
  /** 追问时绑定的旧盘 id（只读快照，不重算） */
  followUpChartRunId: string | null;
  chartError: { code: string; message: string } | null;
  /**
   * 本地澄清的种类（复验报告 8dd1c09）：`missing_inputs` = 缺排盘输入；
   * `learn_or_cast` = "请教我用六爻起卦"这类既可理解为学习方法、也可理解为现在起卦的歧义问法。
   */
  clarificationKind?: 'missing_inputs' | 'learn_or_cast';
}

export interface PlanTurnParams {
  question: string;
  projectRoot: string;
  catalog: WikiCatalog;
  /** 前端可选的结构化输入（非强制）；优先于文本提取 */
  chartInput?: ChartInput | null;
  /** 会话当前盘（用于追问）；没有则追问时只能请用户补输入 */
  currentChartRunId?: string | null;
  /** 用户明确要求"另起一卦/新卦" */
  explicitNewChart?: boolean;
  promptVersion: string;
}

export interface PlanTurnResult {
  plan: PlanObject;
  wiki: SelectResult;
  chart: ChartRunResult | null;
}

const FOLLOW_UP_MARKERS = ['这卦', '这个卦', '此卦', '该卦', '刚才那卦', '刚起的卦', '上面那卦', '这盘', '这个盘', '沿用', '还是这卦'];
const NEW_CHART_MARKERS = ['新卦', '另起', '重新起卦', '再起一卦', '另问一事', '另外一卦'];
/**
 * 第一层：**起卦动作识别**（先判断用户是不是在要求执行起卦/看具体卦）。
 *
 * 复验报告（3544422）P1 指出：不能再用"整句里方法词与比较词的距离"去否决明确的起卦动作，
 * 否则「请用六爻帮我起卦，比较两份工作机会」会因句中出现"六爻…比较"而被判成资料比较。
 * 因此这里用**动作结构**判定：允许"请/麻烦/帮我/替我/给我/我要/我想/求/另/再/重新/用X/以X"
 * 等修饰出现在动作词之前（最多 3 段、每段不超过 6 字），动作词包括"起卦/起一卦/摇卦/看一卦…"。
 * 与此同时保留若干**本身就是请求**的强动作词（不含裸"起卦"，避免"起卦和断卦的区别"被误判）。
 */
const CAST_MODIFIERS = '请|麻烦|帮我|帮|替我|给我|我要|我想|我求|求|另|再|重新|用[^，。；！？]{0,4}|以[^，。；！？]{0,4}|通过[^，。；！？]{0,4}';
const CAST_ACTION_WORDS = '起卦|起一卦|摇卦|摇一卦|占一卦|卜一卦|看一卦|看卦|看这卦|看下卦|断一卦|排一卦|算一卦|求一卦';
const CAST_ACTION_PATTERN = new RegExp(`(?:${CAST_MODIFIERS})[^，。；！？]{0,6}(?:${CAST_ACTION_WORDS})`);
/** 不含裸「起卦」的强动作词：出现即视为请求。 */
const CAST_STRONG_ACTIONS = ['起一卦', '摇一卦', '占一卦', '卜一卦', '看一卦', '摇卦', '排一卦', '算一卦', '求一卦', '看这卦'];

/**
 * 第二层：**方法/知识类问法**（只有在没有起卦动作时才用于分类）。
 * 依旧要求"比较/区别/是什么…"与方法术语邻近，避免把现实对象当成知识体系比较。
 */
const METHOD_TERMS = '梅花|六爻|断卦|起卦法|起卦方式|易数|纳甲|用神|流派|断法|卦理|体系|方法|资料|Wiki';
const METHOD_COMPARISON_PATTERN = new RegExp(
  `(?:${METHOD_TERMS})[^。；！？]{0,8}(?:比较|区别|差异|是什么|怎么理解|如何理解|原理|介绍一下)` +
    `|(?:比较|区别|差异|什么是|是什么意思|怎么理解|如何理解|介绍一下)[^。；！？]{0,8}(?:${METHOD_TERMS})`,
);

/**
 * 第三层：**知识/学法问法**（复验报告 8dd1c09 P1 的反向假阳性）。
 *
 * 报告指出：只要句中含起卦词就当成请求，会把「我想了解六爻起卦的方法」「请介绍一下如何用六爻起卦」
 * 「帮我解释六爻起卦的步骤」「算一卦和排一卦有什么区别？」误判为排盘请求。
 * 因此判定的是**用户当前要执行的动作**：先看有没有"现在替我起卦"的祈使（帮我/请帮我/替我/给我…），
 * 再看起卦词是否只是被"了解/介绍/解释/如何/步骤/方法/区别"等词所谈论的对象。
 */
const KNOWLEDGE_VERBS = '了解|介绍|解释|讲解|说明|学习|想学|教我|怎么|如何|怎样|咋样|步骤|流程|原理|区别|差异|比较|是什么|什么意思|含义|用法|方法';
/** 祈使：明确要求"现在替我起卦"。中间若夹了知识动词（如"帮我解释…起卦"）则不算祈使。 */
const REQUEST_IMPERATIVE_PATTERN = new RegExp(
  `(?:帮我|请帮|替我|给我|麻烦|帮忙)(?:(?!(?:${KNOWLEDGE_VERBS}))[^。；！？]){0,6}(?:${CAST_ACTION_WORDS})`,
);
/** 知识动词直接谈论起卦动作（如"了解六爻起卦""解释六爻起卦的步骤"）。 */
const KNOWLEDGE_ABOUT_CAST_PATTERN = new RegExp(`(?:${KNOWLEDGE_VERBS})[^。；！？]{0,8}(?:${CAST_ACTION_WORDS})`);
/** 起卦词之后紧跟比较/定义词（如"算一卦和排一卦有什么区别"）。 */
const CAST_THEN_KNOWLEDGE_PATTERN = new RegExp(`(?:${CAST_ACTION_WORDS})[^。；！？]{0,8}(?:区别|差异|比较|是什么|什么意思|含义)`);
/** "请教/教我"这类学法问法：既可理解为学习方法，也可理解为现在起卦 → 只问一句澄清。 */
const AMBIGUOUS_TEACH_PATTERN = new RegExp(`(?:请教|教我|教教)[^。；！？]{0,8}(?:${CAST_ACTION_WORDS})`);

export function planTurn(params: PlanTurnParams): PlanTurnResult {
  const question = String(params.question ?? '');
  const reasons: string[] = [];

  // 1) 服务端选页（永远执行；无命中就是无命中，不伪造来源）
  const wiki = selectWikiEvidence(params.projectRoot, params.catalog, question);
  for (const page of wiki.selectedPages) reasons.push(`选中 ${page.path}（${page.reason}）`);

  // 2) 排盘输入：显式结构化输入优先，其次从文本保守提取
  const extraction = extractChartInputFromText(question);
  const merged: ChartInput = {
    lineValues: params.chartInput?.lineValues ?? extraction.lineValues,
    mode: params.chartInput?.mode ?? 'none',
    castAt: params.chartInput?.castAt ?? extraction.castAt,
    timezone: params.chartInput?.timezone ?? extraction.timezone,
    dayBoundary: params.chartInput?.dayBoundary ?? null,
    dayGanzhi: params.chartInput?.dayGanzhi ?? extraction.dayGanzhi,
    monthBranch: params.chartInput?.monthBranch ?? extraction.monthBranch,
    sourceInput: question,
  };
  const hasAnyChartInput = Boolean(merged.lineValues || merged.castAt || merged.dayGanzhi || merged.monthBranch);
  const wantsFollowUp = FOLLOW_UP_MARKERS.some((marker) => question.includes(marker));
  const wantsNewChart = params.explicitNewChart === true || NEW_CHART_MARKERS.some((marker) => question.includes(marker));

  if (extraction.ambiguities.length > 0) reasons.push(...extraction.ambiguities.map((item) => `提取含糊：${item}`));

  // 3) 是否沿用旧盘：明确追问旧盘、且没有给出新的一组完整输入
  const hasCompleteInput = Boolean(merged.lineValues) && Boolean(merged.mode === 'manual_calendar' ? merged.dayGanzhi && merged.monthBranch : merged.castAt && merged.timezone);
  if (wantsFollowUp && !wantsNewChart && !hasCompleteInput) {
    const followUpChartRunId = params.currentChartRunId ?? null;
    const missingInputs: string[] = followUpChartRunId ? [] : ['chart'];
    reasons.push(
      followUpChartRunId
        ? `识别为旧盘追问，沿用快照 ${followUpChartRunId}（不重算）`
        : '识别为旧盘追问，但会话没有已保存的盘面，需要用户给出起卦输入',
    );
    return {
      plan: {
        intent: 'chart_follow_up',
        chartAction: followUpChartRunId ? 'follow_up' : 'none',
        selectedPageIds: wiki.selectedPages.map((page) => page.pageId),
        selectedSids: wiki.snippets.filter((item) => item.citable).map((item) => item.sid),
        missingInputs,
        reasons,
        ambiguities: extraction.ambiguities,
        budgetExceeded: wiki.budgetExceeded,
        promptVersion: params.promptVersion,
        followUpChartRunId,
        chartError: null,
      },
      wiki,
      chart: null,
    };
  }

  // 3.5) 起卦/新卦请求但**完全没有输入**：只澄清，不调用模型（任务书第 2 节）。
  // 复验报告 P1-1：先前只在已提取到爻值/历法时才走缺项检查，导致"帮我起卦""另起一卦""请帮我看卦"
  // 会直接进入模型回答。这里补上起卦意图分支，并排除"比较/概念"类问法（例如"梅花起卦与六爻断卦怎么比较"）。
  // 先识别"用户当前要执行的动作"：是"现在替我起卦"，还是在问"怎样起卦"（复验报告 8dd1c09 P1）
  const hasCastAction = CAST_ACTION_PATTERN.test(question) || CAST_STRONG_ACTIONS.some((marker) => question.includes(marker));
  const hasRequestImperative = REQUEST_IMPERATIVE_PATTERN.test(question);
  const knowledgeAboutCast = KNOWLEDGE_ABOUT_CAST_PATTERN.test(question);
  const castThenKnowledge = CAST_THEN_KNOWLEDGE_PATTERN.test(question);
  const asksToBeTaught = AMBIGUOUS_TEACH_PATTERN.test(question);
  const looksLikeMethodQuestion = METHOD_COMPARISON_PATTERN.test(question);
  // 知识问答：在谈论起卦这件事（学习方法/步骤/术语差别），且没有"现在替我起卦"的祈使
  const isKnowledgeQuestion =
    !hasRequestImperative && (knowledgeAboutCast || castThenKnowledge || looksLikeMethodQuestion);
  // 歧义："请教我用六爻起卦" —— 只问一句"学习方法还是现在起卦"，不索取排盘输入
  const isAmbiguousLearnOrCast = asksToBeTaught && !hasRequestImperative;
  const wantsCast = hasCastAction && !isKnowledgeQuestion && !isAmbiguousLearnOrCast;

  if (isAmbiguousLearnOrCast && !hasAnyChartInput && !wantsNewChart) {
    reasons.push('「请教/教我 + 起卦」既可理解为学习方法、也可理解为现在起卦：先问一句澄清，不调用模型');
    return {
      plan: {
        intent: 'general',
        chartAction: 'none',
        selectedPageIds: wiki.selectedPages.map((page) => page.pageId),
        selectedSids: wiki.snippets.filter((item) => item.citable).map((item) => item.sid),
        missingInputs: [],
        reasons,
        ambiguities: extraction.ambiguities,
        budgetExceeded: wiki.budgetExceeded,
        promptVersion: params.promptVersion,
        followUpChartRunId: null,
        chartError: null,
        clarificationKind: 'learn_or_cast',
      },
      wiki,
      chart: null,
    };
  }

  if ((wantsCast || (wantsNewChart && !isKnowledgeQuestion)) && !hasAnyChartInput) {
    reasons.push(
      wantsNewChart
        ? '识别为"另起一卦"请求，但没有新的爻值/时间输入：先澄清，不调用模型'
        : '识别为"现在替我起卦"的请求，但缺少六爻与时间输入：先澄清，不调用模型',
    );
    return {
      plan: {
        intent: 'chart',
        chartAction: 'none',
        selectedPageIds: wiki.selectedPages.map((page) => page.pageId),
        selectedSids: wiki.snippets.filter((item) => item.citable).map((item) => item.sid),
        missingInputs: ['lineValues', 'castTime', 'timezone'],
        reasons,
        ambiguities: extraction.ambiguities,
        budgetExceeded: wiki.budgetExceeded,
        promptVersion: params.promptVersion,
        followUpChartRunId: null,
        chartError: null,
        clarificationKind: 'missing_inputs',
      },
      wiki,
      chart: null,
    };
  }

  // 4) 新建盘面（完整输入才调用；否则只追问缺项）
  let chart: ChartRunResult | null = null;
  let chartAction: ChartAction = 'none';
  let missingInputs: string[] = [];
  if (hasAnyChartInput || (hasCompleteInput && wantsNewChart)) {
    const result = createChartRun(merged);
    if (result.ok) {
      chart = result;
      chartAction = 'new';
      reasons.push(`服务端排盘成功：${result.chart.chart.original.name}，哈希 ${result.canonicalHash.slice(0, 12)}…`);
    } else {
      chart = result;
      missingInputs = result.missingInputs;
      reasons.push(`排盘未完成：${result.errorCode}`);
    }
  }

  const pageIds = wiki.selectedPages.map((page) => page.pageId);
  const isComparison = pageIds.some((id) => id.startsWith('comparison:'));
  const isConcept = pageIds.some((id) => id.startsWith('concept:'));
  const intent: Intent = chart && chart.ok ? 'chart' : chartAction === 'new' || missingInputs.length > 0 ? 'chart' : isComparison ? 'source_comparison' : isConcept ? 'concept' : 'general';

  return {
    plan: {
      intent,
      chartAction,
      selectedPageIds: pageIds,
      selectedSids: wiki.snippets.filter((item) => item.citable).map((item) => item.sid),
      missingInputs,
      reasons,
      ambiguities: extraction.ambiguities,
      budgetExceeded: wiki.budgetExceeded,
      promptVersion: params.promptVersion,
      followUpChartRunId: null,
      chartError: chart && !chart.ok ? { code: chart.errorCode, message: chart.message } : null,
    },
    wiki,
    chart,
  };
}

/** 缺项追问文本由本地逻辑生成（不经模型），保证措辞不会被上游改写。 */
export function buildMissingInputReply(plan: PlanObject): string | null {
  // 歧义问法（"请教我用六爻起卦"）：只问一句"学习方法还是现在起卦"，**不**索取排盘输入
  if (plan.clarificationKind === 'learn_or_cast') {
    return [
      '你的问题有两种理解，先确认一下：',
      '',
      '- 想**学习方法**：我可以讲起卦的步骤与要点（会标注来源；本地资料不足时说明依据不足）',
      '- 想**现在起一卦**：请给出六爻值（自下而上、初爻在前）与起卦时间、时区，由服务端排盘',
      '',
      '最终结果：请先确认你要「学习方法」还是「现在起一卦」，我再继续。',
    ].join('\n');
  }
  if (plan.missingInputs.length === 0 && plan.ambiguities.length === 0) return null;
  const lines: string[] = ['需要补充以下信息才能排盘：'];
  if (plan.missingInputs.includes('lineValues')) lines.push('- 六次爻值（自下而上、初爻在前），例如「8 7 8 8 8 7」；6=老阴动、7=少阳、8=少阴、9=老阳动');
  if (plan.missingInputs.includes('castTime')) lines.push('- 起卦的当地民用时间（日期 + 具体钟点）');
  if (plan.missingInputs.includes('timezone')) lines.push('- 明确时区（本版支持 Asia/Shanghai / 北京时间）');
  if (plan.missingInputs.includes('calendar')) lines.push('- 起卦时间与时区，或已知的日柱与月建（如 戊辰日、申月）');
  if (plan.missingInputs.includes('chart')) lines.push('- 会话里还没有已保存的盘面，请提供上述起卦输入');
  for (const item of plan.ambiguities) lines.push(`- ${item}`);
  lines.push('', '说明：本服务不会用发消息的时间或服务器时区代替你的起卦时间，也不会替你随机起卦。');
  lines.push('', '最终结果：需要你补充上述信息后才能排盘。');
  return lines.join('\n');
}
