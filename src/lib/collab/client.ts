/**
 * 协作客户端：共享记录持久化、提交队列（断网/崩溃可恢复）与跨标签页同步。
 * - 共享记录存 localStorage，多标签页通过 storage 事件保持一致；
 * - 提交先进入本地队列再落库，Web Lock 串行化多标签页的读-改-写；
 * - 提交编号幂等：崩溃重试不会产生第二条时间线记录。
 */
import { createSignal, onCleanup, onMount } from 'solid-js';
import { commit, migrateLegacy, seedState } from './model';
import type { CommitOutcome, CommitResult, Operation, Role, Submission, WorkbenchState } from './model';

export const STATE_KEY = 'a11y-audit-v2';
export const LEGACY_KEY = 'a11y-audit-v1';
export const OUTBOX_KEY = 'a11y-audit-outbox-v2';
export const IDENTITY_KEY = 'a11y-audit-identity-v2';
const COMMIT_LOCK = 'a11y-audit-commit-lock';
/** sending 状态超过该时长视为孤儿（来源页已崩溃），任何标签页都可接管重试 */
const SENDING_TIMEOUT = 10_000;

export interface OutboxEntry {
  submission: Submission;
  status: 'pending' | 'sending';
  attempts: number;
  origin: string;
  updatedAt: number;
  lastError?: string;
}

export interface Identity {
  name: string;
  role: Role;
}

const isBrowser = () => typeof window !== 'undefined' && typeof localStorage !== 'undefined';
const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export function readSharedState(): WorkbenchState {
  if (!isBrowser()) return seedState();
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WorkbenchState;
      if (parsed?.version === 2) return parsed;
    } catch {
      /* 数据损坏时走重新初始化 */
    }
  }
  // 旧数据（无修订号）升级：回填修订号并保留重复合并关系，旧键保留作备份
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (legacyRaw) {
    try {
      const migrated = migrateLegacy(JSON.parse(legacyRaw));
      localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
      return migrated;
    } catch {
      /* 旧数据不可读时按新库处理 */
    }
  }
  const fresh = seedState();
  localStorage.setItem(STATE_KEY, JSON.stringify(fresh));
  return fresh;
}

function writeSharedState(state: WorkbenchState) {
  if (isBrowser()) localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function readOutbox(): OutboxEntry[] {
  if (!isBrowser()) return [];
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as OutboxEntry[];
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]) {
  if (isBrowser()) localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
}

function readIdentity(): Identity {
  if (isBrowser()) {
    try {
      const parsed = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null') as Identity | null;
      if (parsed?.role) return parsed;
    } catch {
      /* 忽略损坏的身份缓存 */
    }
  }
  return { name: '审计员 小周', role: 'auditor' };
}

