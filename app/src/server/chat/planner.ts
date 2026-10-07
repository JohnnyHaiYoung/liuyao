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
  /**
   * 方案 A「保证追问」：判定没把这句话当成起卦、但句中确实像在要求起卦且输入不全时，
   * 由服务端在模型回答**开头**附一句缺项澄清。这样任何措辞都无法"静默跳过追问"。
   */
  appendedClarification?: 'missing_inputs' | null;
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
/**
 * 起卦动作的**形态规则**（复验 5f1d2f1 后按方案 A 加固）：动词 + 可选量词 + 卦，
 * 不再只枚举整句——「起个卦/摇个卦/来一卦/问一卦/占卜/问卦/求卦」等变体一并覆盖。
 * 刻意不含"断"：断卦属解读，不是起卦动作。
 */
const CAST_ACTION_VERBS = '起|摇|占|卜|看|排|算|求|问|掷';
const CAST_ACTION_WORDS = `${CAST_ACTION_VERBS}(?:个|一|1)?卦|来(?:个|一|1)卦|打(?:个|一|1)?卦|看这卦|看下卦|断一卦|占卜|问卦|求卦`;
const CAST_ACTION_PATTERN = new RegExp(`(?:${CAST_MODIFIERS})[^，。；！？]{0,6}(?:${CAST_ACTION_WORDS})`);
/** 强动作（出现即偏"请求"）：形态规则本身 + 若干固定说法。裸"起卦"是否算请求由位置规则决定。 */
const CAST_STRONG_PATTERN = new RegExp(
  `(?:${CAST_ACTION_VERBS})(?:个|一|1)?卦|来(?:个|一|1)卦|打(?:个|一|1)?卦|占卜|问卦|求卦`,
);
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
/** 起卦词之后紧跟比较/**知识名词**（如"算一卦和排一卦有什么区别""起卦的方法"）→ 属讲知识，不算请求。 */
const CAST_THEN_KNOWLEDGE_PATTERN = new RegExp(
  `(?:${CAST_ACTION_WORDS})[^。；！？]{0,8}(?:区别|差异|比较|是什么|什么意思|含义|方法|步骤|流程|原理|用法)`,
);
/** "请教/教我"这类学法问法：既可理解为学习方法，也可理解为现在起卦 → 只问一句澄清。 */
const AMBIGUOUS_TEACH_PATTERN = new RegExp(`(?:请教|教我|教教)[^。；！？]{0,8}(?:${CAST_ACTION_WORDS})`);

/**
 * 子句级识别（复验报告 2250d0d P1）。
 *
 * 一句话里可以同时含两个请求：「请起一卦，顺便介绍六爻起卦的方法」——前半句要求**实际起卦**，
 * 后半句要求讲知识。上一版用"整句里有没有知识词"一刀切，导致起卦请求被知识词抹掉。
 * 现在先按标点与连接词切成子句，**任一子句明确要求起卦且缺输入**就必须保持 chart + 缺项。
 */
const CLAUSE_SPLIT_PATTERN = /[，。；！？,;!?]+|然后|接着|顺便|同时|并且|以及|并|且|再/;
const CLAUSE_BARE_ACTION_PATTERN = new RegExp(
  `^(?:请|麻烦|劳驾|来|现在|马上|立刻|帮我|给我|替我|另|重新)?\\s*(?:${CAST_ACTION_WORDS})`,
);
const CLAUSE_HAS_KNOWLEDGE_PATTERN = new RegExp(`(?:${KNOWLEDGE_VERBS})`);
const CLAUSE_FIRST_ACTION_PATTERN = new RegExp(`(?:${CAST_ACTION_WORDS})`);

export function splitClauses(question: string): string[] {
  return question
    .split(CLAUSE_SPLIT_PATTERN)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 该子句是否在要求"现在就起一卦"。
 *
 * 复验报告 5f1d2f1 P1：不能用"整句/整子句里有没有知识动词"一刀切——「请起一卦并解释起卦方法」
 * 的起卦命令在**前**、讲解要求在**后**，不能让后者否决前者。这里改为**动作短语边界**判定：
 *   1) 找到子句里**最早**的起卦动作词；
 *   2) 知识动词出现在它**之前** → 这个动作是被"讲知识"管着的（"解释六爻起卦的步骤"），不算请求；
 *   3) 动作词之后紧跟比较/定义词 → 术语比较（"算一卦和排一卦有什么区别"），不算请求；
 *   4) 其余情况再看是否有明确祈使、句首即动作、或强动作词。
 * 这样"并/且/后"等无标点连接词无需穷举：动作在前即可成立。
 */
