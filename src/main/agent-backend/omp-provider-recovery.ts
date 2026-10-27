/** A long quota wait switches models immediately, retaining the session and provider cooldown. */
import type { ChildProcess } from 'child_process';
import type { ClaudeProcessHandle } from '../claude-code/process';
import type { ClaudeResultMessage } from '../claude-code/stream-types';
import type { OmpRunOptions } from './omp-process';
import type { OmpRoleMap } from './omp-args';
import { resolveOmpSelection } from './omp-args';
import { getOmpFallbackPolicy, type OmpFallbackChains } from './omp-roles';
import { getOmpCooldownStore, ompFallbackCandidates, providerOf, type OmpCooldownStore, type OmpProviderCooldown } from './omp-cooldown';
import { ompLongCooldownMs } from './omp-retry';
import { appLog } from '../app-logger';

type Outcome = Awaited<ClaudeProcessHandle['done']>;
interface RecoveryDeps {
  store?: OmpCooldownStore;
  policy?: { roles: OmpRoleMap | undefined; chains: OmpFallbackChains };
  now?: () => number;
}

export async function startWithOmpCooldownRecovery(options: OmpRunOptions, spawn: (options: OmpRunOptions) => Promise<ClaudeProcessHandle>, deps: RecoveryDeps = {}): Promise<ClaudeProcessHandle> {
  const now = deps.now ?? Date.now;
  const store = deps.store ?? getOmpCooldownStore();
  const policy = deps.policy ?? await getOmpFallbackPolicy();
  const role = options.role ?? 'default';
  const selection = resolveOmpSelection(options.model, options.settings, role, policy.roles);
  let model = selection.concrete;
  let runOptions = options;
  let current: ClaudeProcessHandle | undefined;
  let stopped = false;
  const tried = new Set<string>();
  const carried = { cost: 0, turns: 0, duration: 0 };
  const unread = new Map<string, { id: string; text: string }>();
  const candidates = model ? ompFallbackCandidates(model, role, policy.chains, policy.roles) : [];
  const notice = (text: string) => {
    appLog.warn(`[OMP] ${text}`);
    try { options.onMessage?.({ type: 'system', subtype: 'omp_notice', level: 'warning', source: 'workbench', text }); }
    catch (error) { appLog.warn('[OMP] Cooldown notice listener failed:', error); }
  };
  const switchFrom = async (failed: string, cooldown: OmpProviderCooldown): Promise<boolean> => {
    const blocked = await store.active(now());
    // Include the failed fallback's own chain, while retaining unused alternatives of the primary.
    candidates.push(...ompFallbackCandidates(failed, role, policy.chains, policy.roles));
    const next = candidates.find((entry) => !tried.has(entry.model) && entry.model !== failed && !blocked[providerOf(entry.model) ?? '']);
    if (!next) return false;
    const effort = options.effort ?? 'medium';
    runOptions = { ...runOptions, model: next.model, ...(next.thinking ? { effort, settings: { ...runOptions.settings, thinking: { ...runOptions.settings.thinking, [effort]: next.thinking } } } : {}) };
    model = next.model;
    notice(`${cooldown.provider} is unavailable until ${cooldown.resetAt}; switching immediately to configured fallback ${next.model}.`);
    return true;
  };
  const earliestHold = (cooldown: OmpProviderCooldown, blocked: Record<string, OmpProviderCooldown>) => [cooldown, ...candidates.map((entry) => blocked[providerOf(entry.model) ?? '']).filter((entry): entry is OmpProviderCooldown => !!entry)].sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt))[0];
  const held = (cooldown: OmpProviderCooldown, previous?: Outcome): Outcome => {
    const message = `${cooldown.provider} is unavailable until ${cooldown.resetAt}. No configured fallback is available; task held until reset.`;
    notice(message);
    const result: ClaudeResultMessage = { ...(previous?.result ?? { type: 'result', session_id: '' }), subtype: 'error_during_execution', is_error: true,
      result: message, errors: [message], omp_cooldown: { ...cooldown, message }, total_cost_usd: carried.cost + (previous?.result?.total_cost_usd ?? 0), num_turns: carried.turns + (previous?.result?.num_turns ?? 0), duration_ms: carried.duration + (previous?.result?.duration_ms ?? 0) };
    return { exitCode: 0, signal: null, results: [], resultOrigins: [], stderr: '', aborted: false, timedOut: false, ...previous, result, unread: [...unread.values()] };
  };
  const prepare = async (): Promise<OmpProviderCooldown | undefined> => {
    const blocked = await store.active(now());
    const cooldown = blocked[providerOf(model) ?? ''];
    if (cooldown && model && !(await switchFrom(model, cooldown))) return earliestHold(cooldown, blocked);
    // Native fallback must not re-enter a provider whose cooldown is already known.
    if (Object.keys(blocked).length) {
      const chains = Object.fromEntries(Object.entries(policy.chains).map(([key, values]) => [key, values.filter((value) => !blocked[providerOf(value.startsWith('@') ? policy.roles?.[value.slice(1)] : value) ?? ''])]));
      runOptions = { ...runOptions, cooldownFallbackChains: chains };
      const advisor = runOptions.settings.advisorModel?.trim() || policy.roles?.advisor;
      const advisorHold = blocked[providerOf(advisor) ?? ''];
      if (advisor && advisorHold && runOptions.settings.advisor !== 'off' && !options.oneShot) {
        const replacement = ompFallbackCandidates(advisor, 'advisor', policy.chains, policy.roles).find((entry) => !blocked[providerOf(entry.model) ?? '']);
        notice(replacement ? `Advisor ${advisor} is cooling down; using configured fallback ${replacement.model}.` : `Advisor ${advisor} is cooling down; advisor disabled for this run.`);
        runOptions = { ...runOptions, settings: { ...runOptions.settings, ...(replacement ? { advisorModel: replacement.model } : { advisor: 'off' }) } };
      }
    }
    return undefined;
  };
  const initialHold = await prepare();
  if (!initialHold && !options.abortSignal?.aborted) {
    if (model) tried.add(model);
    current = await spawn(runOptions);
  }
  const done = (async (): Promise<Outcome> => {
    if (initialHold) return held(initialHold);
    if (!current) return { exitCode: null, signal: null, results: [], resultOrigins: [], unread: [], stderr: '', aborted: true, timedOut: false };
    for (;;) {
      const outcome = await current.done;
      for (const input of outcome.unread) unread.set(input.id, input);
      if (stopped || options.abortSignal?.aborted || outcome.aborted || outcome.timedOut) return outcome;
      const result = outcome.result;
      // Record every exhausted provider, including native fallbacks, even if the run recovered.
      const errors = result?.omp_errors ?? [];
      const reported = errors.length ? errors : [{ text: [result?.errors?.join(' '), outcome.stderr].filter(Boolean).join(' '), model, fallback: false }];
      for (const error of reported) {
        const delay = ompLongCooldownMs(error.text);
        const provider = providerOf(error.model ?? model);
        if (delay && provider) await store.record(provider, new Date(now() + delay).toISOString());
      }
      const workerErrors = reported.filter((error) => !error.fallback);
      const decisive = workerErrors.at(-1) ?? reported.at(-1);
      const failedModel = decisive?.model ?? model;
      const delay = decisive && ompLongCooldownMs(decisive.text);
      if (!result?.is_error || !delay || !failedModel) {
        return { ...outcome, result: result ? { ...result, total_cost_usd: carried.cost + (result.total_cost_usd ?? 0), num_turns: carried.turns + (result.num_turns ?? 0), duration_ms: carried.duration + (result.duration_ms ?? 0) } : result, unread: [...unread.values()] };
      }
      tried.add(failedModel);
      const blockedProviders = await store.active(now());
      const cooldown = blockedProviders[providerOf(failedModel) ?? ''];
      if (!cooldown || !(await switchFrom(failedModel, cooldown))) return cooldown ? held(earliestHold(cooldown, blockedProviders), outcome) : outcome;
      carried.cost += result.total_cost_usd ?? 0;
      carried.turns += result.num_turns ?? 0;
      carried.duration += result.duration_ms ?? 0;
      if (options.session && result.session_id) runOptions = { ...runOptions, session: { ...options.session, resume: result.session_id }, prompt: [{ type: 'text', text: 'The previous model hit a provider cooldown. Continue the existing task in this session on the newly selected model. Check existing work before repeating actions; do not redo completed work.' }] };
      const blocked = await prepare();
      if (blocked) return held(blocked);
      if (stopped || options.abortSignal?.aborted) return { ...outcome, aborted: true };
      current = await spawn(runOptions);
      if (stopped || options.abortSignal?.aborted) current.stop();
    }
  })();
  return { get child() { return current?.child as ChildProcess; }, done, stop: () => { stopped = true; current?.stop(); }, send: (text, id) => current?.send(text, id) ?? false };
}
