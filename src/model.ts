export type ConnectionState = 'connected' | 'degraded' | 'offline';
export type SegmentState = 'pending' | 'confirmed' | 'duplicate' | 'stale' | 'ignored';
export type SegmentSource = 'live' | 'offline' | 'manual';
export type ImportStatus = 'failed' | 'applied';

export interface CaptionSegment {
  id: string;
  sequence: number;
  startTime: number;
  receivedAt: number;
  confirmedAt?: number;
  speaker: string;
  original: string;
  corrected: string;
  numberHints: string;
  source: SegmentSource;
  state: SegmentState;
  duplicateOf?: string;
  staleReason?: string;
  revision: number;
  tags: string[];
  /** 确认时锁定的术语包版本；导出与回放都按这个版本取字幕 */
  termVersion?: string;
  /** 确认时纯由规则生成的文本，用于识别人工修改 */
  termBaseline?: string;
  /** 含人工修改（确认前或确认后），对账批量升级时受保护，不自动覆盖 */
  manualEdited?: boolean;
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
  /** 来自哪个术语包；缺省表示校对员在台上新建的本地规则 */
  packageVersion?: string;
}

/** 术语包下发的输入事实：只有规则，没有任何字幕改动 */
export interface TermPackageInput {
  version: string;
  releasedAt?: number;
  note?: string;
  rules: Array<{
    id?: string;
    source: string;
    replacement: string;
    speaker?: string;
    enabled?: boolean;
    caseSensitive?: boolean;
  }>;
}

export interface TermPackage {
  version: string;
  releasedAt: number;
  note: string;
  /** 整包快照：回放/导出/对账都只认这里的事实 */
  rules: TermRule[];
  appliedAt: number;
}

/** 同一版本内（或与已应用的同版本包之间）同原文对应不同替换的冲突 */
export interface TermConflict {
  source: string;
  speaker: string;
  replacements: string[];
}

/** 整包导入失败后留下的检查点，重试按版本+摘要幂等，不重复应用 */
export interface ImportCheckpoint {
  id: string;
  version: string;
  digest: string;
  raw: string;
  reason: string;
  conflicts: TermConflict[];
  attempts: number;
  status: ImportStatus;
  createdAt: number;
  updatedAt: number;
}

/** 对账报告条目：某段从锁定版本升级到目标版本后的候选文本 */
export interface ReconcileCandidate {
  segmentId: string;
  sequence: number;
  speaker: string;
  current: string;
  proposed: string;
  fromVersion: string;
  toVersion: string;
  manualEdited: boolean;
  changedRules: Array<{ source: string; before: string; after: string }>;
}

export interface DeskModel {
  eventName: string;
  eventDate: string;
  segments: CaptionSegment[];
  rules: TermRule[];
  selectedId: string;
  connection: ConnectionState;
  simulatedDelay: number;
  fontSize: number;
  nextSequence: number;
  autoStream: boolean;
  lastMergedAt?: number;
  updatedAt: number;
  /** 当前生效的术语包版本 */
  activeVersion: string;
  /** 已成功导入的术语包账本（含每个版本的规则快照） */
  termPackages: TermPackage[];
  /** 导入检查点（失败必留，成功后标记 applied） */
  importCheckpoints: ImportCheckpoint[];
}

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle: string;
}

const now = Date.now();
export const STORAGE_KEY = 'sologsb-1011-live-caption-desk-v1';
export const INITIAL_TERM_VERSION = 'v1';
const CHECKPOINT_LIMIT = 20;

// ───────────────────────── 术语包解析与导入 ─────────────────────────

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 规则的匹配身份：发言人范围 + 大小写要求 + 原文 */
export function ruleKey(rule: { source: string; caseSensitive?: boolean; speaker?: string }): string {
  return `${rule.speaker?.trim() ?? ''}::${rule.caseSensitive ? 'cs' : 'ci'}::${rule.source.trim().toLocaleLowerCase()}`;
}

function conflictKey(rule: { source: string; speaker?: string }): string {
  return `${rule.speaker?.trim() ?? ''}::${rule.source.trim()}`;
}

export type PackageAnalysis =
  | { ok: true; data: TermPackageInput; raw: string; digest: string; conflicts: TermConflict[] }
  | { ok: false; reason: string; version: string; raw: string };

