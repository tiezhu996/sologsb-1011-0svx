export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';

export interface CaptionSegment {
  id: string;
  sequence: number;
  startTime: number;
  receivedAt: number;
  confirmedAt?: number;
  speaker: string;
  original: string;
  /** 播出/确认文本，一经确认即冻结；对账只更新 term 元数据，不改写它。 */
  corrected: string;
  numberHints: string;
  source: SegmentSource;
  state: SegmentState;
  duplicateOf?: string;
  staleReason?: string;
  revision: number;
  tags: string[];
  /** 确认时锁定的术语版本快照，用于按确认版本回放/导出与重新对账。 */
  term?: SegmentTerm;
  /** 校对员接受新版本对账建议后的记录（播出文本仍保留在 corrected）。 */
  reconciled?: ReconciledRecord;
}

export interface TermRule {
  id: string;
  source: string;
  replacement: string;
  speaker: string;
  enabled: boolean;
  caseSensitive: boolean;
  usageCount: number;
  createdAt: number;
  /** 本机快捷规则（术语包之外的叠加层），可编辑删除；术语包规则只读。 */
  local?: boolean;
}

/** 确认瞬间锁定的规则事实，之后术语包更新也不影响这一段的回放事实。 */
export interface SegmentTerm {
  version: string;
  /** 原始 ASR 文本（未应用任何术语规则），新版本对账时从它重新渲染。 */
  original: string;
  /** 确认前的人工底稿（原始文本 + 人工编辑，未含术语自动应用）。 */
  base: string;
  /** 用确认版本规则渲染 original 得到的自动结果。 */
  auto: string;
  /** 相对自动结果是否有人工改动。 */
  manual: boolean;
  applied: string[];
}

export interface ReconciledRecord {
  version: string;
  text: string;
  status: ReconcileStatus;
  at: number;
  fromVersion: string;
  note?: string;
}

/** 下发到直播中途的带版本号术语包；包内只存放规则事实，不存放字幕。 */
export interface TermPackage {
  version: string;
  releasedAt: number;
  note: string;
  rules: TermRule[];
  importedAt?: number;
}

export interface RuleConflict {
  type: 'same-source' | 'rule-cycle' | 'schema';
  message: string;
  ruleIds: string[];
}

export interface TermImportCheckpoint {
  id: string;
  version: string;
  raw: string;
  reason: string;
  conflicts: RuleConflict[];
  attempts: number;
  firstFailedAt: number;
  lastFailedAt: number;
  resolved: boolean;
}

export interface MergeToken {
  text: string;
  status: 'unchanged' | 'changed' | 'conflict';
  from?: string;
  to?: string;
}

export type ReconcileStatus = 'up-to-date' | 'clean' | 'manual-preserved' | 'conflict' | 'pending-segment';

export interface ReconcileItem {
  segment: CaptionSegment;
  fromVersion: string;
  targetVersion: string;
  status: ReconcileStatus;
  /** 建议文本：clean 为自动渲染；manual-preserved/conflict 为保留人工修改的三方合并结果。 */
  proposed?: string;
  tokens?: MergeToken[];
  message: string;
}

export interface ImportResult {
  ok: boolean;
  version?: string;
  installed?: TermPackage;
  checkpoint?: TermImportCheckpoint;
  conflicts: RuleConflict[];
  message: string;
}

