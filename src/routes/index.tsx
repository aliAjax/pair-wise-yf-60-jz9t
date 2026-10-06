import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import { createForm, reset, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import { LEGACY_KEY, STATE_KEY, createCollabClient } from '../lib/collab/client';
import {
  FIELD_NAMES,
  OP_NAMES,
  OP_ROLES,
  ROLE_NAMES,
  SEVERITY_NAMES,
  STATUS_NAMES,
  formatValue,
} from '../lib/collab/model';
import type {
  AuditIssue,
  EditableField,
  FieldChange,
  FieldConflict,
  Operation,
  Role,
} from '../lib/collab/model';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({
    title: '无障碍人工审计协作工作台',
    subtitle: '问题、修复与复测协作',
    issues: '审计问题',
    events: '操作时间线',
    activity: '操作记录',
    conflicts: '待裁决',
    merges: '重复合并关系',
    keyboard: '键盘说明',
  }),
  en: flatten({
    title: 'Accessibility Audit Workbench',
    subtitle: 'Issues, fixes and retesting',
    issues: 'Audit issues',
    events: 'Activity timeline',
    activity: 'Activity',
    conflicts: 'Pending adjudication',
    merges: 'Merge relations',
    keyboard: 'Keyboard',
  }),
};

export default function AuditWorkbench() {
  const collab = createCollabClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [selectedId, setSelectedId] = createSignal('');
  const [mergeInto, setMergeInto] = createSignal('');

  const issues = createMemo(() => collab.state().issues);
  const selected = createMemo(() => issues().find((issue) => issue.id === selectedId()) ?? issues()[0]);
  const pendingConflicts = createMemo(() => collab.state().conflicts.filter((item) => item.status === 'pending'));
  const resolvedConflicts = createMemo(() => collab.state().conflicts.filter((item) => item.status === 'resolved'));
  const issueTitle = (id: string) => issues().find((issue) => issue.id === id)?.title ?? id;
  const duplicatesOf = (issueId: string) => collab.state().merges.filter((rel) => rel.canonicalId === issueId);
  const allowedOps = createMemo(() =>
    (Object.keys(OP_ROLES) as Operation['kind'][])
      .filter((kind) => OP_ROLES[kind].includes(collab.identity().role))
      .map((kind) => OP_NAMES[kind])
      .join('、'));

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', collab.state().revision],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(issues()), 120)),
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema),
  });

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = {
      id: crypto.randomUUID(),
      ...values,
      status: 'open',
      fixNote: '',
      retestNote: '',
      revision: collab.state().revision,
      updatedAt: new Date().toISOString(),
    };
    collab.submit({ kind: 'create', issue });
    setSelectedId(issue.id);
    reset(form);
  };

  /** 字段变更以当前可见值为基准值：问题被别人推进时按字段三方合并 */
  const change = (issue: AuditIssue, field: EditableField, value: unknown): FieldChange => ({
    field,
    base: issue[field],
    value,
  });

  const act = (kind: 'triage' | 'fix' | 'retest', issue: AuditIssue, changes: FieldChange[], message: string) => {
    collab.submit({ kind, issueId: issue.id, changes, message });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = issues().find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    collab.submit({ kind: 'merge', duplicateId: duplicate.id, canonicalId: canonical.id });
    setSelectedId(canonical.id);
    setMergeInto('');
  };

  const adjudicate = (conflict: FieldConflict, choice: 'current' | 'incoming') => {
    collab.submit({ kind: 'adjudicate', conflictId: conflict.id, choice });
  };

  /** 写入一份 v1 格式的旧数据并刷新，演示无修订号数据的升级回填 */
  const simulateLegacyUpgrade = () => {
    const legacy = {
      issues: [
        { id: 'legacy-1', title: '登录框缺少可访问名称', flow: '登录', steps: '打开登录页，用读屏聚焦账号输入框', impactGroup: '读屏用户', severity: 'critical', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 86400_000).toISOString() },
        { id: 'legacy-2', title: '登录输入框标签缺失（重复报告）', flow: '登录', steps: '与 legacy-1 相同的复现路径', impactGroup: '读屏用户', severity: 'serious', status: 'open', canonicalId: 'legacy-1', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 80000_000).toISOString() },
      ],
      events: [
        { id: 'e1', at: new Date(Date.now() - 86400_000).toISOString(), issueId: 'legacy-1', message: '审计员创建问题并保存证据' },
        { id: 'e2', at: new Date(Date.now() - 80000_000).toISOString(), issueId: 'legacy-2', message: '审核员确认与主问题重复并完成合并' },
      ],
    };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    localStorage.removeItem(STATE_KEY);
    location.reload();
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">WCAG 人工审计协作</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p>
          </div>
          <div class="identity" role="group" aria-label="当前身份">
            <label>提交人
              <input
                value={collab.identity().name}
                onInput={(event) => collab.updateIdentity({ name: event.currentTarget.value })}
              />
            </label>
            <label>角色
              <select
                value={collab.identity().role}
                onChange={(event) => collab.updateIdentity({ role: event.currentTarget.value as Role })}
              >
                <option value="auditor">审计员</option>
                <option value="reviewer">审核员</option>
                <option value="developer">开发人员</option>
              </select>
            </label>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>
              {language() === 'zh' ? 'English' : '中文'}
            </button>
          </div>
        </header>

        <section class="syncbar" aria-label="协作同步状态">
          <span class="badge rev">修订号 r{collab.state().revision}</span>
          <span>{issueQuery.isSuccess ? '同步正常' : '同步中'}</span>
          <span>待提交 {collab.outbox().length} 条</span>
          <label class="inline">
            <input
              type="checkbox"
              checked={collab.forceOffline()}
              onChange={(event) => collab.setForceOffline(event.currentTarget.checked)}
            />
            模拟断网
          </label>
          <button class="secondary" disabled={collab.outbox().length === 0} onClick={() => void collab.flush()}>重试提交</button>
          <button class="secondary" onClick={simulateLegacyUpgrade}>模拟旧版数据升级</button>
        </section>
        <Show when={collab.isOffline()}>
          <p class="offline" role="alert">当前处于离线状态：提交会保存在本地队列，恢复网络后自动继续，同一提交编号只记录一次。</p>
        </Show>
        <Show when={collab.outbox().length > 0}>
          <ul class="outbox" aria-label="未完成的提交">
            <For each={collab.outbox()}>{(entry) => (
              <li>
                #{entry.submission.id.slice(0, 8)} · {OP_NAMES[entry.submission.op.kind]} · {entry.submission.actor}
                {' · '}{entry.status === 'sending' ? '提交中' : '等待提交'}（基于 r{entry.submission.baseRevision}）
                <Show when={entry.lastError}> · 上次失败：{entry.lastError}</Show>
              </li>
            )}</For>
          </ul>
        </Show>
        <Show when={collab.notice()}>
          <p class="notice" role="status">{collab.notice()}</p>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{issues().length}</strong></div>
          <div class="card"><span>待修复</span><strong>{issues().filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{issues().filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>待裁决</span><strong>{pendingConflicts().length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={issues()}>{(issue) => {
              const hasConflict = createMemo(() => pendingConflicts().some((item) => item.issueId === issue.id));
              return (
                <article class="issue">
                  <h3>
                    <button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selected()?.id === issue.id ? 'true' : undefined}>
                      {issue.title}
                    </button>
                  </h3>
                  <div class="meta">
                    <span class="badge">{STATUS_NAMES[issue.status]}</span>
                    <span class="badge">{SEVERITY_NAMES[issue.severity]}</span>
                    <span>{issue.flow}</span>
                    <span>{issue.impactGroup}</span>
                    <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                    <Show when={hasConflict()}><span class="badge warn">待裁决</span></Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} keyed fallback={<p role="status">暂无审计问题。</p>}>{(issue) => (
              <>
                <h3>{issue.title} <small class="rev-tag">r{issue.revision}</small></h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <Show when={issue.canonicalId}>
                  <p>已合并到主问题「{issueTitle(issue.canonicalId!)}」{' '}
                    <button class="secondary" onClick={() => setSelectedId(issue.canonicalId!)}>查看主问题</button>
                  </p>
                </Show>
                <Show when={duplicatesOf(issue.id).length > 0}>
                  <p>并入的重复项：{duplicatesOf(issue.id).map((rel) => `「${issueTitle(rel.duplicateId)}」`).join('、')}</p>
                </Show>
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => act('triage', issue, [change(issue, 'status', 'triaged')], '审核员完成分诊')}>确认问题</button>{' '}
                  <button onClick={() => act('fix', issue, [change(issue, 'status', 'fixing'), change(issue, 'fixNote', '修复进行中，等待提交复测版本')], '开发人员开始修复')}>开始修复</button>{' '}
                  <button onClick={() => act('fix', issue, [change(issue, 'status', 'verifying')], '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                  <button onClick={() => act('retest', issue, [change(issue, 'status', 'closed'), change(issue, 'retestNote', '键盘、读屏和错误提示均已通过')], '复测通过并关闭问题')}>复测通过</button>{' '}
                  <button class="danger" onClick={() => act('retest', issue, [change(issue, 'status', 'reopened'), change(issue, 'retestNote', '焦点顺序仍不正确')], '复测失败并重新打开')}>复测失败</button>
                </div>
                <p class="hint">当前身份：{ROLE_NAMES[collab.identity().role]}，可执行：{allowedOps()}。越权提交会被拒绝并记入时间线。</p>
                <hr />
                <label>合并到主问题
                  <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                    <option value="">选择问题</option>
                    <For each={issues().filter((item) => item.id !== issue.id && !item.canonicalId)}>
                      {(item) => <option value={item.id}>{item.title}</option>}
                    </For>
                  </select>
                </label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>
            )}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm
              onSubmit={createIssue}
              style="margin-top:12px"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  event.currentTarget.requestSubmit();
                }
              }}
            >
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
              <p class="hint">创建问题需要审计员身份，其他角色提交会被拒绝。</p>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List>
                <Tabs.Trigger value="activity">{t()('activity')}</Tabs.Trigger>
                <Tabs.Trigger value="conflicts">{t()('conflicts')}（{pendingConflicts().length}）</Tabs.Trigger>
                <Tabs.Trigger value="merges">{t()('merges')}</Tabs.Trigger>
                <Tabs.Trigger value="keyboard">{t()('keyboard')}</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={collab.state().events.slice(0, 15)}>{(event) => (
                    <div class={`event ${event.kind}`}>
                      <div class="meta">
                        <span class="badge">r{event.revision}</span>
                        <Show when={event.baseRevision < event.revision - 1}>
                          <span class="badge warn">基于 r{event.baseRevision}</span>
                        </Show>
                        <strong>{new Date(event.at).toLocaleString()}</strong>
                        <span>{event.actor}（{ROLE_NAMES[event.role]}）</span>
                        <code title={`提交编号 ${event.submissionId}`}>#{event.submissionId.slice(0, 8)}</code>
                      </div>
                      <div>{event.message}</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="conflicts">
                <Show when={pendingConflicts().length === 0}><p role="status">没有待裁决的字段冲突。</p></Show>
                <For each={pendingConflicts()}>{(conflict) => (
                  <div class="conflict">
                    <strong>「{issueTitle(conflict.issueId)}」的字段「{FIELD_NAMES[conflict.field]}」</strong>
                    <div class="compare">
                      <div>
                        <span class="badge">当前值 · {conflict.currentActor}</span>
                        <p>{formatValue(conflict.field, conflict.currentValue)}</p>
                        <button class="secondary" onClick={() => adjudicate(conflict, 'current')}>保留当前值</button>
                      </div>
                      <div>
                        <span class="badge warn">待合并值 · {conflict.incomingActor}</span>
                        <p>{formatValue(conflict.field, conflict.incomingValue)}</p>
                        <button onClick={() => adjudicate(conflict, 'incoming')}>采用待合并值</button>
                      </div>
                    </div>
                    <small>基准值：{formatValue(conflict.field, conflict.baseValue)} · {new Date(conflict.at).toLocaleString()} · 需审核员裁决</small>
                  </div>
                )}</For>
                <For each={resolvedConflicts()}>{(conflict) => (
                  <div class="conflict resolved">
                    <strong>「{issueTitle(conflict.issueId)}」的字段「{FIELD_NAMES[conflict.field]}」</strong>
                    <div>
                      已裁决为：{formatValue(conflict.field, conflict.resolution?.value)}
                      {' · '}{conflict.resolution?.by}
                      {' · '}{conflict.resolution ? new Date(conflict.resolution.at).toLocaleString() : ''}
                    </div>
                  </div>
                )}</For>
              </Tabs.Content>
              <Tabs.Content value="merges">
                <Show when={collab.state().merges.length === 0}><p role="status">暂无重复合并关系。</p></Show>
                <For each={collab.state().merges}>{(relation) => (
                  <div class="merge-line">
                    <button class="secondary" onClick={() => setSelectedId(relation.duplicateId)}>「{issueTitle(relation.duplicateId)}」</button>
                    {' → 主问题 '}
                    <button class="secondary" onClick={() => setSelectedId(relation.canonicalId)}>「{issueTitle(relation.canonicalId)}」</button>
                    <div class="meta">
                      <span class="badge">r{relation.revision}</span>
                      <span>{relation.actor}</span>
                      <span>{new Date(relation.at).toLocaleString()}</span>
                    </div>
                  </div>
                )}</For>
              </Tabs.Content>
              <Tabs.Content value="keyboard">
                <ul>
                  <li><kbd>N</kbd>：聚焦新建问题标题</li>
                  <li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li>
                  <li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li>
                  <li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li>
                </ul>
              </Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
