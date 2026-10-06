/**
 * 协作记录模型：问题、操作时间线与重复合并关系共用一条全局修订号。
 * 每次提交携带 baseRevision（所依据的修订号）与提交人身份；
 * commit 为纯函数，不依赖浏览器 API，便于单测与跨标签页复用。
 */

export type Role = 'auditor' | 'reviewer' | 'developer';
export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

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
  /** 最后一次改动该问题的修订号 */
  revision: number;
  updatedAt: string;
}

export type EditableField =
  | 'title' | 'flow' | 'steps' | 'impactGroup' | 'severity'
  | 'status' | 'fixNote' | 'retestNote' | 'canonicalId';

export interface FieldChange {
  field: EditableField;
  /** 提交人下笔时看到的值（baseRevision 时的值） */
  base: unknown;
  /** 提交人希望写入的值 */
  value: unknown;
}

export type UpdateKind = 'edit' | 'triage' | 'fix' | 'retest';

export type Operation =
  | { kind: 'create'; issue: AuditIssue }
  | { kind: UpdateKind; issueId: string; changes: FieldChange[]; message: string }
  | { kind: 'merge'; duplicateId: string; canonicalId: string }
  | { kind: 'adjudicate'; conflictId: string; choice: 'current' | 'incoming' };

export interface Submission {
  /** 提交编号：幂等键，同一编号只留一条时间线记录 */
  id: string;
  /** 提交所依据的修订号 */
  baseRevision: number;
  actor: string;
  role: Role;
  at: string;
  op: Operation;
}

export type EventKind = 'applied' | 'merged' | 'conflict' | 'noop' | 'rejected' | 'migrated';

export interface AuditEvent {
  id: string;
  at: string;
  /** 事件生效后的修订号；未改动状态的事件记录当前修订号 */
  revision: number;
  /** 提交所依据的修订号 */
  baseRevision: number;
  issueId: string | null;
  actor: string;
  role: Role;
  submissionId: string;
  kind: EventKind;
  message: string;
}

export interface MergeRelation {
  id: string;
  duplicateId: string;
  canonicalId: string;
  actor: string;
  at: string;
  revision: number;
  submissionId: string;
}

export interface FieldConflict {
  id: string;
  issueId: string;
  field: EditableField;
  baseValue: unknown;
  /** 别人已推进后的值（保留在问题上） */
  currentValue: unknown;
  /** 后到提交的值（保留在冲突记录里，两份都可见） */
  incomingValue: unknown;
  currentActor: string;
  incomingActor: string;
  at: string;
  status: 'pending' | 'resolved';
  resolution?: { by: string; at: string; chosen: 'current' | 'incoming'; value: unknown };
}

export interface WorkbenchState {
  version: 2;
  revision: number;
  issues: AuditIssue[];
  events: AuditEvent[];
  merges: MergeRelation[];
  conflicts: FieldConflict[];
}

export const ROLE_NAMES: Record<Role, string> = {
  auditor: '审计员',
  reviewer: '审核员',
  developer: '开发人员',
};

export const OP_NAMES: Record<Operation['kind'], string> = {
  create: '创建问题',
  edit: '编辑问题',
  triage: '分诊确认',
  fix: '修复提交',
  retest: '复测结论',
  merge: '重复合并',
  adjudicate: '裁决冲突',
};

/** 角色操作范围：越权提交会被拒绝 */
export const OP_ROLES: Record<Operation['kind'], Role[]> = {
  create: ['auditor'],
  edit: ['auditor'],
  triage: ['reviewer'],
  fix: ['developer'],
  retest: ['auditor'],
  merge: ['reviewer'],
  adjudicate: ['reviewer'],
};

export const FIELD_NAMES: Record<EditableField, string> = {
  title: '标题',
  flow: '业务流程',
  steps: '复现步骤',
  impactGroup: '影响人群',
  severity: '严重程度',
  status: '状态',
  fixNote: '修复记录',
  retestNote: '复测记录',
  canonicalId: '主问题',
};

export const STATUS_NAMES: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开',
};

export const SEVERITY_NAMES: Record<Severity, string> = {
  critical: '阻断',
  serious: '严重',
  moderate: '中等',
  minor: '轻微',
};

export function formatValue(field: EditableField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (field === 'status') return STATUS_NAMES[value as IssueStatus] ?? String(value);
  if (field === 'severity') return SEVERITY_NAMES[value as Severity] ?? String(value);
  return String(value);
}

export type CommitOutcome = 'applied' | 'merged' | 'conflict' | 'noop' | 'duplicate' | 'rejected';