export interface DeskModel {
  eventName: string;
  eventDate: string;
  segments: CaptionSegment[];
  /** 本机叠加层快捷规则（术语包规则以包为准、只读）。 */
  rules: TermRule[];
  /** 已导入的术语包（只存规则事实，不可变，按导入顺序保存）。 */
  termPackages: TermPackage[];
  activeTermVersion: string;
  /** 整包导入失败留下的检查点；重试成功前不会应用任何规则。 */
  importCheckpoints: TermImportCheckpoint[];
  selectedId: string;
  connection: ConnectionState;
  simulatedDelay: number;
  fontSize: number;
  nextSequence: number;
  autoStream: boolean;
  lastMergedAt?: number;
  updatedAt: number;
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const STORAGE_KEY = 'sologsb-10011-live-caption-desk-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';

function segment(
  id: string,
  sequence: number,
  startTime: number,
  speaker: string,
  original: string,
  corrected = original,
  state: SegmentState = 'pending',
): CaptionSegment {
  return {
    id,
    sequence,
    startTime,
    receivedAt: now - (100 - sequence) * 8_000,
    confirmedAt: state === 'confirmed' ? now - (100 - sequence) * 7_000 : undefined,
    speaker,
    original,
    corrected,
    numberHints: '',
    source: 'live',
    state,
    revision: 0,
    tags: [],
  };
}

function localRule(id: string, source: string, replacement: string, caseSensitive = false): TermRule {
  return { id, source, replacement, speaker: '', enabled: true, caseSensitive, usageCount: 0, createdAt: now, local: true };
}

/** 术语包规则（只读事实）。usageCount 不被对账流程修改。 */
function packageRule(id: string, source: string, replacement: string, caseSensitive = false, speaker = ''): TermRule {
  return { id, source, replacement, speaker, enabled: true, caseSensitive, usageCount: 0, createdAt: now };
}

const seededSegments: CaptionSegment[] = [
  segment('seg-1', 1, 0, '主持人', '欢迎大家来到二零二六年产品发布会。', '欢迎大家来到2026年产品发布会。', 'confirmed'),
  segment('seg-2', 2, 7, '主讲人', '今天我们会介绍三个模块,首先是实时协作。', '今天我们会介绍三个模块，首先是实时协作。', 'confirmed'),
  segment('seg-3', 3, 15, '主讲人', '延迟和质量监测会帮助我们保持字幕稳定。', '延迟和质量监测会帮助我们保持字幕稳定。', 'confirmed'),
  segment('seg-4', 4, 24, '嘉宾 / 周然', '我们使用 studio cloud 作为演示环境。', '我们使用 Studio Cloud 作为演示环境。', 'pending'),
  segment('seg-5', 5, 34, '嘉宾 / 周然', '每分钟大约会收到一百二十个片段。', '每分钟大约会收到120个片段。', 'pending'),
  segment('seg-6', 6, 43, '主持人', '如果主持人提到 co pilot,需要统一大小写。', '如果主持人提到 Co-Pilot，需要统一大小写。', 'confirmed'),
  segment('seg-7', 7, 52, '主持人', '这个例子会演示五G网络下的字幕恢复。', '这个例子会演示5G网络下的字幕恢复。', 'pending'),
  segment('seg-9', 9, 68, '嘉宾 / 周然', '这一段会提到 studio cloud 的演示环境。', '这一段会提到 StudioCloud（演示环境）。', 'confirmed'),
  segment('seg-10', 10, 77, '主讲人', '现场网络恢复后五G链路会自动重连。', '现场网络恢复后5G链路会自动重连。', 'confirmed'),
];

const duplicate: CaptionSegment = {
  ...segment('seg-8', 8, 61, '主讲人', '今天我们重点讨论字幕队列。', '今天我们重点讨论字幕队列。', 'duplicate'),
  source: 'live',
  duplicateOf: 'seg-2',
  staleReason: '与第 2 段高度相似',
};

const v1Rules = (): TermRule[] => [
  { id: 'term-1', source: 'co pilot', replacement: 'Co-Pilot', speaker: '', enabled: true, caseSensitive: false, usageCount: 4, createdAt: now - 86_400_000 },
  { id: 'term-2', source: 'studio cloud', replacement: 'Studio Cloud', speaker: '', enabled: true, caseSensitive: false, usageCount: 7, createdAt: now - 43_200_000 },
  { id: 'term-3', source: '五G', replacement: '5G', speaker: '', enabled: true, caseSensitive: true, usageCount: 2, createdAt: now - 3_600_000 },
];

function buildSeedPackageV1(): TermPackage {
  return {
    version: '1.0.0',
    releasedAt: now - 3_600_000,
    note: '开场前下发的首版术语表',
    rules: v1Rules(),
    importedAt: now - 3_600_000,
  };
}

export function createInitialModel(): DeskModel {
  return {
    eventName: '新品发布会现场字幕',
    eventDate: new Date(now).toISOString().slice(0, 10),
    segments: hydrateSegmentTerms([...seededSegments, duplicate], [buildSeedPackageV1()]),
    rules: [localRule('local-demo-1', '字幕恢复', '字幕恢复链路')],
    termPackages: [buildSeedPackageV1()],
    activeTermVersion: '1.0.0',
    importCheckpoints: [],
    selectedId: 'seg-4',
    connection: 'connected',
    simulatedDelay: 1.8,
    fontSize: 18,
    nextSequence: 11,
    autoStream: true,
    updatedAt: now,
  };
}

export function cloneModel(model: DeskModel): DeskModel {
  return structuredClone(model);
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

export function parseVersion(version: string): number[] {
  const parts = String(version || '').trim().split(/[.+-]/u)[0]?.split('.').map((part) => Number(part)) ?? [];
  const nums = parts.map((part) => (Number.isFinite(part) ? part : 0));
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return a.localeCompare(b);
}

export function isNewerVersion(candidate: string, baseline: string): boolean {
  return compareVersions(candidate, baseline) > 0;
}

export function latestPackage(packages: TermPackage[]): TermPackage | undefined {
  return [...packages].sort((a, b) => compareVersions(b.version, a.version))[0];
}

// ---------------------------------------------------------------------------
// 规则渲染
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function packageRulesFor(packages: TermPackage[], version: string): TermRule[] {
  const found = packages.find((item) => item.version === version);
  return found ? found.rules.filter((rule) => rule.enabled) : [];
}

/** 某确认版本下生效的规则 = 该版本术语包规则（只读事实） + 本机叠加层规则。 */
export function effectiveRules(model: DeskModel, version: string): TermRule[] {
  return [...packageRulesFor(model.termPackages, version), ...model.rules.filter((rule) => rule.enabled)];
}

function ruleMatches(rule: TermRule, speaker: string): boolean {
  return !rule.speaker || rule.speaker === speaker;
}

export interface RenderResult {
  text: string;
  used: string[];
}

export function renderWithRules(text: string, rules: TermRule[], speaker: string): RenderResult {
  let next = text;
  const used: string[] = [];
  for (const rule of rules) {
    if (!rule.source || !next || !ruleMatches(rule, speaker)) continue;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(escapeRegExp(rule.source), flags);
    if (expression.test(next)) {
      next = next.replace(expression, rule.replacement);
      used.push(rule.id);
    }
  }
  return { text: normalizePunctuation(next), used };
}

export function renderAtVersion(text: string, model: DeskModel, version: string, speaker = ''): RenderResult {
  return renderWithRules(text, effectiveRules(model, version), speaker);
}

export function normalizeNumbers(text: string): string {
  const digitMap: Record<string, string> = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
  const chineseNumber = (raw: string): number => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!/[十百千万]/u.test(raw)) return Number([...raw].map((char) => digits[char] ?? 0).join(''));
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of raw) {
      if (digits[char] !== undefined) {
        number = digits[char];
      } else if (char === '十') {
        section += (number || 1) * 10;
        number = 0;
      } else if (char === '百') {
        section += (number || 1) * 100;
        number = 0;
      } else if (char === '千') {
        section += (number || 1) * 1000;
        number = 0;
      } else if (char === '万') {
        total += (section + number) * 10_000;
        section = 0;
        number = 0;
      }
    }
    return total + section + number;
  };

  return text
    .replace(/[０-９]/g, (char) => digitMap[char] ?? char)
    .replace(/([零〇一二两三四五六七八九十百千万]+)/gu, (match) => String(chineseNumber(match)))
    .replace(/(?<=\d)[，,](?=\d{3}\b)/g, ',');
}

