import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  acceptReconciliation,
  buildTermSnapshot,
  cloneModel,
  createInitialModel,
  discardCheckpoint,
  importTermPackage,
  latestPackage,
  loadStoredModel,
  mergeConfirmedSegments,
  normalizeNumbers,
  queueStats,
  reconciliationReport,
  renderWithRules,
  retryCheckpoint,
  STORAGE_KEY,
  simulateLatency,
  toSrt,
  SAMPLE_PACKAGE_V2,
  SAMPLE_PACKAGE_V3_CONFLICT,
  effectiveRules,
  type CaptionSegment,
  type ConnectionState,
  type DeskModel,
  type ImportResult,
  type ReconcileItem,
  type ReconcileStatus,
  type SegmentState,
  type TermPackage,
  type ToastMessage,
} from './model';

const HISTORY_LIMIT = 80;

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
}

function stateLabel(state: SegmentState): string {
  return {
    pending: '待确认',
    confirmed: '已确认',
    duplicate: '重复片段',
    stale: '过期修改',
    ignored: '已忽略',
  }[state];
}

function connectionLabel(state: ConnectionState): string {
  return { connected: '连接稳定', degraded: '延迟波动', offline: '离线校正' }[state];
}

@customElement('caption-desk')
export class CaptionDesk extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      --caption-font-size: 18px;
      color: var(--cds-text-primary, #161616);
      background: var(--cds-background, #f4f4f4);
      font-family: "IBM Plex Sans", "PingFang SC", sans-serif;
    }

    * { box-sizing: border-box; }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
      background:
        linear-gradient(90deg, rgba(15,98,254,.025) 1px, transparent 1px),
        linear-gradient(rgba(15,98,254,.025) 1px, transparent 1px),
        var(--cds-background, #f4f4f4);
      background-size: 24px 24px;
    }

    .shell.dark {
      --cds-background: #161616;
      --cds-layer: #262626;
      --cds-layer-01: #262626;
      --cds-layer-02: #393939;
      --cds-field: #262626;
      --cds-text-primary: #f4f4f4;
      --cds-text-secondary: #c6c6c6;
      --cds-border-subtle: #393939;
      --cds-border-strong: #6f6f6f;
      color: #f4f4f4;
    }

    .topbar {
      min-height: 64px;
      padding: 8px 18px 8px 20px;
      display: grid;
      grid-template-columns: minmax(330px, 1fr) auto minmax(420px, 1fr);
      align-items: center;
      gap: 20px;
      background: #161616;
      color: #f4f4f4;
      border-bottom: 1px solid #393939;
      position: relative;
      z-index: 5;
    }

    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-mark {
      width: 38px; height: 38px; display: grid; place-items: center;
      border: 1px solid #78a9ff; color: #78a9ff; font: 600 11px/1 "IBM Plex Mono", monospace;
      clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
    }
    .brand-copy { min-width: 0; }
    .brand-copy strong { display: block; font-size: 15px; letter-spacing: .015em; white-space: nowrap; }
    .brand-copy span { display: block; color: #a8a8a8; font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .connection-pill {
      justify-self: center; display: flex; align-items: center; gap: 10px; padding: 8px 13px;
      min-width: 260px; background: #262626; border: 1px solid #525252;
    }
    .connection-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #42be65; box-shadow: 0 0 0 4px rgba(66,190,101,.13); }
    .connection-pill.degraded .connection-dot { background: #f1c21b; box-shadow: 0 0 0 4px rgba(241,194,27,.14); }
    .connection-pill.offline .connection-dot { background: #fa4d56; box-shadow: 0 0 0 4px rgba(250,77,86,.14); }
    .connection-copy { min-width: 0; }
    .connection-copy strong { display: block; font-size: 12px; }
    .connection-copy small { display: block; color: #c6c6c6; margin-top: 2px; font-size: 10px; }

    .header-actions { justify-self: end; display: flex; align-items: center; gap: 8px; }
    .header-actions cds-button { --cds-button-primary: #0f62fe; }

    .status-strip {
      min-height: 60px; padding: 8px 20px; display: grid; grid-template-columns: 1.5fr repeat(4, minmax(118px, .6fr)) auto;
      gap: 0; align-items: stretch; background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .status-cell { padding: 7px 16px; border-right: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; flex-direction: column; justify-content: center; }
    .status-cell:first-child { padding-left: 4px; }
    .status-cell:last-child { border-right: 0; }
    .status-cell strong { font-size: 20px; font-weight: 400; line-height: 1.05; font-variant-numeric: tabular-nums; }
    .status-cell span { margin-top: 3px; color: var(--cds-text-secondary, #525252); font-size: 10px; letter-spacing: .03em; }
    .status-cell.warning strong, .status-cell.warning span { color: #b28600; }
    .status-cell.danger strong, .status-cell.danger span { color: #da1e28; }
    .status-cell.hero strong { font-size: 14px; }
    .queue-track { width: 100%; height: 3px; margin-top: 6px; background: #e0e0e0; }
    .queue-track > span { display: block; height: 100%; background: #0f62fe; transition: width .3s ease; }
    .font-controls { min-width: 190px; padding: 7px 4px 7px 18px; display: flex; align-items: center; gap: 8px; }
    .font-controls label { color: var(--cds-text-secondary, #525252); font-size: 10px; }

    .workspace {
      min-height: 0; display: grid; grid-template-columns: minmax(390px, .95fr) minmax(430px, 1.05fr) minmax(370px, .9fr);
      gap: 1px; background: var(--cds-border-subtle, #e0e0e0); overflow: hidden;
    }

    .column { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--cds-background, #f4f4f4); }
    .column-head {
      min-height: 62px; padding: 11px 14px 9px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: var(--cds-layer, #fff); border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0);
    }
    .column-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .column-head p { margin: 4px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .column-body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: #8d8d8d transparent; }

    .segment-list { padding: 8px; display: flex; flex-direction: column; gap: 1px; }
    .segment-card {
      width: 100%; border: 0; border-left: 3px solid transparent; background: var(--cds-layer, #fff);
      color: inherit; text-align: left; padding: 11px 12px 10px 14px; cursor: pointer; position: relative;
    }
    .segment-card:hover { background: var(--cds-layer-hover, #e8e8e8); }
    .segment-card.selected { border-left-color: #0f62fe; background: var(--cds-layer-selected, #edf5ff); outline: 1px solid #78a9ff; }
    .segment-card.duplicate { border-left-color: #a56eff; }
    .segment-card.stale { border-left-color: #f1c21b; background: color-mix(in srgb, #fff 92%, #f1c21b 8%); }
    .segment-card.confirmed { border-left-color: #42be65; }
    .segment-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
    .segment-meta > span:first-child { color: var(--cds-text-secondary, #525252); font: 500 10px/1 "IBM Plex Mono", monospace; }
    .segment-state { font-size: 10px; color: #525252; }
    .segment-state.stale { color: #8d6e00; }
    .segment-state.duplicate { color: #6929c4; }
    .segment-state.confirmed { color: #198038; }
    .segment-text { margin: 0; font-size: var(--caption-font-size); line-height: 1.5; }
    .segment-corrected { margin: 6px 0 0; padding-left: 8px; border-left: 2px solid #42be65; color: #198038; font-size: calc(var(--caption-font-size) * .88); line-height: 1.45; }
    .segment-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .segment-foot b { color: #0f62fe; font-weight: 500; }
    .issue-note { margin-top: 8px; padding: 7px 8px; background: #fff8e1; border-left: 2px solid #f1c21b; color: #684e00; font-size: 10px; line-height: 1.45; }
    .duplicate-note { background: #f6f2ff; border-color: #a56eff; color: #491d8b; }

    .empty { padding: 48px 24px; text-align: center; color: var(--cds-text-secondary, #525252); }
    .empty strong { display: block; color: var(--cds-text-primary, #161616); margin-bottom: 6px; }
    .empty p { margin: 0; font-size: 11px; line-height: 1.5; }

    .editor-scroll { padding: 14px; overflow: auto; }
    .editor-card { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .editor-top { padding: 12px 14px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; }
    .editor-time { color: #0f62fe; font: 500 12px/1.4 "IBM Plex Mono", monospace; }
    .editor-title { margin: 4px 0 0; font-size: 12px; color: var(--cds-text-secondary, #525252); }
    .editor-status { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .editor-form { padding: 14px; display: flex; flex-direction: column; gap: 13px; }
    .form-grid { display: grid; grid-template-columns: minmax(130px, .6fr) 1fr; gap: 12px; align-items: end; }
    .caption-input { min-height: 158px; --cds-body-compact-01-font-size: var(--caption-font-size); --cds-body-compact-02-font-size: var(--caption-font-size); }
    .edit-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .edit-toolbar > span { margin-right: 5px; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .number-input { width: 110px; }
    .rule-suggestions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .rule-suggestions small { color: var(--cds-text-secondary, #525252); }
    .confirm-bar { padding: 12px 14px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--cds-border-subtle, #e0e0e0); background: var(--cds-layer-02, #f4f4f4); }
    .confirm-hint { color: var(--cds-text-secondary, #525252); font-size: 10px; line-height: 1.4; }
    .confirm-hint kbd { padding: 3px 5px; border: 1px solid var(--cds-border-strong, #8d8d8d); background: var(--cds-layer, #fff); color: var(--cds-text-primary, #161616); font: 10px/1 "IBM Plex Mono", monospace; }

    .inspector { padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 14px; }
    .inspector-section { background: var(--cds-layer, #fff); border: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .inspector-section-head { padding: 10px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .inspector-section-head h3 { margin: 0; font-size: 12px; }
    .inspector-section-head span { color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-list { padding: 5px 0; }
    .rule-item { padding: 8px 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .rule-item:last-child { border-bottom: 0; }
    .rule-item strong { display: block; font-size: 11px; }
    .rule-item p { margin: 3px 0 0; color: var(--cds-text-secondary, #525252); font-size: 10px; }
    .rule-item-actions { display: flex; gap: 3px; }
    .rule-form { padding: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rule-form cds-text-input, .rule-form cds-button { width: 100%; }
    .rule-form .full { grid-column: 1 / -1; }
    .live-timeline { padding: 6px 0; }
    .live-item { padding: 8px 11px; border-left: 3px solid #42be65; margin: 0 10px 7px; background: var(--cds-layer-02, #f4f4f4); }
    .live-item time { color: #198038; font: 500 9px/1 "IBM Plex Mono", monospace; }
    .live-item p { margin: 5px 0 0; font-size: var(--caption-font-size); line-height: 1.45; }
    .live-item small { display: block; margin-top: 4px; color: var(--cds-text-secondary, #525252); font-size: 9px; }
    .delivery-status { margin: 0 10px 10px; padding: 9px 10px; background: #edf5ff; border-left: 3px solid #0f62fe; color: #0043ce; font-size: 10px; line-height: 1.45; }

    .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 20; width: 380px; display: flex; flex-direction: column; gap: 8px; }
    cds-toast-notification { box-shadow: 0 8px 22px rgba(0,0,0,.18); }

    /* ---- 术语版本对账 ---- */
    .version-banner { margin: 0; padding: 9px 12px; background: #edf5ff; border-bottom: 1px solid #78a9ff; color: #0043ce; font-size: 10px; line-height: 1.5; }
    .version-banner small { display: block; color: #525252; margin-top: 2px; }
    .pkg-list { padding: 4px 0; max-height: 170px; overflow: auto; }
    .pkg-item { padding: 8px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; }
    .pkg-item.active { background: #edf5ff; }
    .pkg-ver { font: 600 11px/1.2 "IBM Plex Mono", monospace; color: #0f62fe; }
    .pkg-item p { margin: 2px 0 0; font-size: 10px; color: var(--cds-text-secondary, #525252); line-height: 1.4; }
    .pkg-badge { font-size: 9px; padding: 2px 6px; border: 1px solid #42be65; color: #198038; white-space: nowrap; }
    .import-drop { margin: 10px; padding: 14px; border: 1px dashed #8d8d8d; text-align: center; font-size: 10px; color: var(--cds-text-secondary, #525252); cursor: pointer; line-height: 1.6; }
    .import-drop.dragging { border-color: #0f62fe; background: #edf5ff; color: #0043ce; }
    .import-drop strong { display: block; color: var(--cds-text-primary, #161616); font-size: 11px; }
    .import-actions { display: flex; gap: 6px; padding: 0 10px 10px; flex-wrap: wrap; }
    .import-textarea { margin: 0 10px 10px; }
    .import-textarea textarea { width: 100%; min-height: 90px; font: 10px/1.5 "IBM Plex Mono", monospace; }

    .checkpoint-item { margin: 8px 10px; padding: 9px 10px; background: #fff1f1; border-left: 3px solid #fa4d56; font-size: 10px; line-height: 1.5; }
    .checkpoint-item.resolved { background: #defbe6; border-left-color: #42be65; }
    .checkpoint-item strong { display: block; font-size: 11px; margin-bottom: 3px; }
    .checkpoint-item ul { margin: 5px 0; padding-left: 16px; color: #a2191f; }
    .checkpoint-item.resolved ul { color: #198038; }
    .checkpoint-actions { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }

    .reconcile-summary { padding: 8px 12px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); font-size: 10px; text-align: center; }
    .reconcile-summary b { display: block; font-size: 14px; font-weight: 400; font-variant-numeric: tabular-nums; }
    .reconcile-summary .n-clean b { color: #198038; }
    .reconcile-summary .n-manual b { color: #0f62fe; }
    .reconcile-summary .n-conflict b { color: #da1e28; }
    .reconcile-list { max-height: 320px; overflow: auto; padding: 4px 0; }
    .reconcile-item { padding: 8px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); }
    .reconcile-item.conflict { background: #fff1f1; }
    .reconcile-item.manual-preserved { background: #f4f8ff; }
    .reconcile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10px; margin-bottom: 5px; }
    .reconcile-head b { font: 500 10px/1 "IBM Plex Mono", monospace; color: var(--cds-text-secondary); }
    .status-pill { font-size: 9px; padding: 2px 7px; white-space: nowrap; }
    .status-pill.clean { background: #defbe6; color: #198038; }
    .status-pill.manual-preserved { background: #edf5ff; color: #0043ce; }
    .status-pill.conflict { background: #ffd7d9; color: #a2191f; }
    .status-pill.up-to-date, .status-pill.pending-segment { background: #e8e8e8; color: #525252; }
    .reconcile-text { margin: 0 0 4px; font-size: calc(var(--caption-font-size) * .78); line-height: 1.5; }
    .reconcile-text .tok-changed { background: #d7f3df; border-radius: 2px; padding: 0 1px; }
    .reconcile-text .tok-conflict { background: #ffd7d9; border-bottom: 2px wavy #da1e28; border-radius: 2px; padding: 0 1px; cursor: help; }
    .reconcile-aired { margin: 3px 0 0; font-size: 9px; color: var(--cds-text-secondary, #525252); line-height: 1.45; }
    .reconcile-aired s { opacity: .7; }
    .reconcile-msg { margin: 4px 0 0; font-size: 9px; color: var(--cds-text-secondary); }
    .reconcile-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .reconcile-editor { width: 100%; margin-top: 5px; }
    .reconcile-editor textarea { width: 100%; min-height: 48px; font-size: 11px; line-height: 1.5; }

    .playback-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); flex-wrap: wrap; }
    .playback-bar small { font-size: 10px; color: var(--cds-text-secondary); }
    .playback-list { max-height: 240px; overflow: auto; }
    .playback-item { padding: 7px 12px; border-bottom: 1px solid var(--cds-border-subtle, #e0e0e0); font-size: calc(var(--caption-font-size) * .78); line-height: 1.45; }
    .playback-item time { display: block; font: 500 9px/1.4 "IBM Plex Mono", monospace; color: #6f6f6f; }
    .playback-item.conflict { background: #fff1f1; }
    .playback-item .ver { float: right; font-size: 9px; color: #0f62fe; }
    .playback-note { padding: 7px 12px; font-size: 9px; color: #684e00; background: #fff8e1; border-left: 2px solid #f1c21b; line-height: 1.5; }

    @media (max-width: 1280px) {
      .workspace { grid-template-columns: minmax(340px, .85fr) minmax(410px, 1fr) minmax(330px, .85fr); }
      .status-strip { grid-template-columns: 1.4fr repeat(4, minmax(100px, .55fr)); }
      .font-controls { display: none; }
    }

    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr auto; }
      .connection-pill { grid-row: 2; grid-column: 1 / -1; justify-self: stretch; min-width: 0; }
      .workspace { grid-template-columns: 1fr; overflow: visible; }
      .column { min-height: 520px; }
      .shell { display: block; }
      .status-strip { grid-template-columns: repeat(4, 1fr); }
      .status-cell.hero { grid-column: 1 / -1; }
    }
  `;

  @state() private model: DeskModel = this.loadModel();
  @state() private dark = localStorage.getItem(`${STORAGE_KEY}-theme`) === 'dark';
  @state() private toasts: ToastMessage[] = [];
  @state() private ruleSource = '';
  @state() private ruleReplacement = '';
  @state() private ruleSpeaker = '';
  @state() private filter: 'active' | 'all' | 'attention' = 'active';
  @state() private showRuleForm = false;
  // 术语包导入
  @state() private showImportPanel = false;
  @state() private importText = '';
  @state() private importDragging = false;
  // 对账目标版本（默认当前生效版本的下一候选；否则为当前版本）
  @state() private reconcileVersion = '';
  @state() private reconcilingId = '';
  @state() private reconcileDraft = '';
  // 回放预览模式：aired=各段确认版本；否则为目标版本号
  @state() private playbackMode: string = 'aired';
  private past: DeskModel[] = [];
  private future: DeskModel[] = [];
  private ticker?: number;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleShortcut);
    this.ticker = window.setInterval(() => {
      const next = simulateLatency(this.model);
      const changed = JSON.stringify(next.segments) !== JSON.stringify(this.model.segments) || next.connection !== this.model.connection;
      if (!changed) return;
      this.model = next;
      this.persist();
    }, 5_000);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.handleShortcut);
    if (this.ticker) window.clearInterval(this.ticker);
    super.disconnectedCallback();
  }

  private loadModel(): DeskModel {
    return loadStoredModel() ?? createInitialModel();
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.model, updatedAt: Date.now() }));
  }

  private commit(label: string, update: (current: DeskModel) => DeskModel): void {
    const previous = cloneModel(this.model);
    const next = update(cloneModel(this.model));
    next.updatedAt = Date.now();
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    if (label) this.pushToast('info', label, '已写入浏览器本地草稿');
  }

  private automatic(next: DeskModel): void {
    this.model = next;
    this.persist();
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.pushToast('info', '没有可撤销的修改', '历史记录为空');
    this.future = [cloneModel(this.model), ...this.future].slice(0, HISTORY_LIMIT);
    this.model = previous;
    this.persist();
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.model = next;
    this.persist();
  }

  private pushToast(kind: ToastMessage['kind'], title: string, subtitle: string): void {
    const toast = { id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, title, subtitle };
    this.toasts = [toast, ...this.toasts].slice(0, 3);
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((item) => item.id !== toast.id);
    }, 4_500);
  }

  private get selected(): CaptionSegment | undefined {
    return this.model.segments.find((item) => item.id === this.model.selectedId);
  }

  private get stats() {
    return queueStats(this.model);
  }

  private get pendingSegments(): CaptionSegment[] {
    const items = this.model.segments.filter((item) => {
      if (this.filter === 'active') return item.state === 'pending' || item.state === 'stale' || item.state === 'duplicate';
      if (this.filter === 'attention') return item.state === 'stale' || item.state === 'duplicate';
      return true;
    });
    return [...items].sort((a, b) => a.sequence - b.sequence);
  }

  private updateSelected(patch: Partial<CaptionSegment>, label = ''): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit(label, (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, ...patch, revision: item.revision + 1 } : item),
    }));
  }

  private selectSegment(id: string): void {
    this.model = { ...this.model, selectedId: id };
    this.persist();
  }

  private navigate(direction: number): void {
    const candidates = this.pendingSegments.length ? this.pendingSegments : [...this.model.segments].sort((a, b) => a.sequence - b.sequence);
    const index = candidates.findIndex((item) => item.id === this.model.selectedId);
    const next = candidates[Math.max(0, Math.min(candidates.length - 1, index + direction))];
    if (next) this.selectSegment(next.id);
  }

  private applyTerm(ruleId: string): void {
    const selected = this.selected;
    const rule = this.findRule(ruleId);
    if (!selected || !rule) return;
    const flags = rule.caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(rule.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    if (!expression.test(selected.corrected)) {
      this.pushToast('warning', '当前字幕没有该术语', `${rule.source} → ${rule.replacement}`);
      return;
    }
    this.commit('应用术语替换', (current) => ({
      ...current,
      // usageCount 只统计本机叠加层规则；术语包规则是只读事实，计数不被对账/应用改动。
      rules: current.rules.map((item) => item.id === rule.id ? { ...item, usageCount: item.usageCount + 1 } : item),
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, corrected: item.corrected.replace(expression, rule.replacement), revision: item.revision + 1 } : item),
    }));
  }

  /** 在「当前版本生效规则 = 术语包 + 本机叠加层」中查找规则。 */
  private findRule(id: string) {
    return effectiveRules(this.model, this.model.activeTermVersion).find((item) => item.id === id)
      ?? this.model.rules.find((item) => item.id === id);
  }

  private applyInlineEdit(transform: (value: string) => string, label: string, cursorShift = 0): void {
    const selected = this.selected;
    if (!selected) return;
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    let value = selected.corrected;
    let cursor = value.length;

    if (textarea) {
      value = `${value.slice(0, textarea.selectionStart)}${transform('')}${value.slice(textarea.selectionEnd)}`;
      cursor = textarea.selectionStart + transform('').length + cursorShift;
    } else {
      value = transform(value);
    }

    this.updateSelected({ corrected: value }, label);
    this.updateComplete.then(() => {
      const nextTextarea = this.renderRoot.querySelector('cds-textarea')?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
      if (nextTextarea && textarea) {
        nextTextarea.focus();
        nextTextarea.setSelectionRange(cursor, cursor);
      }
    });
  }

  private insertPunctuation(mark: string): void {
    this.applyInlineEdit(() => mark, `插入${mark}`);
  }

  private wrapSelection(open: string, close: string): void {
    const host = this.renderRoot.querySelector('cds-textarea');
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | undefined;
    const selected = this.selected;
    if (!textarea || !selected) return;
    const selectedText = selected.corrected.slice(textarea.selectionStart, textarea.selectionEnd) || '重点';
    const value = `${selected.corrected.slice(0, textarea.selectionStart)}${open}${selectedText}${close}${selected.corrected.slice(textarea.selectionEnd)}`;
    this.updateSelected({ corrected: value }, '添加强调标点');
  }

  private normalizeCurrentNumbers(): void {
    const selected = this.selected;
    if (!selected) return;
    const normalized = normalizeNumbers(selected.corrected);
    if (normalized === selected.corrected) {
      this.pushToast('info', '没有需要规范化的数字', '已检查全角数字和中文数字');
      return;
    }
    this.updateSelected({ corrected: normalized, numberHints: normalized }, '规范化数字');
  }

  private confirmSelected(): void {
    const selected = this.selected;
    if (!selected) {
      this.pushToast('warning', '没有可确认的片段', '请先从待确认区选择字幕');
      return;
    }
    const offline = this.model.connection === 'offline';
    const version = this.model.activeTermVersion;
    // 确认瞬间：草稿 = 人工编辑框内容；播出文本 = 对草稿应用当前版本规则；并锁定版本快照。
    const draft = selected.corrected;
    const used = renderWithRules(draft, effectiveRules(this.model, version), selected.speaker).used;
    const nextOrder = this.pendingSegments.filter((item) => item.id !== selected.id);
    this.commit('确认并送入直播区', (current) => {
      const currentVersion = current.activeTermVersion;
      const currentRendered = renderWithRules(draft, effectiveRules(current, currentVersion), selected.speaker);
      const currentSnapshot = buildTermSnapshot(selected.original, draft, currentRendered.text, current, selected.speaker);
      return {
        ...current,
        segments: current.segments.map((item) => item.id === selected.id ? {
          ...item,
          corrected: currentRendered.text,
          state: 'confirmed',
          source: offline ? 'offline' : item.source,
          confirmedAt: Date.now(),
          staleReason: item.state === 'stale' ? item.staleReason : undefined,
          tags: used.length ? [...new Set([...item.tags, `术语已应用@${currentVersion}`])] : item.tags,
          term: currentSnapshot,
          reconciled: undefined,
          revision: item.revision + 1,
        } : item),
        rules: current.rules.map((rule) => used.includes(rule.id) ? { ...rule, usageCount: rule.usageCount + 1 } : rule),
        selectedId: nextOrder[0]?.id ?? selected.id,
      };
    });
    this.pushToast(offline ? 'warning' : 'success', offline ? '已加入离线发件箱' : '字幕已进入直播区', offline ? '恢复连接后将按时间顺序合并' : `第 ${selected.sequence} 段已确认并锁定术语 ${version}`);
  }

  private ignoreSelected(): void {
    const selected = this.selected;
    if (!selected) return;
    const next = this.pendingSegments.find((item) => item.id !== selected.id);
    this.commit('忽略问题片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'ignored', staleReason: '已人工忽略' } : item),
      selectedId: next?.id ?? selected.id,
    }));
  }

  private recoverDuplicate(): void {
    const selected = this.selected;
    if (!selected) return;
    this.commit('保留重复片段', (current) => ({
      ...current,
      segments: current.segments.map((item) => item.id === selected.id ? { ...item, state: 'pending', duplicateOf: undefined, staleReason: '重复提示已由校对员确认保留' } : item),
    }));
  }

  private setConnection(connection: ConnectionState): void {
    this.commit(connection === 'offline' ? '切换到离线校正' : connection === 'degraded' ? '模拟延迟波动' : '连接已恢复', (current) => ({
      ...current,
      connection,
      simulatedDelay: connection === 'connected' ? 0.8 : connection === 'degraded' ? 4.6 : current.simulatedDelay,
    }));
  }

  private mergeOffline(): void {
    const merged = mergeConfirmedSegments(this.model);
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = merged;
    this.persist();
    const outboxCount = this.model.segments.filter((item) => item.source === 'offline' && item.state === 'confirmed').length;
    this.pushToast('success', '离线队列已合并', `${outboxCount} 个片段仍标记为离线来源，过期修改会继续显示提示`);
  }

  private addRuleFromSelection(): void {
    const selected = this.selected;
    if (!selected) return;
    this.ruleSource = selected.corrected.length > 24 ? selected.corrected.slice(0, 24) : selected.corrected;
    this.ruleReplacement = selected.corrected;
    this.ruleSpeaker = selected.speaker;
    this.showRuleForm = true;
  }

  private addRule(): void {
    const source = this.ruleSource.trim();
    const replacement = this.ruleReplacement.trim();
    if (!source || !replacement) {
      this.pushToast('warning', '规则不完整', '原文和替换文本均不能为空');
      return;
    }
    this.commit('新增术语快捷规则', (current) => ({
      ...current,
      rules: [{
        id: `local-${Date.now().toString(36)}`,
        source,
        replacement,
        speaker: this.ruleSpeaker,
        enabled: true,
        caseSensitive: false,
        usageCount: 0,
        createdAt: Date.now(),
        local: true,
      }, ...current.rules],
    }));
    this.ruleSource = '';
    this.ruleReplacement = '';
    this.ruleSpeaker = '';
    this.showRuleForm = false;
  }

  private deleteRule(id: string): void {
    const rule = this.model.rules.find((item) => item.id === id);
    if (!rule?.local) {
      this.pushToast('warning', '术语包规则不可删除', '术语包只提供规则事实；本机快捷规则才能删除');
      return;
    }
    this.commit('删除本机术语规则', (current) => ({ ...current, rules: current.rules.filter((item) => item.id !== id) }));
  }

  // -------------------------------------------------------------------------
  // 术语包导入（整包原子：失败留检查点，重试不重复应用）
  // -------------------------------------------------------------------------

  private get packages(): TermPackage[] {
    return this.model.termPackages;
  }

  private get activePackage(): TermPackage | undefined {
    return this.packages.find((item) => item.version === this.model.activeTermVersion) ?? latestPackage(this.packages);
  }

  private openImportSample(pkg: TermPackage): void {
    this.showImportPanel = true;
    this.importText = JSON.stringify(pkg, null, 2);
  }

  private handleImportFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      this.importText = String(reader.result ?? '');
      this.showImportPanel = true;
    };
    reader.readAsText(file);
  }

  private onImportDrop(event: DragEvent): void {
    event.preventDefault();
    this.importDragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) this.handleImportFile(file);
  }

  private doImport(): void {
    if (!this.importText.trim()) {
      this.pushToast('warning', '导入内容为空', '粘贴术语包 JSON，或拖入 .json 文件');
      return;
    }
    const { model: next, result } = importTermPackage(this.model, this.importText);
    this.applyImportResult(next, result);
  }

  private doRetryCheckpoint(id: string): void {
    const { model: next, result } = retryCheckpoint(this.model, id);
    this.applyImportResult(next, result);
  }

  private applyImportResult(next: DeskModel, result: ImportResult): void {
    this.past = [...this.past, cloneModel(this.model)].slice(-HISTORY_LIMIT);
    this.future = [];
    this.model = next;
    this.persist();
    if (result.ok) {
      this.reconcileVersion = result.version ?? this.model.activeTermVersion;
      this.pushToast('success', `术语包 ${result.version} 已整包生效`, result.message);
    } else if (result.checkpoint) {
      this.pushToast('error', `术语包 ${result.checkpoint.version} 导入失败`, `已保留检查点 · ${result.conflicts.length} 项冲突，规则未应用`);
    } else {
      this.pushToast('info', '术语包未应用', result.message);
    }
  }

  private doDiscardCheckpoint(id: string): void {
    this.commit('丢弃导入检查点', (current) => discardCheckpoint(current, id));
  }

  private editCheckpointRaw(id: string): void {
    const checkpoint = this.model.importCheckpoints.find((item) => item.id === id);
    if (!checkpoint) return;
    this.showImportPanel = true;
    this.importText = checkpoint.raw;
    // 把编辑中的文本写回检查点，再点“整包导入”即等价于修复后重试。
    this.commit('载入检查点到编辑器', (current) => ({
      ...current,
      importCheckpoints: current.importCheckpoints.map((item) => item.id === id ? { ...item, raw: this.importText } : item),
    }));
    this.pushToast('info', '可在下方修复后重试', '修复 JSON 后点击“整包导入”，成功将复用同一检查点且不会重复应用');
  }

  // -------------------------------------------------------------------------
  // 版本对账
  // -------------------------------------------------------------------------

  private get targetReconcileVersion(): string {
    const candidates = this.packages.map((item) => item.version);
    const current = this.model.activeTermVersion;
    const stored = this.reconcileVersion;
    if (stored && candidates.includes(stored)) return stored;
    const newer = candidates.filter((version) => version !== current).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    return newer ?? current;
  }

  private get reconcileItems(): ReconcileItem[] {
    return reconciliationReport(this.model, this.targetReconcileVersion);
  }

  private get reconcileSummary() {
    const items = this.reconcileItems;
    return {
      clean: items.filter((item) => item.status === 'clean').length,
      manual: items.filter((item) => item.status === 'manual-preserved').length,
      conflict: items.filter((item) => item.status === 'conflict').length,
      pinned: items.filter((item) => item.status === 'up-to-date').length,
    };
  }

  private beginResolve(item: ReconcileItem): void {
    this.reconcilingId = item.segment.id;
    this.reconcileDraft = item.proposed ?? item.segment.corrected;
  }

  private cancelResolve(): void {
    this.reconcilingId = '';
    this.reconcileDraft = '';
  }

  private acceptItem(item: ReconcileItem, override?: string): void {
    const text = override ?? item.proposed ?? item.segment.corrected;
    const status: ReconcileStatus = item.status === 'clean' ? 'clean' : 'manual-preserved';
    this.commit('接受版本对账结果（已播文本不变）', (current) =>
      acceptReconciliation(current, item.segment.id, this.targetReconcileVersion, text, status, item.message));
    this.cancelResolve();
  }

  private acceptAllSafe(): void {
    const actionable = this.reconcileItems.filter((item) => item.status === 'clean' || item.status === 'manual-preserved');
    if (!actionable.length) {
      this.pushToast('info', '没有可批量接受的段落', '冲突段落需要逐条人工裁决');
      return;
    }
    this.commit(`批量接受 ${actionable.length} 段对账结果`, (current) => {
      let next = current;
      for (const item of actionable) {
        next = acceptReconciliation(next, item.segment.id, this.targetReconcileVersion, item.proposed ?? item.segment.corrected, item.status, item.message);
      }
      return next;
    });
  }

  private exportSrt(mode: string): void {
    const { content, count, conflicts } = toSrt(this.model, mode);
    if (!content) {
      this.pushToast('warning', '暂无已确认字幕', '先确认至少一个片段再导出');
      return;
    }
    const blob = new Blob([content], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const suffix = mode === 'aired' ? '播出确认版' : `术语${mode}`;
    anchor.download = `${this.model.eventName.replace(/[^\p{L}\p{N}-]+/gu, '-')}-${suffix}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
    if (mode === 'aired') {
      this.pushToast('success', '已按各段确认版本导出 SRT', `${count} 段；已播字幕未被新版本规则改写`);
    } else {
      this.pushToast(
        conflicts.length ? 'warning' : 'success',
        `已按术语 ${mode} 导出 SRT`,
        conflicts.length ? `${count} 段，其中 ${conflicts.length} 段存在人工冲突，已回退保留人工播出文本` : `${count} 段`,
      );
    }
  }

  private adjustFont(delta: number): void {
    const fontSize = Math.max(14, Math.min(28, this.model.fontSize + delta));
    this.automatic({ ...this.model, fontSize });
  }

  private toggleTheme(): void {
    this.dark = !this.dark;
    localStorage.setItem(`${STORAGE_KEY}-theme`, this.dark ? 'dark' : 'light');
  }

  private handleShortcut = (event: KeyboardEvent): void => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key === 'Enter') {
      event.preventDefault();
      this.confirmSelected();
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'j') {
      event.preventDefault();
      this.navigate(1);
      return;
    }
    if (event.altKey && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      this.navigate(-1);
      return;
    }
    const punctuation: Record<string, string> = { '1': '，', '2': '。', '3': '？', '4': '！' };
    if (modifier && punctuation[event.key]) {
      event.preventDefault();
      this.insertPunctuation(punctuation[event.key]);
    }
  };

  private renderPendingList() {
    const segments = this.pendingSegments;
    if (!segments.length) {
      return html`<div class="empty"><strong>待确认区已清空</strong><p>新的实时片段到达时会自动进入这里。</p></div>`;
    }
    return html`
      <div class="segment-list">
        ${segments.map((item) => html`
          <button class="segment-card ${item.id === this.model.selectedId ? 'selected' : ''} ${item.state}" @click=${() => this.selectSegment(item.id)}>
            <div class="segment-meta">
              <span>${formatClock(item.startTime)} · #${String(item.sequence).padStart(3, '0')}</span>
              <span class="segment-state ${item.state}">${stateLabel(item.state)}</span>
            </div>
            <p class="segment-text">${item.original}</p>
            ${item.corrected !== item.original ? html`<p class="segment-corrected">${item.corrected}</p>` : nothing}
            <div class="segment-foot">
              <span>${item.speaker}</span>
              <span>·</span>
              <span>${formatAge(item.receivedAt)}</span>
              ${item.revision > 0 ? html`<span>· <b>修改 ${item.revision} 次</b></span>` : nothing}
            </div>
            ${item.state === 'stale' && item.staleReason ? html`<div class="issue-note">${item.staleReason}。确认前请核对直播上下文。</div>` : nothing}
            ${item.state === 'duplicate' ? html`<div class="issue-note duplicate-note">${item.staleReason || '检测到重复片段'}，请保留或忽略。</div>` : nothing}
          </button>
        `)}
      </div>
    `;
  }

  private renderEditor() {
    const item = this.selected;
    if (!item) {
      return html`<div class="empty"><strong>选择一条待确认字幕</strong><p>可以使用 Alt+J / Alt+K 在片段之间移动。</p></div>`;
    }
    const applicableRules = effectiveRules(this.model, this.model.activeTermVersion)
      .filter((rule) => rule.enabled && (!rule.speaker || rule.speaker === item.speaker));
    return html`
      <div class="editor-scroll">
        <div class="editor-card">
          <div class="editor-top">
            <div>
              <div class="editor-time">${formatClock(item.startTime)} — ${formatClock(item.startTime + 7)}</div>
              <p class="editor-title">实时片段 #${String(item.sequence).padStart(3, '0')} · 到达于 ${formatAge(item.receivedAt)}</p>
            </div>
            <div class="editor-status">
              <cds-tag type=${item.state === 'stale' ? 'warm-gray' : item.state === 'duplicate' ? 'purple' : 'blue'} size="sm">${stateLabel(item.state)}</cds-tag>
              <cds-tag type="outline" size="sm">修改 ${item.revision} 次</cds-tag>
              ${item.term
                ? html`<cds-tag type="green" size="sm">术语 v${item.term.version} 已锁定${item.term.manual ? ' · 含人工修改' : ''}</cds-tag>`
                : html`<cds-tag type="cyan" size="sm">确认将锁定 v${this.model.activeTermVersion}</cds-tag>`}
            </div>
          </div>
          <div class="editor-form">
            ${item.state === 'duplicate' ? html`
              <cds-inline-notification kind="warning" low-contrast title="重复片段提示" subtitle=${item.staleReason || '与已确认片段高度相似'}>
                <cds-button slot="action" size="sm" @click=${this.recoverDuplicate}>保留并继续校对</cds-button>
              </cds-inline-notification>
            ` : nothing}
            ${item.state === 'stale' ? html`
              <cds-inline-notification kind="warning" low-contrast title="过期修改" subtitle=${`${item.staleReason || '该片段已超过 90 秒未确认'}。请结合上下文确认，或忽略以避免污染直播区。`}></cds-inline-notification>
            ` : nothing}
            <div class="form-grid">
              <cds-select label-text="发言人" value=${item.speaker} @cds-select-selected=${(event: CustomEvent<{ value: string }>) => this.updateSelected({ speaker: event.detail.value }, '修改发言人')}>
                ${['主持人', '主讲人', '嘉宾 / 周然', '现场提问', '未知发言人'].map((speaker) => html`<cds-select-item value=${speaker}>${speaker}</cds-select-item>`)}
              </cds-select>
              <cds-number-input class="number-input" label="延迟（秒）" .value=${this.model.simulatedDelay} step="0.1" min="0" max="9" @input=${(event: Event) => this.automatic({ ...this.model, simulatedDelay: Number((event.currentTarget as any).value) })}></cds-number-input>
            </div>
            <cds-textarea
              class="caption-input"
              label-text="校对后的字幕文本"
              helper-text="Ctrl/⌘ + 1–4 快速插入标点；术语规则将从左到右自动应用"
              .value=${item.corrected}
              @input=${(event: Event) => this.updateSelected({ corrected: (event.currentTarget as any).value }, '')}
            ></cds-textarea>
            <div class="edit-toolbar">
              <span>快速标点</span>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('，')}>，逗号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('。')}>。句号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('？')}>？问号</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.insertPunctuation('…')}>…省略</cds-button>
              <cds-button kind="ghost" size="sm" @click=${() => this.wrapSelection('（', '）')}>（）括注</cds-button>
              <cds-button kind="secondary" size="sm" @click=${this.normalizeCurrentNumbers}>规范化数字</cds-button>
            </div>
            <div class="rule-suggestions">
              <small>术语快捷替换</small>
              ${applicableRules.length ? applicableRules.map((rule) => html`
                <cds-button kind="tertiary" size="sm" @click=${() => this.applyTerm(rule.id)}>${rule.source} → ${rule.replacement}</cds-button>
              `) : html`<small>当前发言人的规则为空</small>`}
              <cds-button kind="ghost" size="sm" @click=${this.addRuleFromSelection}>＋ 从当前文本新建</cds-button>
            </div>
          </div>
          <div class="confirm-bar">
            <div class="confirm-hint"><kbd>⌘/Ctrl Enter</kbd> 确认并进入直播区 · <kbd>Alt J/K</kbd> 切换片段</div>
            <div>
              <cds-button kind="danger--tertiary" size="sm" @click=${this.ignoreSelected}>忽略片段</cds-button>
              <cds-button kind="primary" @click=${this.confirmSelected}>确认并送入直播区</cds-button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ----- 对账状态文案 -----
  private reconcileStatusLabel(status: ReconcileStatus): string {
    return {
      'up-to-date': '已最新',
      clean: '干净升级',
      'manual-preserved': '人工保留',
      conflict: '冲突待裁决',
      'pending-segment': '未确认',
    }[status];
  }

  private renderTokens(item: ReconcileItem) {
    if (!item.tokens) return html`${item.proposed ?? ''}`;
    return item.tokens.map((token) => {
      if (token.status === 'unchanged') return html`${token.text}`;
      if (token.status === 'conflict') {
        return html`<span class="tok-conflict" title=${`新版本建议：${token.to ?? ''}（已保留人工播出文本）`}>${token.text}</span>`;
      }
      return html`<span class="tok-changed">${token.text}</span>`;
    });
  }

  private renderTermVersions() {
    const active = this.activePackage;
    const items = [...this.packages].sort((a, b) => b.releasedAt - a.releasedAt);
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>术语版本</h3>
          <span>当前生效 v${this.model.activeTermVersion}</span>
        </div>
        ${active ? html`
          <div class="version-banner">
            <strong>v${active.version}</strong> · ${active.note || '术语包规则事实'}
            <small>${active.rules.length} 条规则 · 导入于 ${new Date(active.importedAt ?? active.releasedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 直播中途下发的新版本不会改写已播字幕</small>
          </div>` : nothing}
        <div class="pkg-list">
          ${items.map((pkg) => html`
            <div class="pkg-item ${pkg.version === this.model.activeTermVersion ? 'active' : ''}">
              <span class="pkg-ver">v${pkg.version}</span>
              <p>${pkg.note || '术语包'}<br/>${pkg.rules.length} 条规则事实</p>
              ${pkg.version === this.model.activeTermVersion ? html`<span class="pkg-badge">生效中</span>` : nothing}
            </div>
          `)}
        </div>

        <div
          class="import-drop ${this.importDragging ? 'dragging' : ''}"
          @dragover=${(event: DragEvent) => { event.preventDefault(); this.importDragging = true; }}
          @dragleave=${() => { this.importDragging = false; }}
          @drop=${(event: DragEvent) => this.onImportDrop(event)}
          @click=${() => { this.showImportPanel = !this.showImportPanel; }}
        >
          <strong>导入带版本号的术语包</strong>
          拖入 .json 或点击粘贴 · 整包原子校验，失败会留下检查点
        </div>
        <div class="import-actions">
          <cds-button kind="ghost" size="sm" @click=${() => this.openImportSample(SAMPLE_PACKAGE_V2)}>示例：干净升级 v2.0.0</cds-button>
          <cds-button kind="ghost" size="sm" @click=${() => this.openImportSample(SAMPLE_PACKAGE_V3_CONFLICT)}>示例：冲突包 v3.0.0</cds-button>
        </div>
        ${this.showImportPanel ? html`
          <div class="import-textarea">
            <textarea
              .value=${this.importText}
              placeholder='{"version":"2.0.0","rules":[...]}'
              @input=${(event: Event) => { this.importText = (event.target as HTMLTextAreaElement).value; }}
            ></textarea>
          </div>
          <div class="import-actions">
            <cds-button kind="primary" size="sm" @click=${this.doImport}>整包导入</cds-button>
            <cds-button kind="ghost" size="sm" @click=${() => { this.showImportPanel = false; this.importText = ''; }}>取消</cds-button>
          </div>
        ` : nothing}
        ${this.renderCheckpoints()}
      </section>
    `;
  }

  private renderCheckpoints() {
    const checkpoints = this.model.importCheckpoints;
    if (!checkpoints.length) return nothing;
    return html`
      <div style="padding: 4px 10px 8px;">
        <strong style="font-size:11px;">导入检查点（${checkpoints.length}）</strong>
        ${checkpoints.map((checkpoint) => html`
          <div class="checkpoint-item ${checkpoint.resolved ? 'resolved' : ''}">
            <strong>v${checkpoint.version} ${checkpoint.resolved ? '· 已修复并成功导入' : `· 整包失败（${checkpoint.attempts} 次尝试）`}</strong>
            <div>${checkpoint.reason}</div>
            <ul>
              ${checkpoint.conflicts.slice(0, 5).map((conflict) => html`<li>${conflict.message}</li>`)}
            </ul>
            <div class="checkpoint-actions">
              ${checkpoint.resolved
                ? html`<small style="font-size:9px;color:#198038;">重试不会重复应用，版本仅生效一次</small>`
                : html`
                  <cds-button kind="primary" size="sm" @click=${() => this.doRetryCheckpoint(checkpoint.id)}>原样重试</cds-button>
                  <cds-button kind="tertiary" size="sm" @click=${() => this.editCheckpointRaw(checkpoint.id)}>修复后重试</cds-button>
                  <cds-button kind="danger--ghost" size="sm" @click=${() => this.doDiscardCheckpoint(checkpoint.id)}>丢弃</cds-button>
                `}
            </div>
          </div>
        `)}
      </div>
    `;
  }

  private renderReconciliation() {
    const versionOptions = this.packages.map((pkg) => pkg.version);
    const target = this.targetReconcileVersion;
    const items = this.reconcileItems;
    const summary = this.reconcileSummary;
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>术语版本对账</h3>
          <span>${items.length} 段已确认</span>
        </div>
        <div class="playback-bar">
          <small>对账目标版本</small>
          <cds-dropdown size="sm" value=${target} @cds-dropdown-selected=${(event: CustomEvent<{ item: { value: string } }>) => { this.reconcileVersion = event.detail.item.value; this.cancelResolve(); }} style="width: 130px;">
            ${versionOptions.map((version) => html`<cds-dropdown-item value=${version}>v${version}</cds-dropdown-item>`)}
          </cds-dropdown>
          <cds-button kind="tertiary" size="sm" ?disabled=${summary.conflict > 0} @click=${this.acceptAllSafe}>接受全部无冲突项</cds-button>
        </div>
        <div class="reconcile-summary">
          <div class="n-clean"><b>${summary.clean}</b><span>干净升级</span></div>
          <div class="n-manual"><b>${summary.manual}</b><span>人工保留</span></div>
          <div class="n-conflict"><b>${summary.conflict}</b><span>冲突</span></div>
          <div><b>${summary.pinned}</b><span>已最新</span></div>
        </div>
        <div class="reconcile-list">
          ${items.map((item) => this.renderReconcileItem(item))}
        </div>
        <div class="playback-note">对账只生成建议与接受记录；每段的已播文本（corrected）永不改写，直播/导出仍按各段确认版本取字幕。</div>
      </section>
    `;
  }

  private renderReconcileItem(item: ReconcileItem) {
    const segment = item.segment;
    const locked = segment.term?.version ?? '—';
    const editing = this.reconcilingId === segment.id;
    return html`
      <div class="reconcile-item ${item.status}">
        <div class="reconcile-head">
          <b>#${String(segment.sequence).padStart(3, '0')} · v${locked} → v${item.targetVersion}</b>
          <span class="status-pill ${item.status}">${this.reconcileStatusLabel(item.status)}</span>
        </div>
        ${item.status === 'up-to-date'
          ? html`<p class="reconcile-msg">${item.message}</p>`
          : html`
            <p class="reconcile-text">${this.renderTokens(item)}</p>
            <p class="reconcile-aired">已播冻结：<s>${segment.corrected}</s></p>
            <p class="reconcile-msg">${item.message}</p>
            ${editing ? html`
              <div class="reconcile-editor">
                <textarea .value=${this.reconcileDraft} @input=${(event: Event) => { this.reconcileDraft = (event.target as HTMLTextAreaElement).value; }}></textarea>
              </div>
              <div class="reconcile-actions">
                <cds-button kind="primary" size="sm" @click=${() => this.acceptItem(item, this.reconcileDraft)}>保存裁决（不改已播文本）</cds-button>
                <cds-button kind="ghost" size="sm" @click=${this.cancelResolve}>取消</cds-button>
              </div>
            ` : html`
              <div class="reconcile-actions">
                ${item.status === 'conflict'
                  ? html`<cds-button kind="primary" size="sm" @click=${() => this.beginResolve(item)}>人工裁决</cds-button>`
                  : html`<cds-button kind="primary" size="sm" @click=${() => this.acceptItem(item)}>接受建议</cds-button>`}
                ${item.status !== 'clean' ? html`<cds-button kind="ghost" size="sm" @click=${() => this.beginResolve(item)}>编辑后接受</cds-button>` : nothing}
              </div>
            `}
          `}
      </div>
    `;
  }

  private renderPlayback() {
    const confirmed = this.model.segments
      .filter((segment) => segment.state === 'confirmed')
      .sort((a, b) => a.startTime - b.startTime);
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>直播区与回放</h3>
          <span>${confirmed.length} 段</span>
        </div>
        <div class="playback-bar">
          <small>取字幕依据</small>
          <cds-dropdown size="sm" value=${this.playbackMode} @cds-dropdown-selected=${(event: CustomEvent<{ item: { value: string } }>) => { this.playbackMode = event.detail.item.value; }} style="width: 150px;">
            <cds-dropdown-item value="aired">各段确认版本（播出）</cds-dropdown-item>
            ${this.packages.map((pkg) => html`<cds-dropdown-item value=${pkg.version}>按 v${pkg.version} 回放</cds-dropdown-item>`)}
          </cds-dropdown>
        </div>
        <div class="playback-list">
          ${confirmed.length ? confirmed.map((segment) => {
            const view = this.playbackMode === 'aired'
              ? { text: segment.reconciled?.text ?? segment.corrected, version: segment.reconciled?.version ?? segment.term?.version ?? this.model.activeTermVersion, conflict: false, reconciled: Boolean(segment.reconciled) }
              : this.targetView(segment);
            return html`
              <article class="playback-item ${view.conflict ? 'conflict' : ''}">
                <time>${formatClock(segment.startTime)} · ${segment.speaker}<span class="ver">v${view.version}${view.reconciled ? '（已对账）' : ''}</span></time>
                ${view.text}
                ${view.conflict ? html`<div class="reconcile-msg" style="color:#a2191f;">规则与人工修改冲突，已保留人工播出文本</div>` : nothing}
              </article>
            `;
          }) : html`<div class="empty"><strong>直播区等待内容</strong><p>确认一块字幕后，它会从这里进入实时输出。</p></div>`}
        </div>
        <div class="import-actions">
          <cds-button kind="tertiary" size="sm" @click=${() => this.exportSrt('aired')}>导出播出确认版</cds-button>
          ${this.playbackMode !== 'aired' ? html`<cds-button kind="tertiary" size="sm" @click=${() => this.exportSrt(this.playbackMode)}>导出 v${this.playbackMode} 回放版</cds-button>` : nothing}
        </div>
        ${this.stats.offline > 0 ? html`<div class="delivery-status">离线发件箱有 ${this.stats.offline} 段待合并。恢复连接后按时间顺序提交，不会覆盖已确认内容。</div>` : nothing}
      </section>
    `;
  }

  private targetView(segment: CaptionSegment) {
    const mode = this.playbackMode;
    if (segment.reconciled?.version === mode) {
      return { text: segment.reconciled.text, version: mode, conflict: false, reconciled: true };
    }
    const item = reconciliationReport(this.model, mode).find((report) => report.segment.id === segment.id);
    return {
      text: item?.proposed ?? segment.corrected,
      version: mode,
      conflict: item?.status === 'conflict',
      reconciled: false,
    };
  }

  private renderLocalRules() {
    const packageRules = this.activePackage?.rules ?? [];
    const localRules = this.model.rules;
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>术语规则</h3>
          <span>${packageRules.length} 条术语包 · ${localRules.filter((rule) => rule.enabled).length} 条本机</span>
        </div>
        <div class="rule-list">
          ${packageRules.map((rule) => html`
            <div class="rule-item">
              <div>
                <strong>${rule.source} → ${rule.replacement}</strong>
                <p>${rule.speaker || '全部发言人'} · <b style="color:#0f62fe;">术语包 v${this.activePackage?.version} 只读</b></p>
              </div>
              <div class="rule-item-actions">
                <cds-button kind="ghost" size="sm" @click=${() => this.applyTerm(rule.id)}>应用</cds-button>
              </div>
            </div>
          `)}
          ${localRules.map((rule) => html`
            <div class="rule-item">
              <div>
                <strong>${rule.source} → ${rule.replacement}</strong>
                <p>${rule.speaker || '全部发言人'} · 本机叠加 · 已使用 ${rule.usageCount} 次</p>
              </div>
              <div class="rule-item-actions">
                <cds-button kind="ghost" size="sm" @click=${() => this.applyTerm(rule.id)}>应用</cds-button>
                <cds-button kind="danger--ghost" size="xs" @click=${() => this.deleteRule(rule.id)}>删除</cds-button>
              </div>
            </div>
          `)}
        </div>
        ${this.showRuleForm ? html`
          <div class="rule-form">
            <cds-text-input label-text="原文" .value=${this.ruleSource} @input=${(event: Event) => { this.ruleSource = (event.currentTarget as any).value; }}></cds-text-input>
            <cds-text-input label-text="替换为" .value=${this.ruleReplacement} @input=${(event: Event) => { this.ruleReplacement = (event.currentTarget as any).value; }}></cds-text-input>
            <cds-text-input class="full" label-text="仅对某发言人应用（可空）" .value=${this.ruleSpeaker} @input=${(event: Event) => { this.ruleSpeaker = (event.currentTarget as any).value; }}></cds-text-input>
            <cds-button class="full" size="sm" kind="primary" @click=${this.addRule}>保存本机规则</cds-button>
          </div>
        ` : html`
          <div style="padding: 10px;"><cds-button kind="tertiary" size="sm" @click=${() => { this.showRuleForm = true; }}>＋ 新增本机快捷规则</cds-button></div>
        `}
      </section>
    `;
  }

  private renderContext() {
    const item = this.selected;
    return html`
      <section class="inspector-section">
        <div class="inspector-section-head">
          <h3>当前片段上下文</h3>
          <span>${item ? `#${item.sequence}` : '未选择'}</span>
        </div>
        <div style="padding: 12px; line-height: 1.5; font-size: 11px;">
          ${item ? html`
            <div><strong>原始字幕：</strong>${item.original}</div>
            <div style="margin-top: 8px;"><strong>确认版本：</strong>${item.term ? html`v${item.term.version}${item.term.manual ? ' · 含人工修改' : ' · 纯规则'}` : '未确认（确认时锁定当前版本）'}</div>
            <div style="margin-top: 8px;"><strong>播出文本：</strong>${item.corrected}</div>
            ${item.reconciled ? html`
              <div style="margin-top: 8px; color: #0043ce;"><strong>对账记录：</strong>v${item.reconciled.fromVersion} → v${item.reconciled.version}${item.reconciled.note ? ` · ${item.reconciled.note}` : ''}</div>
            ` : nothing}
          ` : html`<span>请选择片段以查看上下文。</span>`}
        </div>
      </section>
    `;
  }

  private renderInspector() {
    return html`
      <div class="inspector">
        ${this.renderTermVersions()}
        ${this.renderReconciliation()}
        ${this.renderPlayback()}
        ${this.renderLocalRules()}
        ${this.renderContext()}
      </div>
    `;
  }

  render() {
    const stats = this.stats;
    const backlogRatio = Math.min(100, stats.backlog * 8);
    return html`
      <div class="shell ${this.dark ? 'dark' : ''}" style=${`--caption-font-size: ${this.model.fontSize}px`}>
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">CC</div>
            <div class="brand-copy">
              <strong>LiveCaption Desk</strong>
              <span>${this.model.eventName} · ${this.model.eventDate}</span>
            </div>
          </div>
          <div class="connection-pill ${this.model.connection}">
            <span class="connection-dot"></span>
            <div class="connection-copy">
              <strong>${connectionLabel(this.model.connection)} · ${this.model.simulatedDelay.toFixed(1)} 秒延迟</strong>
              <small>${this.model.connection === 'offline' ? '仍可编辑，确认内容进入离线发件箱' : `待确认队列 ${stats.pending} 段 · 最近自动保存 ${new Date(this.model.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</small>
            </div>
          </div>
          <div class="header-actions">
            <cds-button kind="ghost" size="sm" @click=${this.toggleTheme}>${this.dark ? '浅色界面' : '深色值守'}</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.undo}>撤销</cds-button>
            <cds-button kind="ghost" size="sm" @click=${this.redo}>重做</cds-button>
            <cds-button kind="primary" size="sm" @click=${() => this.exportSrt('aired')}>导出播出版 SRT</cds-button>
          </div>
        </header>

        <section class="status-strip">
          <div class="status-cell hero">
            <strong>${this.model.connection === 'offline' ? '离线校正中，确认后暂存发件箱' : stats.backlog > 8 ? '队列积压，建议优先处理过期片段' : '队列节奏正常，可以继续逐段确认'}</strong>
            <span>待确认 ${stats.pending} · 过期 ${stats.stale} · 重复 ${stats.duplicate} · 离线待合并 ${stats.offline}</span>
            <div class="queue-track"><span style=${`width:${backlogRatio}%`}></span></div>
          </div>
          <div class="status-cell"><strong>${stats.pending}</strong><span>待确认片段</span></div>
          <div class="status-cell warning"><strong>${stats.oldestWaitSeconds}s</strong><span>最长等待时间</span></div>
          <div class="status-cell danger"><strong>${stats.stale + stats.duplicate}</strong><span>需要明确处理</span></div>
          <div class="status-cell"><strong>${this.model.simulatedDelay.toFixed(1)}s</strong><span>当前流延迟</span></div>
          <div class="font-controls">
            <label>字幕字号</label>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(-1)}>A−</cds-button>
            <strong>${this.model.fontSize}</strong>
            <cds-button kind="ghost" size="sm" @click=${() => this.adjustFont(1)}>A＋</cds-button>
          </div>
        </section>

        <main class="workspace">
          <section class="column">
            <div class="column-head">
              <div>
                <h2>待确认区</h2>
                <p>按收到顺序排列，重复和过期内容不会被静默覆盖</p>
              </div>
              <cds-dropdown value=${this.filter} @cds-dropdown-selected=${(event: CustomEvent<{ item: { value: string } }>) => { this.filter = event.detail.item.value as typeof this.filter; }}>
                <cds-dropdown-item value="active">仅需处理</cds-dropdown-item>
                <cds-dropdown-item value="attention">异常优先</cds-dropdown-item>
                <cds-dropdown-item value="all">全部片段</cds-dropdown-item>
              </cds-dropdown>
            </div>
            <div class="column-body">${this.renderPendingList()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>校对编辑台</h2>
                <p>标点、专有名词、发言人和数字均可在确认前修改</p>
              </div>
              <cds-tag type="green" size="sm">本地草稿</cds-tag>
            </div>
            <div class="column-body" style=${`font-size:${this.model.fontSize}px`}>${this.renderEditor()}</div>
          </section>

          <section class="column">
            <div class="column-head">
              <div>
                <h2>版本对账与直播区</h2>
                <p>术语包只提供规则事实；每段确认时锁定版本，已播内容不被改写</p>
              </div>
              ${this.model.connection === 'offline'
                ? html`<cds-button kind="primary" size="sm" @click=${this.mergeOffline}>恢复并合并</cds-button>`
                : html`<cds-button kind="danger--tertiary" size="sm" @click=${() => this.setConnection('offline')}>模拟断线</cds-button>`}
            </div>
            <div class="column-body">${this.renderInspector()}</div>
          </section>
        </main>

        <div class="toast-stack">
          ${this.toasts.map((toast) => html`
            <cds-toast-notification
              kind=${toast.kind}
              title=${toast.title}
              subtitle=${toast.subtitle}
              @cds-notification-closed=${() => { this.toasts = this.toasts.filter((item) => item.id !== toast.id); }}
            ></cds-toast-notification>
          `)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caption-desk': CaptionDesk;
  }
}
