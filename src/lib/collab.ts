// 协作记录引擎：修订号、字段级三方合并、提交幂等与旧数据回填
// 所有数据保存在 localStorage，提交先进入发件箱，模拟断网/崩溃后重试。

export type Role = 'auditor' | 'reviewer' | 'developer';
export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

/** 同一字段被两边改动时保留两份，挂起待裁决 */
export interface FieldConflict {
  field: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  status: 'pending' | 'ours' | 'theirs';
}

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  /** 当前修订号，每次提交 +1 */
  revision: number;
  conflicts: FieldConflict[];
  updatedAt: string;
}

export type EventKind = 'commit' | 'rejected' | 'backfill';

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
  kind: EventKind;
  /** 本条记录产生的修订号 */
  revision?: number;
  /** 提交所依据的修订号 */
  baseRevision?: number;
  /** 提交人身份 */
  submitter?: string;
  /** 提交编号（幂等键），重复提交只留一条时间线记录 */
  submissionId?: string;
}

export type SubmissionStatus = 'pending' | 'applied' | 'conflict' | 'rejected';

/** 一次未完成的提交，持久化在发件箱里供重试 */
export interface Submission {
  id: string;
  issueId: string;
  action: string;
  baseRevision: number;
  submitter: string;
  role: Role;
  changes: Record<string, unknown>;
  status: SubmissionStatus;
  attempts: number;
  createdAt: string;
  resultRevision?: number;
  error?: string;
  /** 冲突裁决：采用哪一边的值 */
  conflictResolve?: { field: string; choice: 'ours' | 'theirs' };
}

export interface IssueSnapshot {
  revision: number;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
}

export interface WorkbenchStateV2 {
  version: 2;
  issues: AuditIssue[];
  events: AuditEvent[];
  outbox: Submission[];
  appliedSubmissionIds: string[];
  /** 每个修订号对应的字段快照，供三方合并 */
  history: Record<string, IssueSnapshot[]>;
}

export const ROLE_LABEL: Record<Role, string> = {
  auditor: '审计员',
  reviewer: '审核员',
  developer: '开发人员'
};

export const ACTION_LABEL: Record<string, string> = {
  'issue.create': '创建问题',
  'issue.update': '编辑问题内容',
  'issue.triage': '分诊确认',
  'issue.merge': '合并重复',
  'fix.start': '开始修复',
  'fix.submit': '提交复测',
  'retest.pass': '复测通过',
  'retest.fail': '复测失败',
  'conflict.resolve': '裁决冲突'
};

/** 各角色的操作范围，越权提交会被拒绝 */
export const ACTION_ROLES: Record<string, Role[]> = {
  'issue.create': ['auditor'],
  'issue.update': ['auditor'],
  'issue.triage': ['reviewer'],
  'issue.merge': ['reviewer'],
  'fix.start': ['developer'],
  'fix.submit': ['developer'],
  'retest.pass': ['reviewer'],
  'retest.fail': ['reviewer'],
  'conflict.resolve': ['auditor', 'reviewer']
};

export function can(role: Role, action: string): boolean {
  return ACTION_ROLES[action]?.includes(role) ?? false;
}

export function snapshotOf(issue: AuditIssue): IssueSnapshot {
  return {
    revision: issue.revision,
    title: issue.title,
    flow: issue.flow,
    steps: issue.steps,
    impactGroup: issue.impactGroup,
    severity: issue.severity,
    status: issue.status,
    canonicalId: issue.canonicalId,
    fixNote: issue.fixNote,
    retestNote: issue.retestNote
  };
}

function findSnapshot(draft: WorkbenchStateV2, issueId: string, revision: number): IssueSnapshot | undefined {
  return draft.history[issueId]?.find((s) => s.revision === revision);
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function recordEvent(draft: WorkbenchStateV2, ev: Omit<AuditEvent, 'id' | 'at'>): void {
  draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...ev });
}

export type ApplyResult =
  | { status: 'applied'; revision: number }
  | { status: 'conflict'; revision: number; conflicts: FieldConflict[] }
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate'; revision?: number };

function reject(draft: WorkbenchStateV2, sub: Submission, reason: string): ApplyResult {
  recordEvent(draft, {
    issueId: sub.issueId,
    kind: 'rejected',
    submitter: sub.submitter,
    submissionId: sub.id,
    message: `越权提交被拒绝：${ROLE_LABEL[sub.role]} ${sub.submitter} 无权执行「${ACTION_LABEL[sub.action] ?? sub.action}」（${reason === 'forbidden' ? '超出操作范围' : reason}）`
  });
  return { status: 'rejected', reason };
}