export interface CommitResult {
  outcome: CommitOutcome;
  state: WorkbenchState;
  reason?: string;
}

export interface CommitContext {
  now?: string;
  newId?: () => string;
}

const norm = (value: unknown) => (value === undefined || value === null ? '' : value);
const sameValue = (a: unknown, b: unknown) => Object.is(norm(a), norm(b));

function withField(issue: AuditIssue, field: EditableField, value: unknown): AuditIssue {
  const draft = { ...issue } as Record<string, unknown>;
  draft[field] = value;
  return draft as unknown as AuditIssue;
}

function lastActorOf(state: WorkbenchState, issueId: string): string {
  return state.events.find((event) => event.issueId === issueId)?.actor ?? '另一成员';
}

export function commit(state: WorkbenchState, submission: Submission, ctx: CommitContext = {}): CommitResult {
  const now = ctx.now ?? new Date().toISOString();
  const newId = ctx.newId ?? (() => crypto.randomUUID());
  const sub = submission;

  // 幂等：同一提交编号只留一条时间线记录（断网重试、崩溃恢复都走这里）
  if (state.events.some((event) => event.submissionId === sub.id)) {
    return { outcome: 'duplicate', state };
  }

  const push = (
    kind: EventKind,
    issueId: string | null,
    message: string,
    next: Omit<WorkbenchState, 'events'>,
    outcome: CommitOutcome,
    reason?: string,
  ): CommitResult => {
    const event: AuditEvent = {
      id: newId(),
      at: now,
      revision: next.revision,
      baseRevision: sub.baseRevision,
      issueId,
      actor: sub.actor,
      role: sub.role,
      submissionId: sub.id,
      kind,
      message,
    };
    return { outcome, reason, state: { ...next, events: [event, ...state.events] } };
  };

  // 角色权限：越权提交被拒绝并记入时间线（不推进修订号）
  if (!OP_ROLES[sub.op.kind].includes(sub.role)) {
    const reason = `越权提交被拒绝：${ROLE_NAMES[sub.role]}无权执行「${OP_NAMES[sub.op.kind]}」`;
    return push('rejected', null, reason, state, 'rejected', reason);
  }

  const op = sub.op;

  if (op.kind === 'create') {
    if (state.issues.some((issue) => issue.id === op.issue.id)) {
      const reason = `问题编号 ${op.issue.id} 已存在`;
      return push('rejected', op.issue.id, `创建被拒绝：${reason}`, state, 'rejected', reason);
    }
    const revision = state.revision + 1;
    const issue: AuditIssue = { ...op.issue, revision, updatedAt: now };
    return push('applied', issue.id, `${sub.actor}创建问题「${issue.title}」`, { ...state, revision, issues: [issue, ...state.issues] }, 'applied');
  }

  if (op.kind === 'merge') {
    const duplicate = state.issues.find((issue) => issue.id === op.duplicateId);
    const canonical = state.issues.find((issue) => issue.id === op.canonicalId);
    if (!duplicate || !canonical) {
      return push('rejected', null, '重复合并被拒绝：目标问题不存在', state, 'rejected', '目标问题不存在');
    }
    if (duplicate.id === canonical.id) {
      return push('rejected', duplicate.id, '重复合并被拒绝：不能合并到自身', state, 'rejected', '不能合并到自身');
    }
    if (canonical.canonicalId) {
      return push('rejected', canonical.id, `重复合并被拒绝：「${canonical.title}」本身已是重复项`, state, 'rejected', '主问题本身已是重复项');
    }
    if (duplicate.canonicalId === canonical.id) {
      return push('noop', duplicate.id, `「${duplicate.title}」已合并到「${canonical.title}」，无需重复操作`, state, 'noop');
    }
    const revision = state.revision + 1;
    const relation: MergeRelation = {
      id: newId(),
      duplicateId: duplicate.id,
      canonicalId: canonical.id,
      actor: sub.actor,
      at: now,
      revision,
      submissionId: sub.id,
    };
    const issues = state.issues.map((issue) =>
      issue.id === duplicate.id ? { ...issue, canonicalId: canonical.id, revision, updatedAt: now } : issue,
    );
    return push(
      'applied',
      duplicate.id,
      `${sub.actor}将重复问题「${duplicate.title}」合并到主问题「${canonical.title}」`,
      { ...state, revision, issues, merges: [relation, ...state.merges] },
      'applied',
    );
  }

  if (op.kind === 'adjudicate') {
    const conflict = state.conflicts.find((item) => item.id === op.conflictId);
    if (!conflict) {
      return push('rejected', null, '裁决被拒绝：待裁决记录不存在', state, 'rejected', '待裁决记录不存在');
    }
    if (conflict.status !== 'pending') {
      return push('noop', conflict.issueId, `字段「${FIELD_NAMES[conflict.field]}」的冲突已被裁决，无需重复处理`, state, 'noop');
    }
    const issue = state.issues.find((item) => item.id === conflict.issueId);
    if (!issue) {
      return push('rejected', conflict.issueId, '裁决被拒绝：问题已不存在', state, 'rejected', '问题已不存在');
    }
    const value = op.choice === 'incoming' ? conflict.incomingValue : conflict.currentValue;
    const revision = state.revision + 1;
    const issues = state.issues.map((item) =>
      item.id === issue.id ? { ...withField(item, conflict.field, value), revision, updatedAt: now } : item,
    );
    const conflicts = state.conflicts.map((item) =>
      item.id === conflict.id
        ? { ...item, status: 'resolved' as const, resolution: { by: sub.actor, at: now, chosen: op.choice, value } }
        : item,
    );
    const chosenLabel = op.choice === 'incoming' ? '待合并值' : '当前值';
    return push(
      'applied',
      issue.id,
      `${sub.actor}裁决「${issue.title}」的字段「${FIELD_NAMES[conflict.field]}」：采用${chosenLabel}`,
      { ...state, revision, issues, conflicts },
      'applied',
    );
  }

  // edit / triage / fix / retest：带修订号的字段级更新
  const issue = state.issues.find((item) => item.id === op.issueId);
  if (!issue) {
    return push('rejected', op.issueId, '提交被拒绝：目标问题不存在', state, 'rejected', '目标问题不存在');
  }
  if (op.changes.length === 0) {
    return push('noop', issue.id, `${op.message}（无字段变化）`, state, 'noop');
  }

  const stale = sub.baseRevision < state.revision;
  let next = issue;
  const applied: EditableField[] = [];
  const newConflicts: FieldConflict[] = [];
  for (const change of op.changes) {
    const current = issue[change.field];
    if (sameValue(current, change.value)) continue; // 与当前值一致，无需写入
    if (!stale || sameValue(current, change.base)) {
      // 快进，或该字段自 baseRevision 以来没人动过：直接采用
      next = withField(next, change.field, change.value);
      applied.push(change.field);
    } else {
      // 两边都改了同一字段：当前值留在问题上，后到值挂成待裁决，两份都保留
      newConflicts.push({
        id: newId(),
        issueId: issue.id,
        field: change.field,
        baseValue: change.base,
        currentValue: current,
        incomingValue: change.value,
        currentActor: lastActorOf(state, issue.id),
        incomingActor: sub.actor,
        at: now,
        status: 'pending',
      });
    }
  }

  if (applied.length === 0 && newConflicts.length === 0) {
    return push('noop', issue.id, `${op.message}（与当前记录一致，未产生新变化）`, state, 'noop');
  }

  const revision = state.revision + 1;
  next = { ...next, revision, updatedAt: now };
  const issues = state.issues.map((item) => (item.id === issue.id ? next : item));
  const conflicts = [...newConflicts, ...state.conflicts];
  const fieldList = (fields: EditableField[]) => fields.map((field) => FIELD_NAMES[field]).join('、');

  if (newConflicts.length > 0) {
    const parts = [op.message];
    if (applied.length > 0) parts.push(`已合并字段：${fieldList(applied)}`);
    parts.push(`待裁决字段：${fieldList(newConflicts.map((item) => item.field))}`);
    return push('conflict', issue.id, parts.join('；'), { ...state, revision, issues, conflicts }, 'conflict');
  }
  if (stale) {
    return push(
      'merged',
      issue.id,
      `${op.message}（基于 r${sub.baseRevision} 提交，问题已被推进，已按字段合并到 r${revision}）`,
      { ...state, revision, issues, conflicts },
      'merged',
    );
  }
  return push('applied', issue.id, op.message, { ...state, revision, issues, conflicts }, 'applied');
}