export function createCollabClient() {
  const tabId = crypto.randomUUID();
  const [state, setState] = createSignal<WorkbenchState>(seedState());
  const [outbox, setOutbox] = createSignal<OutboxEntry[]>([]);
  const [online, setOnline] = createSignal(true);
  const [forceOfflineSignal, setForceOfflineSignal] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const [identity, setIdentity] = createSignal<Identity>(readIdentity());

  const isOffline = () => forceOfflineSignal() || !online();
  const refreshOutbox = () => setOutbox(readOutbox());

  const patchOutbox = (id: string, patch: Partial<OutboxEntry>) => {
    writeOutbox(readOutbox().map((entry) => (entry.submission.id === id ? { ...entry, ...patch, updatedAt: Date.now() } : entry)));
    refreshOutbox();
  };

  const removeFromOutbox = (id: string) => {
    writeOutbox(readOutbox().filter((entry) => entry.submission.id !== id));
    refreshOutbox();
  };

  const describe = (outcome: CommitOutcome, result: CommitResult, id: string) => {
    const short = id.slice(0, 8);
    switch (outcome) {
      case 'applied': return `提交 #${short} 已应用，当前修订号 r${result.state.revision}`;
      case 'merged': return `提交 #${short} 基于旧修订，已按字段合并到 r${result.state.revision}`;
      case 'conflict': return `提交 #${short} 与他人修改了同一字段，已保留两份并挂待裁决`;
      case 'noop': return `提交 #${short} 未产生新变化`;
      case 'duplicate': return `提交 #${short} 已存在于时间线，跳过重复记录`;
      case 'rejected': return `提交 #${short} 被拒绝：${result.reason ?? '无权操作'}`;
    }
  };

  const commitRemote = async (submission: Submission): Promise<CommitResult> => {
    const run = async (): Promise<CommitResult> => {
      await delay(120); // 模拟网络往返，让并发与重试路径可观察
      if (isOffline()) throw new Error('网络不可用');
      const shared = readSharedState();
      const result = commit(shared, submission);
      if (result.state !== shared) writeSharedState(result.state);
      setState(result.state);
      return result;
    };
    if (isBrowser() && navigator.locks) return navigator.locks.request(COMMIT_LOCK, run);
    return run();
  };

  let flushing = false;
  const flush = async () => {
    if (flushing || !isBrowser()) return;
    flushing = true;
    try {
      for (;;) {
        const candidate = readOutbox().find((entry) =>
          entry.status === 'pending' || (entry.status === 'sending' && Date.now() - entry.updatedAt > SENDING_TIMEOUT));
        if (!candidate) break;
        if (isOffline()) {
          setNotice('离线中：提交已保存在本地队列，恢复网络后自动继续');
          break;
        }
        patchOutbox(candidate.submission.id, { status: 'sending' });
        try {
          const result = await commitRemote(candidate.submission);
          removeFromOutbox(candidate.submission.id);
          setNotice(describe(result.outcome, result, candidate.submission.id));
        } catch (error) {
          patchOutbox(candidate.submission.id, {
            status: 'pending',
            attempts: candidate.attempts + 1,
            lastError: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    } finally {
      flushing = false;
      refreshOutbox();
    }
  };

  /** 构造提交（记录所依据的修订号与提交人身份），先入队再落库 */
  const submit = (op: Operation): string => {
    const me = identity();
    const submission: Submission = {
      id: crypto.randomUUID(),
      baseRevision: state().revision,
      actor: me.name.trim() || '未署名',
      role: me.role,
      at: new Date().toISOString(),
      op,
    };
    writeOutbox([...readOutbox(), { submission, status: 'pending', attempts: 0, origin: tabId, updatedAt: Date.now() }]);
    refreshOutbox();
    setNotice(`提交 #${submission.id.slice(0, 8)} 已加入队列（基于 r${submission.baseRevision}）`);
    void flush();
    return submission.id;
  };

  let started = false;
  /** 初始化：崩溃恢复、加载共享记录、注册跨标签页同步。幂等，可重复调用 */
  const start = () => {
    if (started || !isBrowser()) return;
    started = true;
    // 页面崩溃或断网后重开：把遗留的 sending 重置为 pending，接着未完成的提交继续
    writeOutbox(readOutbox().map((entry) =>
      entry.status === 'sending' ? { ...entry, status: 'pending' as const, updatedAt: Date.now() } : entry));
    setState(readSharedState());
    refreshOutbox();
    setOnline(navigator.onLine);
    const handleOnline = () => {
      setOnline(true);
      void flush();
    };
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STATE_KEY) setState(readSharedState());
      if (event.key === OUTBOX_KEY) {
        refreshOutbox();
        void flush(); // 协助清理其他标签页遗留的提交（幂等，不会重复记录）
      }
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('storage', handleStorage);
    onCleanup(() => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('storage', handleStorage);
    });
    void flush();
  };

  onMount(start);

  const updateIdentity = (patch: Partial<Identity>) => {
    const next = { ...identity(), ...patch };
    setIdentity(next);
    if (isBrowser()) localStorage.setItem(IDENTITY_KEY, JSON.stringify(next));
  };

  const setForceOffline = (value: boolean) => {
    setForceOfflineSignal(value);
    if (!value) void flush(); // 恢复网络（或关闭模拟断网）后接着未完成的提交继续
  };

  return {
    state,
    outbox,
    notice,
    identity,
    updateIdentity,
    online,
    forceOffline: forceOfflineSignal,
    setForceOffline,
    isOffline,
    submit,
    flush,
    start,
  };
}