/**
 * 把提交应用到草稿状态上。
 * - 已应用过的提交编号直接跳过（幂等，时间线只留一条）
 * - 依据修订号做字段级三方合并：只有一方改动的字段直接采用，
 *   两边都改且不一致的字段保留两份并挂起待裁决
 */
export function applySubmission(draft: WorkbenchStateV2, sub: Submission): ApplyResult {
  if (draft.appliedSubmissionIds.includes(sub.id)) {
    const issue = draft.issues.find((i) => i.id === sub.issueId);
    return { status: 'duplicate', revision: issue?.revision };
  }

  if (sub.action === 'issue.create') {
    if (!can(sub.role, sub.action)) return reject(draft, sub, 'forbidden');
    const issue: AuditIssue = {
      id: sub.issueId,
      title: String(sub.changes.title ?? ''),
      flow: String(sub.changes.flow ?? ''),
      steps: String(sub.changes.steps ?? ''),
      impactGroup: String(sub.changes.impactGroup ?? ''),
      severity: (sub.changes.severity as Severity) ?? 'serious',
      status: 'open',
      fixNote: '',
      retestNote: '',
      revision: 1,
      conflicts: [],
      updatedAt: new Date().toISOString()
    };
    draft.issues.unshift(issue);
    draft.history[issue.id] = [{ ...snapshotOf(issue) }];
    draft.appliedSubmissionIds.push(sub.id);
    recordEvent(draft, {
      issueId: issue.id,
      kind: 'commit',
      revision: 1,
      baseRevision: 0,
      submitter: sub.submitter,
      submissionId: sub.id,
      message: `${ROLE_LABEL[sub.role]} ${sub.submitter} 创建问题（修订 #1）`
    });
    return { status: 'applied', revision: 1 };
  }

  const issue = draft.issues.find((i) => i.id === sub.issueId);
  if (!issue) return reject(draft, sub, 'missing-issue');
  if (!can(sub.role, sub.action)) return reject(draft, sub, 'forbidden');
  if (sub.baseRevision > issue.revision) return reject(draft, sub, 'ahead-of-history');

  const baseSnap = findSnapshot(draft, issue.id, sub.baseRevision) ?? snapshotOf(issue);
  const advanced = sub.baseRevision < issue.revision;
  const freshConflicts: FieldConflict[] = [];

  for (const [field, oursVal] of Object.entries(sub.changes)) {
    const baseVal = (baseSnap as unknown as Record<string, unknown>)[field];
    const theirsVal = (issue as unknown as Record<string, unknown>)[field];
    if (!advanced || eq(theirsVal, baseVal)) {
      // 对方没动过这个字段，采用我方
      (issue as unknown as Record<string, unknown>)[field] = oursVal;
    } else if (!eq(oursVal, theirsVal)) {
      // 两边都改了且不一致：保留两份，挂起待裁决
      freshConflicts.push({ field, base: baseVal, ours: oursVal, theirs: theirsVal, status: 'pending' });
    }
  }

  if (sub.conflictResolve) {
    const pending = issue.conflicts.find((c) => c.field === sub.conflictResolve!.field && c.status === 'pending');
    if (pending) pending.status = sub.conflictResolve.choice;
  }

  issue.conflicts.push(...freshConflicts);
  issue.revision += 1;
  issue.updatedAt = new Date().toISOString();
  (draft.history[issue.id] ??= []).push({ ...snapshotOf(issue) });
  draft.appliedSubmissionIds.push(sub.id);

  const mergeNote = advanced
    ? freshConflicts.length
      ? `基于修订 #${sub.baseRevision} 字段级合并，${freshConflicts.length} 处冲突待裁决`
      : `基于修订 #${sub.baseRevision} 字段级合并，无冲突`
    : '';
  recordEvent(draft, {
    issueId: issue.id,
    kind: 'commit',
    revision: issue.revision,
    baseRevision: sub.baseRevision,
    submitter: sub.submitter,
    submissionId: sub.id,
    message: `${ROLE_LABEL[sub.role]} ${sub.submitter} ${ACTION_LABEL[sub.action] ?? sub.action}（修订 #${issue.revision}${mergeNote ? `，${mergeNote}` : ''}）`
  });

  return { status: freshConflicts.length ? 'conflict' : 'applied', revision: issue.revision, conflicts: freshConflicts };
}

const STORAGE_KEY = 'a11y-audit-v2';
const LEGACY_KEY = 'a11y-audit-v1';
const LOCK_KEY = 'a11y-audit-submit-lock';
const LOCK_TTL = 8000;

