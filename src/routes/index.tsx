import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createForm, reset, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  ACTION_LABEL,
  ROLE_LABEL,
  STORAGE_KEY,
  acquireLock,
  applySubmission,
  can,
  loadState,
  readServerState,
  releaseLock,
  saveState,
  type ApplyResult,
  type AuditIssue,
  type FieldConflict,
  type Role,
  type Submission
} from '~/lib/collab';
const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const STATUS_LABEL: Record<string, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  flow: '业务流程',
  steps: '复现步骤',
  impactGroup: '影响人群',
  severity: '严重程度',
  status: '状态',
  canonicalId: '合并目标',
  fixNote: '修复记录',
  retestNote: '复测记录'
};

interface Identity {
  name: string;
  role: Role;
}
const IDENTITY_KEY = 'a11y-audit-identity';
function loadIdentity(): Identity {
  if (typeof localStorage === 'undefined') return { name: '', role: 'auditor' };
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) return JSON.parse(raw) as Identity;
  } catch {
    /* ignore */
  }
  return { name: '', role: 'auditor' };
}

const SUBMISSION_STATUS_LABEL: Record<Submission['status'], string> = {
  pending: '待提交',
  applied: '已应用',
  conflict: '已应用·有冲突',
  rejected: '已拒绝'
};

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore(loadState());
  const [identity, setIdentity] = createSignal<Identity>(loadIdentity());
  const [offline, setOffline] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [rejection, setRejection] = createSignal('');
  let flushing = false;

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const pendingCount = createMemo(() => state.outbox.filter((o) => o.status === 'pending').length);
  const myConflicts = createMemo(() => selected()?.conflicts.filter((c) => c.status === 'pending') ?? []);

  createEffect(() => saveState(state));
  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity()));
  });

  /** 提交先入发件箱，再异步刷新；断网时留在发件箱，联网或重开页面后重试 */
  const enqueue = (issueId: string, action: string, changes: Record<string, unknown>, opts?: { conflictResolve?: Submission['conflictResolve'] }) => {
    const issue = state.issues.find((i) => i.id === issueId);
    const sub: Submission = {
      id: crypto.randomUUID(),
      issueId,
      action,
      baseRevision: issue?.revision ?? 0,
      submitter: identity().name.trim() || ROLE_LABEL[identity().role],
      role: identity().role,
      changes,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
      conflictResolve: opts?.conflictResolve
    };
    setState('outbox', (outbox) => [...outbox, sub]);
    void flushOutbox();
  };

  const flushOutbox = async () => {
    if (offline() || flushing) return;
    flushing = true;
    try {
      // 跨标签页锁：同一时刻只让一个标签页提交，避免两人同时提交互相覆盖
      while (!acquireLock()) {
        if (offline()) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // 模拟网络往返延迟；断网时留在发件箱，恢复后由 effect 重试
      await new Promise((resolve) => setTimeout(resolve, 250));
      // 提交前重读“服务器”最新状态，别人已推进的修订号会参与字段级合并
      const draft = readServerState();
      const pending = state.outbox.filter((o) => o.status === 'pending');
      const results: { sub: Submission; result: ApplyResult }[] = [];
      for (const sub of pending) {
        if (!draft.outbox.some((o) => o.id === sub.id)) draft.outbox.push({ ...sub });
        const result = applySubmission(draft, sub);
        results.push({ sub, result });
        const item = draft.outbox.find((o) => o.id === sub.id);
        if (item) {
          item.attempts += 1;
          if (result.status === 'duplicate') item.status = 'applied';
          else if (result.status === 'rejected') {
            item.status = 'rejected';
            item.error = result.reason;
          } else if (result.status === 'conflict') item.status = 'conflict';
          else item.status = 'applied';
        }
      }
      saveState(draft);
      setState(draft);
      for (const { sub, result } of results) {
        if (result.status === 'rejected') {
          const ev = draft.events.find((e) => e.submissionId === sub.id && e.kind === 'rejected');
          if (ev) setRejection(ev.message);
        }
      }
    } finally {
      releaseLock();
      flushing = false;
    }
  };

  createEffect(() => {
    if (!offline() && pendingCount() > 0) void flushOutbox();
  });

  const createIssue = (values: IssueForm) => {
    const id = crypto.randomUUID();
    enqueue(id, 'issue.create', { ...values });
    setSelectedId(id);
    reset(form);
  };

  const act = (issue: AuditIssue, action: string, changes: Record<string, unknown>) => enqueue(issue.id, action, changes);

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    enqueue(duplicate.id, 'issue.merge', { canonicalId: canonical.id });
    setSelectedId(canonical.id);
    setMergeInto('');
  };

  const adjudicate = (issue: AuditIssue, conflict: FieldConflict, choice: 'ours' | 'theirs') => {
    const value = choice === 'ours' ? conflict.ours : conflict.theirs;
    enqueue(issue.id, 'conflict.resolve', { [conflict.field]: value }, { conflictResolve: { field: conflict.field, choice } });
  };

  onMount(() => {
    // 页面崩溃/刷新后重开：发件箱里未完成的提交自动接着重试
    void flushOutbox();
    // 其他标签页提交后，同步“服务器”最新状态（修订号、合并关系、时间线）
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && !flushing) setState(readServerState());
    };
    window.addEventListener('storage', onStorage);
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('keydown', shortcut);
    });
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 每次提交携带修订号与提交人，字段级合并，冲突待裁决</p></div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            <label style="display:flex;gap:6px;align-items:center;font-weight:600">
              提交人
              <input
                value={identity().name}
                onInput={(e) => setIdentity({ ...identity(), name: e.currentTarget.value })}
                placeholder="姓名"
                style="padding:7px 9px"
                aria-label="提交人姓名"
              />
            </label>
            <label style="display:flex;gap:6px;align-items:center;font-weight:600">
              角色
              <select
                value={identity().role}
                onChange={(e) => setIdentity({ ...identity(), role: e.currentTarget.value as Role })}
                style="padding:7px 9px"
                aria-label="操作角色"
              >
                <option value="auditor">审计员</option>
                <option value="reviewer">审核员</option>
                <option value="developer">开发人员</option>
              </select>
            </label>
            <button class={offline() ? 'danger' : 'secondary'} onClick={() => setOffline(!offline())} aria-pressed={offline()}>
              {offline() ? '模拟断网中（点击恢复）' : '模拟网络正常'}
            </button>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <Show when={rejection()}>
          <div class="card" role="alert" style="border-color:#f3b8b0;background:#fef6f5;margin-bottom:14px">
            <strong>越权提交已被拒绝：</strong>{rejection()}
          </div>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>待裁决冲突</span><strong>{state.issues.reduce((n, i) => n + i.conflicts.filter((c) => c.status === 'pending').length, 0)}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{pendingCount() ? `发件箱 ${pendingCount()} 条待提交` : '同步正常'}</small></h2>
            <For each={state.issues}>{(issue) => {
              const pending = issue.conflicts.filter((c) => c.status === 'pending').length;
              return (
                <article class="issue">
                  <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                  <div class="meta">
                    <span class="badge">修订 #{issue.revision}</span>
                    <span class="badge">{STATUS_LABEL[issue.status] ?? issue.status}</span>
                    <span class="badge">{issue.severity}</span>
                    <span>{issue.flow}</span>
                    <span>{issue.impactGroup}</span>
                    <Show when={issue.canonicalId}><span class="badge">重复项 → {state.issues.find((i) => i.id === issue.canonicalId)?.title ?? '已合并'}</span></Show>
                    <Show when={pending}><span class="badge" style="background:#fdecea;color:#b42318">{pending} 处冲突待裁决</span></Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return (
                <>
                  <h3>{issue.title} <span class="badge">修订 #{issue.revision}</span></h3>
                  <p><strong>复现步骤：</strong>{issue.steps}</p>
                  <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                  <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>

                  <For each={myConflicts()}>{(conflict) => (
                    <div class="card" role="alert" style="border-color:#f0c6b0;background:#fff8f3;margin:10px 0;padding:12px">
                      <strong>字段「{FIELD_LABEL[conflict.field] ?? conflict.field}」存在待裁决冲突</strong>
                      <p style="margin:6px 0;font-size:14px">
                        基础值：{String(conflict.base) || '（空）'}<br />
                        提交人版本：{String(conflict.ours) || '（空）'}<br />
                        当前版本：{String(conflict.theirs) || '（空）'}
                      </p>
                      <div role="group" aria-label={`裁决${FIELD_LABEL[conflict.field] ?? conflict.field}冲突`}>
                        <button onClick={() => adjudicate(issue, conflict, 'ours')}>采用提交人版本</button>{' '}
                        <button class="secondary" onClick={() => adjudicate(issue, conflict, 'theirs')}>采用当前版本</button>
                      </div>
                    </div>
                  )}</For>

                  <div role="group" aria-label="问题状态操作">
                    <button
                      title={can(identity().role, 'issue.triage') ? '' : '仅审核员可执行（点击将被拒绝并记录）'}
                      onClick={() => act(issue, 'issue.triage', { status: 'triaged' })}
                    >确认问题</button>{' '}
                    <button
                      title={can(identity().role, 'fix.start') ? '' : '仅开发人员可执行（点击将被拒绝并记录）'}
                      onClick={() => act(issue, 'fix.start', { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' })}
                    >开始修复</button>{' '}
                    <button
                      title={can(identity().role, 'fix.submit') ? '' : '仅开发人员可执行（点击将被拒绝并记录）'}
                      onClick={() => act(issue, 'fix.submit', { status: 'verifying' })}
                    >提交复测</button>{' '}
                    <button
                      title={can(identity().role, 'retest.pass') ? '' : '仅审核员可执行（点击将被拒绝并记录）'}
                      onClick={() => act(issue, 'retest.pass', { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' })}
                    >复测通过</button>{' '}
                    <button
                      class="danger"
                      title={can(identity().role, 'retest.fail') ? '' : '仅审核员可执行（点击将被拒绝并记录）'}
                      onClick={() => act(issue, 'retest.fail', { status: 'reopened', retestNote: '焦点顺序仍不正确' })}
                    >复测失败</button>
                  </div>
                  <p class="meta" style="margin-top:6px">当前角色：{ROLE_LABEL[identity().role]} · 越权按钮会被拒绝并记录在时间线；冲突字段可在上方裁决</p>
                  <hr />
                  <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                  <button disabled={!mergeInto()} title={can(identity().role, 'issue.merge') ? '' : '仅审核员可执行（点击将被拒绝并记录）'} onClick={mergeDuplicate}>确认重复合并</button>
                </>
              );
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{(field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
              <AuditField name="flow">{(field, props) => <label>业务流程<input {...props} value={field.value} /></label>}</AuditField>
              <AuditField name="steps">{(field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} /></label>}</AuditField>
              <AuditField name="impactGroup">{(field, props) => <label>影响人群<select {...props} value={field.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
              <AuditField name="severity">{(field, props) => <label>严重程度<select {...props} value={field.value}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
              <button type="submit" title={can(identity().role, 'issue.create') ? '' : '仅审计员可创建问题（点击将被拒绝并记录）'}>创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="outbox">发件箱 {pendingCount() ? `(${pendingCount()})` : ''}</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={state.events.slice(0, 16)}>{(event) => (
                    <div style="margin-bottom:12px">
                      <strong>{new Date(event.at).toLocaleString()}</strong>{' '}
                      <span class="badge" style={
                        event.kind === 'rejected'
                          ? 'background:#fdecea;color:#b42318'
                          : event.kind === 'backfill'
                            ? 'background:#eef2f3;color:#5d7780'
                            : 'background:#e2f3f2;color:#0d6664'
                      }>{event.kind === 'commit' ? '提交' : event.kind === 'rejected' ? '拒绝' : '回填'}</span>{' '}
                      <Show when={event.revision}><span class="badge">修订 #{event.revision}</span></Show>
                      <Show when={event.baseRevision}><span class="badge" style="background:#eef2f3;color:#5d7780">基于 #{event.baseRevision}</span></Show>
                      <Show when={event.submitter}><span class="badge" style="background:#eef7ee;color:#2c6b2f">{event.submitter}</span></Show>
                      <Show when={event.submissionId}><span class="badge" style="background:#f4f1ea;color:#6b5d2f" title="提交编号（幂等键）">编号 {event.submissionId?.slice(0, 8)}</span></Show>
                      <div>{event.message}</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="outbox">
                <Show when={state.outbox.length === 0}><p>发件箱为空。所有提交均已送达。</p></Show>
                <For each={state.outbox}>{(sub) => (
                  <div class="issue" style="padding:10px 4px">
                    <div class="meta">
                      <span class="badge">{SUBMISSION_STATUS_LABEL[sub.status]}</span>
                      <span class="badge">{ROLE_LABEL[sub.role]}</span>
                      <span class="badge">基于修订 #{sub.baseRevision}</span>
                      <span>编号 {sub.id.slice(0, 8)}</span>
                      <span>重试 {sub.attempts} 次</span>
                    </div>
                    <div style="margin-top:4px">{sub.submitter} · {ACTION_LABEL[sub.action] ?? sub.action}<Show when={sub.error}> · {sub.error}</Show></div>
                  </div>
                )}</For>
                <Show when={pendingCount() > 0}>
                  <button style="margin-top:10px" onClick={() => void flushOutbox()} disabled={offline()}>
                    {offline() ? '断网中，恢复后自动重试' : '立即重试未完成提交'}
                  </button>
                </Show>
              </Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