function collectConflicts(rules: TermPackageInput['rules']): TermConflict[] {
  const groups = new Map<string, TermConflict>();
  for (const rule of rules) {
    const key = conflictKey(rule);
    const group = groups.get(key) ?? { source: rule.source.trim(), speaker: rule.speaker?.trim() ?? '', replacements: [] };
    if (!group.replacements.includes(rule.replacement)) group.replacements.push(rule.replacement);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.replacements.length > 1);
}

/** 只做解析和事实校验，绝不改动任何字幕或模型 */
export function analyzeTermPackage(raw: string): PackageAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败：${(error as Error).message}`, version: '（无法识别）', raw };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: '术语包必须是 JSON 对象', version: '（无法识别）', raw };
  }
  const data = parsed as Partial<TermPackageInput>;
  const version = typeof data.version === 'string' ? data.version.trim() : '';
  if (!version) return { ok: false, reason: '缺少版本号字段 version', version: '（无法识别）', raw };
  if (!Array.isArray(data.rules)) return { ok: false, reason: '缺少规则数组 rules', version, raw };

  const rules: TermPackageInput['rules'] = [];
  for (let index = 0; index < data.rules.length; index += 1) {
    const rule = data.rules[index];
    if (!rule || typeof rule !== 'object') return { ok: false, reason: `第 ${index + 1} 条规则不是对象`, version, raw };
    if (typeof rule.source !== 'string' || !rule.source.trim()) {
      return { ok: false, reason: `第 ${index + 1} 条规则缺少原文 source`, version, raw };
    }
    if (typeof rule.replacement !== 'string') {
      return { ok: false, reason: `第 ${index + 1} 条规则缺少替换文本 replacement`, version, raw };
    }
    rules.push({
      source: rule.source.trim(),
      replacement: rule.replacement,
      speaker: typeof rule.speaker === 'string' ? rule.speaker.trim() : '',
      enabled: rule.enabled !== false,
      caseSensitive: rule.caseSensitive === true,
    });
  }

  const conflicts = collectConflicts(rules);
  const digest = hashString(`${version}|${JSON.stringify(rules)}`);
  return { ok: true, data: { version, releasedAt: data.releasedAt, note: data.note, rules }, raw, digest, conflicts };
}

/** 同版本新包与已应用包之间的事实分歧（同原文、不同替换） */
function crossPackageConflicts(incoming: TermPackageInput, applied: TermPackage): TermConflict[] {
  const conflicts: TermConflict[] = [];
  for (const rule of incoming.rules) {
    const twin = applied.rules.find((item) => conflictKey(item) === conflictKey(rule));
    if (twin && twin.replacement !== rule.replacement) {
      conflicts.push({
        source: rule.source,
        speaker: rule.speaker ?? '',
        replacements: [twin.replacement, rule.replacement],
      });
    }
  }
  return conflicts;
}

export interface ImportTermResult {
  ok: boolean;
  skipped: boolean;
  version: string;
  reason: string;
  conflicts: TermConflict[];
  model: DeskModel;
}

function upsertCheckpoint(model: DeskModel, checkpoint: ImportCheckpoint): ImportCheckpoint[] {
  const others = model.importCheckpoints.filter((item) => item.id !== checkpoint.id);
  return [checkpoint, ...others].slice(0, CHECKPOINT_LIMIT);
}

function failureCheckpoint(version: string, raw: string, reason: string, conflicts: TermConflict[], digest: string, attempts: number): ImportCheckpoint {
  const timestamp = Date.now();
  const safeDigest = digest || hashString(raw).slice(0, 8);
  return {
    id: `ckpt-${version}-${safeDigest}`.replace(/[^\w一-鿿.-]+/g, '-'),
    version,
    digest: safeDigest,
    raw,
    reason,
    conflicts,
    attempts,
    status: 'failed',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 整包导入术语包：包只提供规则事实。
 * - 包内同版本规则冲突 → 整包拒绝，留下失败检查点
 * - 同版本号但内容与已应用包冲突 → 整包拒绝，冲突先列出来
 * - 版本+摘要已应用 → 跳过，重试不会重复应用
 * - 成功只更新规则账本和当前规则，绝不改动任何已播/待播字幕
 */
export function importTermPackage(model: DeskModel, raw: string): ImportTermResult {
  const analysis = analyzeTermPackage(raw);
  const previousByRaw = model.importCheckpoints.find((item) => item.raw === raw);

  if (!analysis.ok) {
    const attempts = (previousByRaw?.attempts ?? 0) + 1;
    const digest = previousByRaw?.digest ?? hashString(raw).slice(0, 8);
    const checkpoint = failureCheckpoint(analysis.version, raw, analysis.reason, [], digest, attempts);
    return {
      ok: false,
      skipped: false,
      version: analysis.version,
      reason: analysis.reason,
      conflicts: [],
      model: { ...model, importCheckpoints: upsertCheckpoint(model, { ...(previousByRaw ?? checkpoint), ...checkpoint, createdAt: previousByRaw?.createdAt ?? checkpoint.createdAt, attempts }) },
    };
  }

  const previous = previousByRaw
    ?? model.importCheckpoints.find((item) => item.version === analysis.data.version && item.digest === analysis.digest);
  const attempts = (previous?.attempts ?? 0) + 1;
  const applied = model.termPackages.find((item) => item.version === analysis.data.version);

  if (analysis.conflicts.length > 0) {
    const reason = `术语包 ${analysis.data.version} 内有 ${analysis.conflicts.length} 组规则冲突，整包未导入`;
    const checkpoint = failureCheckpoint(analysis.data.version, raw, reason, analysis.conflicts, analysis.digest, attempts);
    return {
      ok: false,
      skipped: false,
      version: analysis.data.version,
      reason,
      conflicts: analysis.conflicts,
      model: { ...model, importCheckpoints: upsertCheckpoint(model, { ...(previous ?? checkpoint), ...checkpoint, createdAt: previous?.createdAt ?? checkpoint.createdAt, attempts }) },
    };
  }

  if (applied) {
    const sameContent = hashString(`${applied.version}|${JSON.stringify(applied.rules.map((rule) => ({ source: rule.source, replacement: rule.replacement, speaker: rule.speaker, enabled: rule.enabled, caseSensitive: rule.caseSensitive })))}`) === analysis.digest;
    if (sameContent) {
      // 幂等：同一个包重试或重复下发，不重复应用
      return { ok: true, skipped: true, version: applied.version, reason: '该术语包已应用，跳过重复导入', conflicts: [], model };
    }
    const conflicts = crossPackageConflicts(analysis.data, applied);
    const reason = conflicts.length
      ? `版本号 ${applied.version} 已应用且与新包存在 ${conflicts.length} 组规则冲突，整包未导入`
      : `版本号 ${applied.version} 已被占用，请使用新的版本号`;
    const checkpoint = failureCheckpoint(analysis.data.version, raw, reason, conflicts, analysis.digest, attempts);
    return {
      ok: false,
      skipped: false,
      version: applied.version,
      reason,
      conflicts,
      model: { ...model, importCheckpoints: upsertCheckpoint(model, { ...(previous ?? checkpoint), ...checkpoint, createdAt: previous?.createdAt ?? checkpoint.createdAt, attempts }) },
    };
  }

  const timestamp = Date.now();
  const previousActiveByKey = new Map(model.rules.map((rule) => [ruleKey(rule), rule]));
  const localRules = model.rules.filter((rule) => !rule.packageVersion);
  const packageRules: TermRule[] = analysis.data.rules.map((rule) => {
    const prior = previousActiveByKey.get(ruleKey(rule));
    return {
      id: prior?.id ?? `rule-${hashString(analysis.data.version + ruleKey(rule)).slice(0, 10)}`,
      source: rule.source,
      replacement: rule.replacement,
      speaker: rule.speaker ?? '',
      enabled: rule.enabled !== false,
      caseSensitive: rule.caseSensitive === true,
      usageCount: prior?.usageCount ?? 0,
      createdAt: timestamp,
      packageVersion: analysis.data.version,
    };
  });

  const snapshot: TermPackage = {
    version: analysis.data.version,
    releasedAt: analysis.data.releasedAt ?? timestamp,
    note: analysis.data.note ?? '',
    rules: packageRules,
    appliedAt: timestamp,
  };

  let checkpoints = model.importCheckpoints;
  if (previous) {
    const marked: ImportCheckpoint = { ...previous, status: 'applied', attempts, updatedAt: timestamp };
    checkpoints = upsertCheckpoint(model, marked);
  }

  return {
    ok: true,
    skipped: false,
    version: snapshot.version,
    reason: '',
    conflicts: [],
    model: {
      ...model,
      rules: [...packageRules, ...localRules],
      activeVersion: snapshot.version,
      termPackages: [...model.termPackages, snapshot],
      importCheckpoints: checkpoints,
    },
  };
}

/** 从检查点重试：仍走同一套整包校验，失败不产生半应用状态 */
export function retryImportCheckpoint(model: DeskModel, checkpointId: string): ImportTermResult {
  const checkpoint = model.importCheckpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) return { ok: false, skipped: false, version: '', reason: '检查点不存在', conflicts: [], model };
  return importTermPackage(model, checkpoint.raw);
}

export function removeCheckpoint(model: DeskModel, checkpointId: string): DeskModel {
  return { ...model, importCheckpoints: model.importCheckpoints.filter((item) => item.id !== checkpointId) };
}

// ───────────────────────── 规则应用 ─────────────────────────

export function rulesForVersion(model: DeskModel, version?: string): TermRule[] {
  const pkg = model.termPackages.find((item) => item.version === version);
  const local = model.rules.filter((rule) => !rule.packageVersion);
  return pkg ? [...pkg.rules, ...local] : local;
}

export function applyRules(text: string, rules: TermRule[], speaker = ''): { text: string; used: string[] } {
  let next = text;
  const used: string[] = [];
  for (const rule of rules.filter((item) => item.enabled && (!item.speaker || item.speaker === speaker))) {
    if (!rule.source || !next) continue;
    const expression = new RegExp(escapeRegExp(rule.source), rule.caseSensitive ? 'g' : 'gi');
    if (expression.test(next)) {
      next = next.replace(expression, () => rule.replacement.replace(/\$/g, '$$$$'));
      used.push(rule.id);
    }
  }
  return { text: normalizePunctuation(next), used };
}

// ───────────────────────── 版本对账 ─────────────────────────

interface DeltaRule {
  expression: RegExp;
  replacement: string;
  source: string;
  before: string;
  after: string;
}

/**
 * 从锁定版本升级到目标版本所需的增量规则（按目标包顺序）：
 * - 替换发生变化的规则：把旧版本已产出的词直接换成新替换词
 * - 新版本新增规则：按新原文匹配
 */
function buildDelta(model: DeskModel, fromVersion: string | undefined, toVersion: string): DeltaRule[] {
  const base = new Map(rulesForVersion(model, fromVersion).map((rule) => [ruleKey(rule), rule]));
  const target = rulesForVersion(model, toVersion);
  const delta: DeltaRule[] = [];
  for (const rule of target) {
    const before = base.get(ruleKey(rule));
    if (!before) {
      delta.push({
        expression: new RegExp(escapeRegExp(rule.source), rule.caseSensitive ? 'g' : 'gi'),
        replacement: rule.replacement,
        source: rule.source,
        before: rule.source,
        after: rule.replacement,
      });
    } else if (before.replacement !== rule.replacement) {
      delta.push({
        expression: new RegExp(escapeRegExp(before.replacement), rule.caseSensitive ? 'g' : 'gi'),
        replacement: rule.replacement,
        source: rule.source,
        before: before.replacement,
        after: rule.replacement,
      });
    }
  }
  return delta;
}

function proposeUpgrade(segment: CaptionSegment, model: DeskModel, toVersion: string): Omit<ReconcileCandidate, 'segmentId' | 'sequence' | 'manualEdited'> | undefined {
  if (segment.termVersion === toVersion) return undefined;
  const scoped = buildDelta(model, segment.termVersion, toVersion)
    .filter((item) => {
      const rule = rulesForVersion(model, toVersion).find((candidate) => candidate.source === item.source);
      return rule && (!rule.speaker || rule.speaker === segment.speaker);
    });
  let proposed = segment.corrected;
  const changedRules: ReconcileCandidate['changedRules'] = [];
  for (const delta of scoped) {
    if (delta.expression.test(proposed)) {
      proposed = proposed.replace(delta.expression, () => delta.replacement.replace(/\$/g, '$$$$'));
      changedRules.push({ source: delta.source, before: delta.before, after: delta.after });
    }
  }
  proposed = normalizePunctuation(proposed);
  if (proposed === segment.corrected) return undefined;
  return {
    speaker: segment.speaker,
    current: segment.corrected,
    proposed,
    fromVersion: segment.termVersion ?? INITIAL_TERM_VERSION,
    toVersion,
    changedRules,
  };
}

/** 重新检查：只生成报告，绝不改写字幕；人工改过的段落会被标出来由人决定 */
export function reconcileSegments(model: DeskModel, toVersion = model.activeVersion): ReconcileCandidate[] {
  const candidates: ReconcileCandidate[] = [];
  for (const segment of model.segments) {
    if (segment.state !== 'confirmed') continue;
    const proposal = proposeUpgrade(segment, model, toVersion);
    if (!proposal) continue;
    candidates.push({
      ...proposal,
      segmentId: segment.id,
      sequence: segment.sequence,
      manualEdited: segment.manualEdited === true,
    });
  }
  return candidates.sort((a, b) => Number(b.manualEdited) - Number(a.manualEdited) || a.sequence - b.sequence);
}

/** 校对员逐条采纳对账建议：人工修改原样保留，只升级术语版本锁定 */
export function adoptReconciliation(model: DeskModel, segmentId: string, toVersion = model.activeVersion): DeskModel {
  const segment = model.segments.find((item) => item.id === segmentId);
  if (!segment || segment.state !== 'confirmed') return model;
  const proposal = proposeUpgrade(segment, model, toVersion);
  if (!proposal) return model;
  return {
    ...model,
    segments: model.segments.map((item) => item.id === segmentId ? {
      ...item,
      corrected: proposal.proposed,
      termVersion: toVersion,
      // 人工改过的内容升级后仍保留受保护标记；纯规则段落同步基线
      termBaseline: item.manualEdited ? item.termBaseline : proposal.proposed,
      revision: item.revision + 1,
      tags: [...new Set([...item.tags, `对账升级至 ${toVersion}`])],
    } : item),
  };
}

// ───────────────────────── 种子数据与迁移 ─────────────────────────

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

function seedV1Rules(): TermRule[] {
  return [
    { id: 'term-1', source: 'co pilot', replacement: 'Co-Pilot', speaker: '', enabled: true, caseSensitive: false, usageCount: 4, createdAt: now - 86_400_000, packageVersion: INITIAL_TERM_VERSION },
    { id: 'term-2', source: 'studio cloud', replacement: 'Studio Cloud', speaker: '', enabled: true, caseSensitive: false, usageCount: 7, createdAt: now - 43_200_000, packageVersion: INITIAL_TERM_VERSION },
    { id: 'term-3', source: '五G', replacement: '5G', speaker: '', enabled: true, caseSensitive: true, usageCount: 2, createdAt: now - 3_600_000, packageVersion: INITIAL_TERM_VERSION },
  ];
}

export function createInitialModel(): DeskModel {
  const v1Snapshot: TermPackage = {
    version: INITIAL_TERM_VERSION,
    releasedAt: now - 3_600_000,
    note: '开播前下发的首版术语表',
    rules: seedV1Rules(),
    appliedAt: now - 3_600_000,
  };

  const seededSegments: CaptionSegment[] = [
    segment('seg-1', 1, 0, '主持人', '欢迎大家来到二零二六年产品发布会。', '欢迎大家来到2026年产品发布会。', 'confirmed'),
    segment('seg-2', 2, 7, '主讲人', '今天我们会介绍三个模块,首先是 co pilot 实时协作。', '今天我们会介绍三个模块，首先是 Co-Pilot 的实时协作。', 'confirmed'),
    segment('seg-3', 3, 15, '主讲人', '延迟和质量监测会帮助我们保持字幕稳定。', '延迟和质量监测会帮助我们保持字幕稳定。', 'confirmed'),
    segment('seg-4', 4, 24, '嘉宾 / 周然', '我们使用 studio cloud 作为演示环境。', '我们使用 Studio Cloud 作为演示环境。', 'pending'),
    segment('seg-5', 5, 34, '嘉宾 / 周然', '每分钟大约会收到一百二十个片段。', '每分钟大约会收到120个片段。', 'pending'),
    segment('seg-6', 6, 43, '主持人', '如果主持人提到 co pilot,需要统一大小写。', '如果主持人提到 Co-Pilot，需要统一大小写。', 'pending'),
    segment('seg-7', 7, 52, '主持人', '这个例子会演示五G网络下的字幕恢复。', '这个例子会演示5G网络下的字幕恢复。', 'pending'),
  ];

  const duplicate: CaptionSegment = {
    ...segment('seg-8', 8, 9, '主讲人', '今天我们会介绍三个模块,首先是 co pilot 实时协作。', '今天我们会介绍三个模块,首先是 co pilot 实时协作。', 'duplicate'),
    source: 'live',
    duplicateOf: 'seg-2',
    staleReason: '与第 2 段高度相似',
  };

  // 每段确认时锁定 v1，并记下纯规则基线，识别人工修改
  const baseline = createBaselineModel(v1Snapshot);
  const withVersions = [...seededSegments, duplicate].map((item) => {
    if (item.state !== 'confirmed') return item;
    const { text } = applyRules(item.original, rulesForVersion(baseline, INITIAL_TERM_VERSION), item.speaker);
    return {
      ...item,
      termVersion: INITIAL_TERM_VERSION,
      termBaseline: text,
      manualEdited: item.corrected !== text,
    };
  });

  return {
    eventName: '新品发布会现场字幕',
    eventDate: new Date(now).toISOString().slice(0, 10),
    segments: withVersions,
    rules: seedV1Rules(),
    selectedId: 'seg-4',
    connection: 'connected',
    simulatedDelay: 1.8,
    fontSize: 18,
    nextSequence: 9,
    autoStream: true,
    activeVersion: INITIAL_TERM_VERSION,
    termPackages: [v1Snapshot],
    importCheckpoints: [],
    updatedAt: now,
  };
}

function createBaselineModel(snapshot: TermPackage): DeskModel {
  return {
    eventName: '', eventDate: '', segments: [], rules: snapshot.rules, selectedId: '',
    connection: 'connected', simulatedDelay: 0, fontSize: 18, nextSequence: 1, autoStream: false,
    activeVersion: snapshot.version, termPackages: [snapshot], importCheckpoints: [], updatedAt: 0,
  };
}

/** 兼容旧版本草稿：补齐术语版本账本并给已确认段补锁版本 */
export function migrateModel(parsed: DeskModel): DeskModel {
  const model = parsed;
  if (!Array.isArray(model.termPackages) || model.termPackages.length === 0) {
    const stamped = model.rules.map((rule) => ({ ...rule, packageVersion: rule.packageVersion ?? INITIAL_TERM_VERSION }));
    const snapshot: TermPackage = {
      version: INITIAL_TERM_VERSION,
      releasedAt: model.updatedAt ?? Date.now(),
      note: '由旧版本地草稿迁移的首版术语表',
      rules: stamped,
      appliedAt: model.updatedAt ?? Date.now(),
    };
    model.rules = stamped;
    model.termPackages = [snapshot];
  }
  model.activeVersion ??= model.termPackages[model.termPackages.length - 1].version;
  model.importCheckpoints ??= [];
  model.segments = model.segments.map((item) => {
    if (item.state !== 'confirmed' || item.termVersion) return item;
    const { text } = applyRules(item.original, rulesForVersion(model, INITIAL_TERM_VERSION), item.speaker);
    return { ...item, termVersion: INITIAL_TERM_VERSION, termBaseline: text, manualEdited: item.corrected !== text };
  });
  return model;
}

export function cloneModel(model: DeskModel): DeskModel {
  return structuredClone(model);
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

export function isDuplicate(candidate: CaptionSegment, existing: CaptionSegment[]): CaptionSegment | undefined {
  const normalize = (value: string) => value.replace(/[\s，。！？；：,.;:!?]/g, '').toLocaleLowerCase();
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
    oldestWaitSeconds: pending.length ? Math.max(...pending.map((item) => Math.max(0, Math.round((Date.now() - item.receivedAt) / 1000)))) : 0,
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
    '大家可以在会后查看完整回放和术语表。',
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

export function toSrt(model: DeskModel): string {
  const stamp = (seconds: number, separator = ',') => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
  };
  // 导出直接读取每段确认时锁定并保存下来的 corrected，不会被新术语包悄悄改写
  return model.segments
    .filter((item) => item.state === 'confirmed')
    .sort((a, b) => a.startTime - b.startTime)
    .map((item, index) => `${index + 1}\n${stamp(item.startTime)} --> ${stamp(item.startTime + 7)}\n[${item.speaker}] ${item.corrected}\n`)
    .join('\n');
}

/** 导出/回放的版本分布：各确认版本对应多少段 */
export function confirmedVersionBreakdown(model: DeskModel): Array<{ version: string; count: number }> {
  const counts = new Map<string, number>();
  for (const segment of model.segments) {
    if (segment.state !== 'confirmed') continue;
    const version = segment.termVersion ?? INITIAL_TERM_VERSION;
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  return [...counts.entries()].map(([version, count]) => ({ version, count }));
}