export interface LegacyWorkbenchState {
  issues?: Array<Partial<AuditIssue> & { id: string }>;
  events?: Array<{ id: string; at: string; issueId: string; message: string }>;
}

function normalizeIssue(raw: Partial<AuditIssue> & { id: string }, now: string): AuditIssue {
  return {
    id: raw.id,
    title: raw.title ?? '未命名问题',
    flow: raw.flow ?? '',
    steps: raw.steps ?? '',
    impactGroup: raw.impactGroup ?? '',
    severity: raw.severity ?? 'moderate',
    status: raw.status ?? 'open',
    canonicalId: raw.canonicalId,
    fixNote: raw.fixNote ?? '',
    retestNote: raw.retestNote ?? '',
    revision: raw.revision ?? 0,
    updatedAt: raw.updatedAt ?? now,
  };
}

/**
 * 旧数据（v1，无修订号）升级：
 * 按时间顺序为历史记录回填修订号，原有 canonicalId 重复合并关系恢复为可查的合并记录。
 */
export function migrateLegacy(legacy: LegacyWorkbenchState, now = new Date().toISOString()): WorkbenchState {
  const issues = (legacy.issues ?? []).map((raw) => normalizeIssue(raw, now));
  const ordered = [...(legacy.events ?? [])].sort((a, b) => a.at.localeCompare(b.at));

  let revision = 0;
  const events: AuditEvent[] = [];
  for (const item of ordered) {
    revision += 1;
    events.push({
      id: `legacy-${item.id}`,
      at: item.at,
      revision,
      baseRevision: revision - 1,
      issueId: item.issueId ?? null,
      actor: '历史记录',
      role: 'auditor',
      submissionId: `legacy-${item.id}`,
      kind: 'migrated',
      message: item.message,
    });
  }

  const merges: MergeRelation[] = [];
  for (const issue of issues) {
    if (!issue.canonicalId) continue;
    if (!issues.some((item) => item.id === issue.canonicalId)) continue;
    revision += 1;
    merges.push({
      id: `legacy-merge-${issue.id}`,
      duplicateId: issue.id,
      canonicalId: issue.canonicalId,
      actor: '历史数据迁移',
      at: issue.updatedAt,
      revision,
      submissionId: `legacy-merge-${issue.id}`,
    });
  }

  // 问题的修订号回填为最后一次相关记录（事件或合并）的修订号
  const stamped = issues.map((issue) => {
    const related = [
      ...events.filter((event) => event.issueId === issue.id).map((event) => event.revision),
      ...merges.filter((rel) => rel.duplicateId === issue.id || rel.canonicalId === issue.id).map((rel) => rel.revision),
    ];
    return { ...issue, revision: related.length > 0 ? Math.max(...related) : revision };
  });

  const migrationEvent: AuditEvent = {
    id: 'legacy-migration',
    at: now,
    revision,
    baseRevision: revision,
    issueId: null,
    actor: '系统',
    role: 'auditor',
    submissionId: 'legacy-migration',
    kind: 'migrated',
    message: `数据升级：为 ${events.length} 条历史记录回填修订号，恢复 ${merges.length} 条重复合并关系`,
  };

  return { version: 2, revision, issues: stamped, events: [migrationEvent, ...events.reverse()], merges, conflicts: [] };
}