/** 跨标签页提交锁：同一时刻只允许一个标签页提交，避免并发覆盖 */
export function acquireLock(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const now = Date.now();
    if (raw && Number.isFinite(Number(raw)) && now - Number(raw) < LOCK_TTL) return false;
    localStorage.setItem(LOCK_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

export function releaseLock(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LOCK_KEY);
  } catch {
    /* 忽略锁清理失败 */
  }
}

/** 以 localStorage 为“服务器”读取最新状态；标签页提交前先重读，再做字段级合并 */
export function readServerState(): WorkbenchStateV2 {
  if (typeof localStorage === 'undefined') return loadState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WorkbenchStateV2;
  } catch {
    /* 数据损坏时走迁移 */
  }
  return loadState();
}

export { STORAGE_KEY };

function seedLegacy(): { issues: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> } {
  return {
    issues: [
      { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
      { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
    ],
    events: [
      { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
      { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
    ]
  };
}

function inferSubmitter(message: string): string {
  if (message.includes('审核员')) return '审核员（历史记录）';
  if (message.includes('开发')) return '开发人员（历史记录）';
  if (message.includes('审计')) return '审计员（历史记录）';
  return '历史记录';
}

/** 升级迁移：旧数据没有修订号，按现有问题和记录回填；原合并关系照旧保留 */
function migrate(): WorkbenchStateV2 {
  let parsed: { issues?: Array<Record<string, unknown>>; events?: Array<Record<string, unknown>> } | null = null;
  try {
    parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  const fallback = seedLegacy();
  const legacy = {
    issues: Array.isArray(parsed?.issues) ? parsed!.issues! : fallback.issues,
    events: Array.isArray(parsed?.events) ? parsed!.events! : fallback.events
  };

  const issues: AuditIssue[] = legacy.issues.map((raw) => ({
    id: String(raw.id ?? crypto.randomUUID()),
    title: String(raw.title ?? ''),
    flow: String(raw.flow ?? ''),
    steps: String(raw.steps ?? ''),
    impactGroup: String(raw.impactGroup ?? ''),
    severity: (raw.severity as Severity) ?? 'serious',
    status: (raw.status as IssueStatus) ?? 'open',
    canonicalId: raw.canonicalId as string | undefined,
    fixNote: String(raw.fixNote ?? ''),
    retestNote: String(raw.retestNote ?? ''),
    revision: 1,
    conflicts: [],
    updatedAt: String(raw.updatedAt ?? new Date().toISOString())
  }));

  const history: Record<string, IssueSnapshot[]> = {};
  for (const issue of issues) history[issue.id] = [{ ...snapshotOf(issue) }];

  const events: AuditEvent[] = legacy.events.map((raw) => ({
    id: String(raw.id ?? crypto.randomUUID()),
    at: String(raw.at ?? new Date().toISOString()),
    issueId: String(raw.issueId),
    message: String(raw.message ?? ''),
    kind: 'backfill' as const,
    revision: 1,
    submitter: inferSubmitter(String(raw.message ?? ''))
  }));

  const state: WorkbenchStateV2 = { version: 2, issues, events, outbox: [], appliedSubmissionIds: [], history };
  saveState(state);
  return state;
}

export function loadState(): WorkbenchStateV2 {
  if (typeof localStorage === 'undefined') {
    // 服务端渲染时返回回填后的种子数据
    const legacy = seedLegacy();
    const issues: AuditIssue[] = legacy.issues.map((raw) => ({
      id: String(raw.id),
      title: String(raw.title),
      flow: String(raw.flow),
      steps: String(raw.steps),
      impactGroup: String(raw.impactGroup),
      severity: raw.severity as Severity,
      status: raw.status as IssueStatus,
      canonicalId: raw.canonicalId as string | undefined,
      fixNote: String(raw.fixNote),
      retestNote: String(raw.retestNote),
      revision: 1,
      conflicts: [],
      updatedAt: String(raw.updatedAt)
    }));
    const history: Record<string, IssueSnapshot[]> = {};
    for (const issue of issues) history[issue.id] = [{ ...snapshotOf(issue) }];
    return {
      version: 2,
      issues,
      events: legacy.events.map((raw) => ({
        id: String(raw.id),
        at: String(raw.at),
        issueId: String(raw.issueId),
        message: String(raw.message),
        kind: 'backfill' as const,
        revision: 1,
        submitter: inferSubmitter(String(raw.message))
      })),
      outbox: [],
      appliedSubmissionIds: [],
      history
    };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WorkbenchStateV2;
  } catch {
    /* 数据损坏时重新迁移 */
  }
  return migrate();
}

export function saveState(state: WorkbenchStateV2): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 存储不可用时忽略 */
  }
}