export function normalizePunctuation(text: string): string {
  return text
    .replace(/([，。！？；：])(?=[^\s，。！？；：])/gu, '$1')
    .replace(/\s+([，。！？；：])/gu, '$1')
    .replace(/([,;:!?])(?=[^\s,;:!?])/g, (match) => ({ ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' }[match] ?? match));
}

// ---------------------------------------------------------------------------
// 字符级三方合并：base=确认底稿，ours=人工播出文本，theirs=新版本自动渲染。
// 人工改过的字符在重新检查时不能丢；双方改动重叠时标为冲突交人工裁决。
// ---------------------------------------------------------------------------

interface CharOp {
  kind: 'eq' | 'del' | 'ins';
  /** eq/del 时为 base 字符下标；ins 时为插入位置（前一个 base 下标 +1 语义由 pos 表示）。 */
  index: number;
  char: string;
}

/** 以 base 为锚点的编辑脚本：eq/del 消费 base 字符，ins 不消费。 */
function charOps(base: string, other: string): CharOp[] {
  const a = [...base];
  const b = [...other];
  const rows = a.length;
  const cols = b.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: CharOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', index: i, char: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'del', index: i, char: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'ins', index: i, char: b[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: 'del', index: i, char: a[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ kind: 'ins', index: rows, char: b[j] });
    j += 1;
  }
  return ops;
}

interface AnchorChange {
  removed: boolean;
  inserted: string;
}

/** 把编辑脚本汇总成「每个 base 锚点处的删除/插入」表（插入视作在该锚点字符之前）。 */
function changeMap(ops: CharOp[], baseLength: number): Map<number, AnchorChange> {
  const map = new Map<number, AnchorChange>();
  const at = (index: number): AnchorChange => map.get(index) ?? { removed: false, inserted: '' };
  for (const op of ops) {
    if (op.kind === 'del') {
      const change = at(op.index);
      change.removed = true;
      map.set(op.index, change);
    } else if (op.kind === 'ins') {
      const change = at(Math.min(op.index, baseLength));
      change.inserted += op.char;
      map.set(Math.min(op.index, baseLength), change);
    }
  }
  return map;
}

interface Interval {
  start: number;
  end: number;
}

/** 从变更表提取 hunk 区间：删除覆盖 [p,p+1)，纯插入为零宽区间 [p,p)。 */
function changeIntervals(map: Map<number, AnchorChange>): Interval[] {
  return [...map.entries()]
    .filter(([, change]) => change.removed || change.inserted)
    .map(([index, change]) => ({ start: index, end: change.removed ? index + 1 : index }));
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export interface ThreeWayResult {
  text: string;
  tokens: MergeToken[];
  hasConflict: boolean;
}

/**
 * 字符级三方合并：base=确认底稿，ours=人工播出文本，theirs=新版本自动渲染。
 * 双方改动按 base 上的变更区间聚类：区间不相交各自采纳；相交或相接则整体比对，
 * 结果不一致即冲突，冲突区间保留人工结果。人工修改在重新对账时不会丢，
 * 已播内容也不会被静默改写。
 */
export function threeWayMerge(base: string, ours: string, theirs: string): ThreeWayResult {
  const chars = [...base];
  const length = chars.length;
  const oursMap = changeMap(charOps(base, ours), length);
  const theirsMap = changeMap(charOps(base, theirs), length);
  const clusters = mergeIntervals([...changeIntervals(oursMap), ...changeIntervals(theirsMap)]);

  const tokens: MergeToken[] = [];
  let hasConflict = false;
  const push = (token: MergeToken) => {
    const previous = tokens[tokens.length - 1];
    if (previous && previous.status === token.status) previous.text += token.text;
    else tokens.push({ ...token });
  };
  const renderSide = (map: Map<number, AnchorChange>, start: number, end: number): string => {
    let out = '';
    for (let p = start; p < end; p += 1) {
      out += map.get(p)?.inserted ?? '';
      if (!map.get(p)?.removed) out += chars[p];
    }
    out += map.get(end)?.inserted ?? '';
    return out;
  };
  const changedIn = (map: Map<number, AnchorChange>, start: number, end: number): boolean => {
    for (let p = start; p <= end; p += 1) {
      const change = map.get(p);
      if (change && (change.removed || change.inserted)) return true;
    }
    return false;
  };

  let cursor = 0;
  for (const cluster of clusters) {
    if (cluster.start > cursor) push({ text: chars.slice(cursor, cluster.start).join(''), status: 'unchanged' });
    const oursChanged = changedIn(oursMap, cluster.start, cluster.end);
    const theirsChanged = changedIn(theirsMap, cluster.start, cluster.end);
    const oursOut = renderSide(oursMap, cluster.start, cluster.end);
    const theirsOut = renderSide(theirsMap, cluster.start, cluster.end);

    if (oursChanged && theirsChanged && oursOut !== theirsOut) {
      hasConflict = true;
      push({ text: oursOut, status: 'conflict', from: oursOut, to: theirsOut });
    } else if (oursChanged || theirsChanged) {
      push({ text: oursChanged ? oursOut : theirsOut, status: 'changed' });
    } else {
      push({ text: chars.slice(cluster.start, cluster.end).join(''), status: 'unchanged' });
    }
    cursor = cluster.end;
  }
  if (cursor < length) push({ text: chars.slice(cursor).join(''), status: 'unchanged' });

  return { text: tokens.map((token) => token.text).join(''), tokens, hasConflict };
}

// ---------------------------------------------------------------------------
// 术语包校验：同版本内的规则冲突先列出来（原子整包，任一冲突即整包失败）
// ---------------------------------------------------------------------------

function ruleKey(rule: TermRule): string {
  return `${rule.speaker}::${rule.caseSensitive ? rule.source : rule.source.toLocaleLowerCase()}`.trim();
}

function findRuleCycles(rules: TermRule[]): string[][] {
  const byKey = new Map<string, TermRule>();
  for (const rule of rules) {
    if (!byKey.has(ruleKey(rule))) byKey.set(ruleKey(rule), rule);
  }
  const keyOfText = (text: string): string | undefined => {
    const lower = text.toLocaleLowerCase();
    for (const key of byKey.keys()) {
      const source = key.split('::')[1] ?? '';
      if (source && lower.includes(source)) return key;
    }
    return undefined;
  };

  const adjacency = new Map<string, string[]>();
  for (const rule of rules) {
    const from = ruleKey(rule);
    const target = keyOfText(rule.replacement);
    if (target && target !== from) adjacency.set(from, [...(adjacency.get(from) ?? []), target]);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const visit = (key: string, stack: string[], seen: Set<string>): void => {
    if (seen.has(key)) {
      const start = stack.indexOf(key);
      if (start >= 0) cycles.push([...stack.slice(start), key]);
      return;
    }
    if (visited.has(key)) return;
    seen.add(key);
    stack.push(key);
    for (const next of adjacency.get(key) ?? []) visit(next, stack, seen);
    stack.pop();
    seen.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key, [], new Set());

  const unique: string[][] = [];
  const signature = new Set<string>();
  for (const cycle of cycles) {
    const sig = [...cycle].sort().join('>');
    if (!signature.has(sig)) {
      signature.add(sig);
      unique.push(cycle);
    }
  }
  return unique.map((cycle) => cycle.map((key) => byKey.get(key)?.id ?? key));
}

export interface ValidationResult {
  valid: boolean;
  conflicts: RuleConflict[];
  normalized?: TermPackage;
}

export function validateTermPackage(raw: string, knownPackages: TermPackage[] = []): ValidationResult {
  const conflicts: RuleConflict[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      valid: false,
      conflicts: [{ type: 'schema', message: `术语包不是合法 JSON：${(error as Error).message}`, ruleIds: [] }],
    };
  }

  const candidate = parsed as Partial<TermPackage>;
  const version = typeof candidate.version === 'string' ? candidate.version.trim() : '';
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    conflicts.push({ type: 'schema', message: '缺少合法语义版本号（形如 2.0.0）', ruleIds: [] });
  } else if (knownPackages.some((item) => item.version === version)) {
    conflicts.push({ type: 'schema', message: `版本 ${version} 已导入，同一版本不会重复应用`, ruleIds: [] });
  }

  const rawRules = Array.isArray(candidate.rules) ? candidate.rules : [];
  if (!rawRules.length) conflicts.push({ type: 'schema', message: '术语包必须至少包含一条规则', ruleIds: [] });

  const seenIds = new Set<string>();
  const rules: TermRule[] = [];
  rawRules.forEach((item, index) => {
    const rule = item as Partial<TermRule>;
    const id = typeof rule.id === 'string' && rule.id ? rule.id : `pkg-${version}-${index + 1}`;
    const source = typeof rule.source === 'string' ? rule.source.trim() : '';
    const replacement = typeof rule.replacement === 'string' ? rule.replacement : '';
    if (!source || !replacement) {
      conflicts.push({ type: 'schema', message: `规则 ${id} 的原文或替换文本为空`, ruleIds: [id] });
    }
    if (seenIds.has(id)) conflicts.push({ type: 'schema', message: `规则 id 重复：${id}`, ruleIds: [id] });
    seenIds.add(id);
    rules.push({
      id,
      source,
      replacement,
      speaker: typeof rule.speaker === 'string' ? rule.speaker : '',
      enabled: rule.enabled !== false,
      caseSensitive: Boolean(rule.caseSensitive),
      usageCount: 0,
      createdAt: Date.now(),
    });
  });

  // 同一版本内：相同触发原文（含发言人/大小写维度）却给出不同替换 → 规则冲突。
  const sourceGroups = new Map<string, TermRule[]>();
  for (const rule of rules) {
    const key = ruleKey(rule);
    sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), rule]);
  }
  for (const [key, group] of sourceGroups) {
    const replacements = new Set(group.map((rule) => rule.replacement));
    if (group.length > 1 && replacements.size > 1) {
      conflicts.push({
        type: 'same-source',
        message: `同一版本中「${key.split('::')[1]}」存在互相矛盾的替换：${[...replacements].join(' / ')}`,
        ruleIds: group.map((rule) => rule.id),
      });
    }
  }

  for (const cycle of findRuleCycles(rules)) {
    conflicts.push({
      type: 'rule-cycle',
      message: `规则替换形成循环：${cycle.join(' → ')}`,
      ruleIds: cycle,
    });
  }

  if (conflicts.length) return { valid: false, conflicts };
  return {
    valid: true,
    conflicts: [],
    normalized: {
      version,
      releasedAt: typeof candidate.releasedAt === 'number' ? candidate.releasedAt : Date.now(),
      note: typeof candidate.note === 'string' ? candidate.note : '',
      rules,
      importedAt: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// 整包导入：失败留下检查点，规则一条都不应用；重试按检查点幂等执行
// ---------------------------------------------------------------------------

export function importTermPackage(model: DeskModel, raw: string): { model: DeskModel; result: ImportResult } {
  // 已导入过的同版本包：幂等跳过，不留检查点、不重复应用。
  let versionLabel = '未知版本';
  try {
    versionLabel = String((JSON.parse(raw) as Partial<TermPackage>)?.version ?? '未知版本');
  } catch {
    // JSON 解析失败会在 validateTermPackage 中形成 schema 冲突。
  }
  if (model.termPackages.some((item) => item.version === versionLabel)) {
    return {
      model,
      result: {
        ok: false,
        version: versionLabel,
        conflicts: [],
        message: `术语包 ${versionLabel} 已应用过，跳过重试以避免重复应用`,
      },
    };
  }

  const validation = validateTermPackage(raw, model.termPackages);

  if (!validation.valid || !validation.normalized) {
    const existing = model.importCheckpoints.find((item) => item.version === versionLabel && !item.resolved);
    const checkpoint: TermImportCheckpoint = existing
      ? { ...existing, attempts: existing.attempts + 1, lastFailedAt: Date.now(), raw, conflicts: validation.conflicts }
      : {
        id: `checkpoint-${Date.now().toString(36)}`,
        version: versionLabel,
        raw,
        reason: validation.conflicts[0]?.message ?? '整包校验失败',
        conflicts: validation.conflicts,
        attempts: 1,
        firstFailedAt: Date.now(),
        lastFailedAt: Date.now(),
        resolved: false,
      };
    const checkpoints = existing
      ? model.importCheckpoints.map((item) => (item.id === existing.id ? checkpoint : item))
      : [...model.importCheckpoints, checkpoint];
    return {
      model: { ...model, importCheckpoints: checkpoints, updatedAt: Date.now() },
      result: {
        ok: false,
        checkpoint,
        conflicts: validation.conflicts,
        message: `术语包 ${versionLabel} 整包导入失败，已保留检查点，规则未应用（第 ${checkpoint.attempts} 次尝试）`,
      },
    };
  }

  const installed = validation.normalized;
  const cleared = model.importCheckpoints.map((item) =>
    item.version === installed.version ? { ...item, resolved: true, lastFailedAt: item.lastFailedAt } : item,
  );
  const next: DeskModel = {
    ...model,
    termPackages: [...model.termPackages, installed],
    activeTermVersion: installed.version,
    importCheckpoints: cleared,
    updatedAt: Date.now(),
  };
  return {
    model: next,
    result: {
      ok: true,
      version: installed.version,
      installed,
      conflicts: [],
      message: `术语包 ${installed.version} 已导入（${installed.rules.length} 条规则事实）；已播字幕不会被改写，可发起版本对账`,
    },
  };
}

/** 失败检查点重试：用检查点保存的原始包重新走整包导入，天然幂等、不会重复应用。 */
export function retryCheckpoint(model: DeskModel, checkpointId: string): { model: DeskModel; result: ImportResult } {
  const checkpoint = model.importCheckpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) {
    return {
      model,
      result: { ok: false, conflicts: [], message: '检查点不存在，可能已被清理' },
    };
  }
  return importTermPackage(model, checkpoint.raw);
}

export function discardCheckpoint(model: DeskModel, checkpointId: string): DeskModel {
  return {
    ...model,
    importCheckpoints: model.importCheckpoints.filter((item) => item.id !== checkpointId),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 重新对账：逐段按“确认时版本 → 目标版本”生成建议；人工修改不丢
// ---------------------------------------------------------------------------

export function reconcileSegment(
  item: CaptionSegment,
  model: DeskModel,
  targetVersion: string,
): ReconcileItem | undefined {
  // 已接受过对账的段，其“当前版本”前移到对账版本，但播出事实仍以确认快照为基准。
  const pinned = item.reconciled?.version ?? item.term?.version ?? model.activeTermVersion;
  const base: ReconcileItem = {
    segment: item,
    fromVersion: pinned,
    targetVersion,
    status: 'up-to-date',
    message: `已按 ${targetVersion} 检查`,
  };

  if (item.state !== 'confirmed') {
    return { ...base, status: 'pending-segment', message: '未确认片段无需对账，确认时直接按当前版本锁定' };
  }
  if (pinned === targetVersion && !item.reconciled) {
    return { ...base, status: 'up-to-date', message: `确认版本已是 ${targetVersion}` };
  }
  if (item.reconciled?.version === targetVersion) {
    return { ...base, status: 'up-to-date', message: `已接受 ${targetVersion} 对账结果` };
  }

  const term = item.term;
  // 新版本结果必须从原始 ASR 文本渲染：旧版本词形（如 Co-Pilot）会遮蔽新规则的触发词。
  const theirs = renderWithRules(
    term?.original ?? item.original,
    effectiveRules(model, targetVersion),
    item.speaker,
  ).text;
  // 合并基 = 旧版本自动结果；ours=人工播出文本，人工改动相对该基线可被 LCS 精确识别。
  const mergeBase = term?.auto ?? item.original;

  // 无人工修改：新版本自动渲染即为建议，属于干净升级。
  if (!term?.manual) {
    if (mergeBase === theirs) {
      return { ...base, status: 'clean', proposed: theirs, message: '新版本规则对本段无文本影响' };
    }
    return {
      ...base,
      status: 'clean',
      proposed: theirs,
      tokens: [{ text: theirs, status: 'changed' }],
      message: '无人工修改，可直接套用新版本自动结果',
    };
  }

  const merge = threeWayMerge(mergeBase, item.corrected, theirs);
  if (!merge.hasConflict) {
    return {
      ...base,
      status: 'manual-preserved',
      proposed: merge.text,
      tokens: merge.tokens,
      message: merge.text === theirs
        ? '人工修改与新版本一致'
        : '已保留人工修改，仅合入不重叠的规则更新',
    };
  }
  return {
    ...base,
    status: 'conflict',
    proposed: merge.text,
    tokens: merge.tokens,
    message: '规则更新与人工修改重叠，已保留人工播出文本，请人工裁决',
  };
}

export function reconciliationReport(model: DeskModel, targetVersion: string): ReconcileItem[] {
  return model.segments
    .filter((item) => item.state === 'confirmed' || item.state === 'stale')
    .map((item) => reconcileSegment(item, model, targetVersion))
    .filter((item): item is ReconcileItem => Boolean(item))
    .sort((a, b) => a.segment.sequence - b.segment.sequence);
}

/** 校对员接受建议（冲突处可人工改写后再接受）。只记录对账结论，corrected 永不改写。 */
export function acceptReconciliation(
  model: DeskModel,
  segmentId: string,
  targetVersion: string,
  resolvedText: string,
  status: ReconcileStatus,
  note?: string,
): DeskModel {
  return {
    ...model,
    segments: model.segments.map((item) => {
      if (item.id !== segmentId) return item;
      const fromVersion = item.reconciled?.version ?? item.term?.version ?? model.activeTermVersion;
      return {
        ...item,
        reconciled: {
          version: targetVersion,
          text: resolvedText,
          status,
          at: Date.now(),
          fromVersion,
          note,
        },
      };
    }),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 按确认版本取字幕：直播/导出/回放均以每段自己锁定的版本为准
// ---------------------------------------------------------------------------

export interface SegmentView {
  segment: CaptionSegment;
  text: string;
  version: string;
  /** reconciled=对账接受文本；aired=确认时冻结文本；target=按指定版本渲染。 */
  source: 'aired' | 'reconciled' | 'target';
  conflict?: boolean;
}

export function segmentView(item: CaptionSegment, model: DeskModel, mode: string): SegmentView {
  if (mode === 'reconciled' && item.reconciled) {
    return { segment: item, text: item.reconciled.text, version: item.reconciled.version, source: 'reconciled' };
  }
  if (mode === 'aired' || mode === 'reconciled') {
    return { segment: item, text: item.corrected, version: item.term?.version ?? model.activeTermVersion, source: 'aired' };
  }
  // 指定版本回放：未确认段不算；对已确认段做一次对账渲染。
  const report = reconcileSegment(item, model, mode);
  const conflict = report?.status === 'conflict';
  return {
    segment: item,
    text: report?.proposed ?? item.corrected,
    version: mode,
    source: 'target',
    conflict,
  };
}

export interface SrtResult {
  content: string;
  count: number;
  conflicts: CaptionSegment[];
}

/**
 * mode = 'aired'：每段按自己的确认版本（冻结的 corrected）导出，已播内容不被改写。
 * mode = 版本号：按该版本渲染；冲突段回退为人工播出文本并列入 conflicts 提示。
 */
export function toSrt(model: DeskModel, mode: string = 'aired'): SrtResult {
  const stamp = (seconds: number, separator = ',') => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
  };
  const confirmed = model.segments
    .filter((item) => item.state === 'confirmed')
    .sort((a, b) => a.startTime - b.startTime);

  const conflicts: CaptionSegment[] = [];
  const blocks = confirmed.map((item, index) => {
    let text = item.corrected;
    if (mode !== 'aired') {
      const view = segmentView(item, model, mode);
      text = view.text;
      if (view.conflict) conflicts.push(item);
    }
    return `${index + 1}\n${stamp(item.startTime)} --> ${stamp(item.startTime + 7)}\n[${item.speaker}] ${text}\n`;
  });

  return { content: blocks.join('\n'), count: confirmed.length, conflicts };
}

// ---------------------------------------------------------------------------
// 持久化迁移：旧模型或无术语快照的已确认段，按 1.0.0 重建确认快照
// ---------------------------------------------------------------------------

export function hydrateModel(parsed: Partial<DeskModel>): DeskModel {
  const fallback = createInitialModel();
  const termPackages: TermPackage[] = parsed.termPackages?.length
    ? parsed.termPackages
    : [{
      version: '1.0.0',
      releasedAt: now - 3_600_000,
      note: '由旧版本地草稿迁移的首版术语表',
      rules: (parsed.rules?.length ? parsed.rules : v1Rules()).map((rule) => ({ ...rule, local: false })),
      importedAt: now - 3_600_000,
    }];

  // 新版草稿：rules 是本机叠加层；旧版迁移草稿：旧规则已并入迁移包，叠加层回到演示默认。
  const rules: TermRule[] = parsed.termPackages?.length ? (parsed.rules ?? []) : fallback.rules;

  const model: DeskModel = {
    ...fallback,
    ...parsed,
    segments: Array.isArray(parsed.segments) ? parsed.segments : fallback.segments,
    rules,
    termPackages,
    activeTermVersion: parsed.activeTermVersion || latestPackage(termPackages)?.version || '1.0.0',
    importCheckpoints: Array.isArray(parsed.importCheckpoints) ? parsed.importCheckpoints : [],
  };
  model.segments = hydrateSegmentTerms(model.segments, termPackages);
  return model;
}

function hydrateSegmentTerms(segments: CaptionSegment[], packages: TermPackage[]): CaptionSegment[] {
  const baseline = latestPackage(packages)?.version ?? '1.0.0';
  return segments.map((item) => {
    if (item.state !== 'confirmed' || item.term) return item;
    const original = item.original;
    const auto = renderWithRules(original, packageRulesFor(packages, baseline), item.speaker).text;
    return {
      ...item,
      term: {
        version: baseline,
        original,
        base: original,
        auto,
        manual: normalizePunctuation(item.corrected) !== auto,
        applied: [],
      },
    };
  });
}

export function loadStoredModel(): DeskModel | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DeskModel>;
      if (parsed.segments?.length) return hydrateModel(parsed);
    }
  } catch {
    // 损坏草稿会回退到演示数据。
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 确认瞬间锁定术语版本快照
// ---------------------------------------------------------------------------

/**
 * 确认瞬间锁定版本快照。
 * @param original 原始 ASR 文本
 * @param draft 校对员的人工底稿（确认前编辑框内容，尚未做术语自动应用）
 * @param aired 最终播出文本（一般是对 draft 应用当前版本规则的结果）
 */
export function buildTermSnapshot(
  original: string,
  draft: string,
  aired: string,
  model: DeskModel,
  speaker: string,
): SegmentTerm {
  const rendered = renderWithRules(original, effectiveRules(model, model.activeTermVersion), speaker);
  return {
    version: model.activeTermVersion,
    original,
    base: draft,
    auto: rendered.text,
    manual: normalizePunctuation(aired) !== rendered.text,
    applied: rendered.used,
  };
}

export function isDuplicate(candidate: CaptionSegment, existing: CaptionSegment[]): CaptionSegment | undefined {
  const normalize = (value: string) => value.replace(/[\s，。！？；：,.;:!?（）()]/g, '').toLocaleLowerCase();
  const candidateText = normalize(candidate.corrected || candidate.original);
  return existing.find((segmentItem) => {
    if (segmentItem.id === candidate.id || segmentItem.state === 'ignored') return false;
    const text = normalize(segmentItem.corrected || segmentItem.original);
    if (!candidateText || !text) return false;
    return text === candidateText || (Math.abs(segmentItem.startTime - candidate.startTime) < 12 && (text.includes(candidateText) || candidateText.includes(text)));
  });
}

export function mergeConfirmedSegments(model: DeskModel): DeskModel {
  const seen: string[] = [];
  const segments = model.segments
    .map((item) => ({ ...item }))
    .sort((a, b) => a.sequence - b.sequence || a.startTime - b.startTime)
    .map((item): CaptionSegment => {
      if (item.source === 'offline' && item.state === 'confirmed') {
        item.source = item.confirmedAt && Date.now() - item.confirmedAt > 90_000 ? 'offline' : 'live';
        item.staleReason = Date.now() - item.receivedAt > 90_000 ? `离线恢复后合并，原始片段已延迟 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` : undefined;
        if (item.staleReason) item.state = 'stale';
      }
      const duplicate = isDuplicate(item, seen.map((id) => model.segments.find((segmentItem) => segmentItem.id === id)).filter(Boolean) as CaptionSegment[]);
      if (duplicate && item.state !== 'confirmed') {
        item.state = 'duplicate';
        item.duplicateOf = duplicate.id;
      }
      if (item.state !== 'ignored') seen.push(item.id);
      return item;
    });

  return {
    ...model,
    segments,
    connection: 'connected',
    simulatedDelay: Math.max(0.8, model.simulatedDelay - 0.7),
    lastMergedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function queueStats(model: DeskModel) {
  const pending = model.segments.filter((item) => item.state === 'pending');
  const stale = model.segments.filter((item) => item.state === 'stale');
  const duplicate = model.segments.filter((item) => item.state === 'duplicate');
  const offline = model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed');
  return {
    pending: pending.length,
    stale: stale.length,
    duplicate: duplicate.length,
    offline: offline.length,
    backlog: pending.length + stale.length + duplicate.length + offline.length,
    oldestWaitSeconds: pending.length ? Math.max(...pending.map((item) => Math.round((Date.now() - item.receivedAt) / 1000))) : 0,
  };
}

export function createLiveSegment(sequence: number): CaptionSegment {
  const speakers = ['主持人', '主讲人', '嘉宾 / 周然', '现场提问'];
  const samples = [
    '接下来请产品团队介绍新的工作流。',
    '请注意屏幕右侧的实时队列状态。',
    '在弱网环境下我们会保留未确认片段。',
    '如果网络恢复,系统会按照时间顺序自动合并。',
    '这段字幕包含二零二五年的项目数据。',
    '大家可以会后查看完整回放和术语表。',
  ];
  const start = Math.max(0, sequence * 9 - 10);
  return {
    id: `seg-live-${sequence}-${Date.now().toString(36)}`,
    sequence,
    startTime: start,
    receivedAt: Date.now(),
    speaker: speakers[(sequence - 1) % speakers.length],
    original: samples[(sequence - 1) % samples.length],
    corrected: samples[(sequence - 1) % samples.length],
    numberHints: '',
    source: 'live',
    state: 'pending',
    revision: 0,
    tags: [],
  };
}

export function simulateLatency(model: DeskModel): DeskModel {
  if (model.connection === 'offline') return model;
  const step = model.connection === 'degraded' ? 0.7 : model.simulatedDelay > 2.8 ? -0.3 : 0.15;
  const delay = Math.max(0.7, Math.min(8.9, Number((model.simulatedDelay + step).toFixed(1))));
  const applyStream = model.autoStream && Math.random() > 0.68;
  let nextSequence = model.nextSequence;
  let segments = model.segments;
  if (applyStream) {
    const candidate = createLiveSegment(model.nextSequence);
    const duplicate = isDuplicate(candidate, segments);
    segments = [...segments, duplicate ? { ...candidate, state: 'duplicate', duplicateOf: duplicate.id, staleReason: `与第 ${duplicate.sequence} 段重复` } : candidate];
    nextSequence += 1;
  }
  const pendingCutoff = Date.now() - 90_000;
  segments = segments.map((item) => item.state === 'pending' && item.receivedAt < pendingCutoff
    ? { ...item, state: 'stale', staleReason: `片段已等待 ${Math.round((Date.now() - item.receivedAt) / 1000)} 秒` }
    : item);
  return {
    ...model,
    segments,
    nextSequence,
    simulatedDelay: delay,
    connection: delay > 4.2 ? 'degraded' : model.connection,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 演示用术语包：一个干净升级包 + 一个含同版本规则冲突的失败包
// ---------------------------------------------------------------------------

export const SAMPLE_PACKAGE_V2: TermPackage = {
  version: '2.0.0',
  releasedAt: now - 90_000,
  note: '直播中途下发：品牌升级与五G商用命名更新',
  rules: [
    packageRule('v2-co-pilot', 'co pilot', 'Copilot'),
    packageRule('v2-studio-cloud', 'studio cloud', 'StudioCloud'),
    packageRule('v2-five-g', '五G', '5G网络', true),
    packageRule('v2-launch', '产品发布会', '全球产品发布会'),
    packageRule('v2-demo', '演示环境', '体验环境'),
  ],
};

export const SAMPLE_PACKAGE_V3_CONFLICT: TermPackage = {
  version: '3.0.0',
  releasedAt: now - 30_000,
  note: '含同版本规则冲突，整包导入应当失败并留下检查点',
  rules: [
    packageRule('v3-ai-1', '人工智能', 'AI'),
    packageRule('v3-ai-2', 'AI', '人工智能'),
    packageRule('v3-brand-a', '云平台', 'Cloud Platform'),
    packageRule('v3-brand-b', '云平台', '公有云平台'),
    packageRule('v3-empty', '', '缺失原文'),
  ],
};