export function isCastRequestClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed === '') return false;
  const action = CLAUSE_FIRST_ACTION_PATTERN.exec(trimmed);
  if (!action) return false;
  const beforeAction = trimmed.slice(0, action.index);
  if (CLAUSE_HAS_KNOWLEDGE_PATTERN.test(beforeAction)) return false;
  if (CAST_THEN_KNOWLEDGE_PATTERN.test(trimmed.slice(action.index))) return false;
  return (
    REQUEST_IMPERATIVE_PATTERN.test(trimmed) ||
    CLAUSE_BARE_ACTION_PATTERN.test(trimmed) ||
    CAST_STRONG_PATTERN.test(trimmed) ||
    CAST_STRONG_ACTIONS.some((marker) => trimmed.includes(marker))
  );
}

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
  // 先识别"用户当前要执行的动作"：按**子句**分别判断"现在起卦"与"讲知识"（复验报告 2250d0d P1）
  const clauseList = splitClauses(question);
  const hasCastRequest = clauseList.some((clause) => isCastRequestClause(clause));
  const hasCastAction = hasCastRequest || CAST_ACTION_PATTERN.test(question) || CAST_STRONG_ACTIONS.some((marker) => question.includes(marker));
  const hasRequestImperative = hasCastRequest || REQUEST_IMPERATIVE_PATTERN.test(question);
  const knowledgeAboutCast = KNOWLEDGE_ABOUT_CAST_PATTERN.test(question);
  const castThenKnowledge = CAST_THEN_KNOWLEDGE_PATTERN.test(question);
  const asksToBeTaught = AMBIGUOUS_TEACH_PATTERN.test(question);
  const looksLikeMethodQuestion = METHOD_COMPARISON_PATTERN.test(question);
  // 任一子句明确要求起卦 → 整轮按起卦处理（讲知识的部分可等输入后回答），不得降级为资料比较
  const isKnowledgeQuestion =
    !hasCastRequest && !hasRequestImperative && (knowledgeAboutCast || castThenKnowledge || looksLikeMethodQuestion);
  // 歧义："请教我用六爻起卦" —— 只问一句"学习方法还是现在起卦"，不索取排盘输入
  const isAmbiguousLearnOrCast = asksToBeTaught && !hasCastRequest && !hasRequestImperative;
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

  // 方案 A「保证追问」：句中像在要求起卦（祈使+动作 / 强动作词 / 子句以动作开头），
  // 但判定走了知识/概念路线且没有完整输入 → 交给服务端在回答开头附一句缺项澄清。
  // 目的是让"漏判"的后果从"不追问"变成"多问一句"，不再能被新措辞绕过。
  const commandLike =
    REQUEST_IMPERATIVE_PATTERN.test(question) ||
    clauseList.some((clause) => {
      const action = CLAUSE_FIRST_ACTION_PATTERN.exec(clause);
      if (!action) return false;
      // 知识动词在动作之前（"解释六爻起卦的步骤"）或知识名词在动作之后（"起卦的方法"）→ 讲知识，不算命令式
      if (CLAUSE_HAS_KNOWLEDGE_PATTERN.test(clause.slice(0, action.index))) return false;
      if (CAST_THEN_KNOWLEDGE_PATTERN.test(clause.slice(action.index))) return false;
      return (
        REQUEST_IMPERATIVE_PATTERN.test(clause) ||
        CAST_STRONG_PATTERN.test(clause) ||
        CLAUSE_BARE_ACTION_PATTERN.test(clause)
      );
    });
  const appendedClarification =
    commandLike && !hasAnyChartInput && !(chart && chart.ok) && missingInputs.length === 0 ? 'missing_inputs' : null;
  if (appendedClarification !== null) {
    reasons.push('方案 A 保证追问：句中出现起卦动作而输入不全，已在回答开头附缺项澄清');
  }

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
      appendedClarification,
    },
    wiki,
    chart,
  };
}

/**
 * 方案 A 的附加澄清文本：附在模型回答**开头**，保证格式仍以回答的「最终结果：」收尾。
 * 与 buildMissingInputReply 的区别：这条**不替代**回答，只保证"必定问一句"。
 */
export function buildAppendedClarification(plan: PlanObject): string | null {
  if (plan.appendedClarification !== 'missing_inputs') return null;
  return [
    '（服务端提示）你这句里也提到起卦；若要我现在为你排一卦，请补充：六次爻值（自下而上、初爻在前）、起卦的当地民用时间与具体钟点、以及时区（本版支持 Asia/Shanghai / 北京时间）。',
  ].join('\n');
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