/** 固定基准时间，保证 SSR 与客户端水合渲染一致 */
const SEED_BASE = Date.UTC(2026, 9, 5, 9, 0, 0);

export function seedState(base = SEED_BASE): WorkbenchState {
  const at = (offsetMs: number) => new Date(base - offsetMs).toISOString();
  const issues: AuditIssue[] = [
    {
      id: 'issue-1',
      title: '结算弹窗关闭后焦点丢失',
      flow: '订单结算',
      steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
      impactGroup: '键盘与读屏用户',
      severity: 'serious',
      status: 'triaged',
      fixNote: '',
      retestNote: '',
      revision: 1,
      updatedAt: at(3600_000),
    },
    {
      id: 'issue-2',
      title: '错误提示未与输入框关联',
      flow: '账户设置',
      steps: '输入无效手机号后使用读屏读取输入框',
      impactGroup: '读屏用户',
      severity: 'moderate',
      status: 'fixing',
      fixNote: '已增加 aria-describedby，等待构建',
      retestNote: '',
      revision: 2,
      updatedAt: at(7000_000),
    },
  ];
  const events: AuditEvent[] = [
    {
      id: 'seed-2',
      at: at(7000_000),
      revision: 2,
      baseRevision: 1,
      issueId: 'issue-2',
      actor: '王开发',
      role: 'developer',
      submissionId: 'seed-2',
      kind: 'applied',
      message: '开发人员提交焦点管理修复',
    },
    {
      id: 'seed-1',
      at: at(3600_000),
      revision: 1,
      baseRevision: 0,
      issueId: 'issue-1',
      actor: '李审核',
      role: 'reviewer',
      submissionId: 'seed-1',
      kind: 'applied',
      message: '审核员确认问题有效并进入修复中',
    },
  ];
  return { version: 2, revision: 2, issues, events, merges: [], conflicts: [] };
}
