/**
 * "Tasks" sheet on the phone: pick a template (or write the prompt), a folder, a push when it
 * finishes, and when to run: now, tonight at 2:00 or a time of your choice. Scheduled tasks
 * are listed in a second tab to edit or cancel. The prompt goes to Claude Code (the user's
 * Claude quick start).
 *
 * The server does the work (POST /api/tasks): it starts the session, types the prompt once
 * the agent is ready, fires scheduled tasks on time and sends the "Task finished" push.
 *
 * Touch acts on pointerup and swallows the click that follows (utils/ghost-click.ts); clicks
 * within 500 ms of opening are ignored (the tap that opened the sheet).
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  isTaskErrorCode,
  nextNightAt2,
  type TaskErrorCode,
  type TaskRecord,
  type TaskTemplate,
} from '../../shared/tasks.js';
import { type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';

const BUILTIN_IDS = ['tests', 'lint', 'summary', 'deps', 'lastCommit'] as const;

/** The built-in templates, in the user's language. */
export function builtinTemplates(): TaskTemplate[] {
  return BUILTIN_IDS.map((id) => ({
    id: `builtin-${id}`,
    name: t(`tasks.tpl.${id}.name` as MessageKey),
    prompt: t(`tasks.tpl.${id}.prompt` as MessageKey),
  }));
}

type When = 'now' | 'tonight' | 'custom';

/** The app's text for a task error code (the API's English text otherwise). */
export function taskErrorText(code: TaskErrorCode | undefined, fallback = ''): string {
  return code ? t(`tasks.error.${code}` as MessageKey) : fallback;
}

/** An API error carrying the server's TaskErrorCode, when it sent one. */
class TaskApiError extends Error {
  constructor(
    message: string,
    readonly code?: TaskErrorCode
  ) {
    super(message);
  }
}

function errorText(error: unknown): string {
  if (error instanceof TaskApiError && error.code) return taskErrorText(error.code);
  return error instanceof Error ? error.message : String(error);
}

/** "2030-01-15T14:05" in local time, for <input type="datetime-local">. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface TaskSheetOptions {
  /** Folders to offer, the default first. */
  folders: string[];
  /** Claude Code's command line (the user's Claude quick start). */
  command: string[];
  /** A task started now: open its session. */
  onStarted?: (sessionId: string) => void;
}

@customElement('task-sheet')
export class TaskSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) options: TaskSheetOptions = {
    folders: ['~'],
    command: ['claude'],
  };

  @state() private tab: 'new' | 'scheduled' = 'new';
  @state() private templates: TaskTemplate[] = [];
  @state() private templateId = '';
  @state() private name = '';
  @state() private prompt = '';
  @state() private folder = '';
  @state() private otherFolder = false;
  @state() private notify = true;
  @state() private when: When = 'now';
  @state() private customTime = '';
  @state() private tasks: TaskRecord[] = [];
  @state() private busy = false;
  @state() private error = '';
  /** The scheduled task being edited (its form replaces "new"). */
  @state() private editingId = '';

  private openedAt = 0;
  private actionAt = 0;
  private releaseFocus: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    this.folder = this.options.folders[0] || '~';
    void this.loadTemplates();
    void this.loadTasks();
  }

  firstUpdated() {
    const sheet = this.querySelector<HTMLElement>('.task-sheet');
    this.releaseFocus = holdSheetFocus(sheet, this.close, document.activeElement);
    requestAnimationFrame(() => sheet?.classList.add('open'));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.releaseFocus?.();
    this.releaseFocus = null;
  }

  close = () => {
    this.dispatchEvent(new CustomEvent('close'));
    this.remove();
  };

  /** pointerup for touch (click swallowed), click for mouse and keyboard. */
  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < 500) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A scroll of the form that started on a button ends here too: not a tap.
          if (endsADrag(e as PointerEvent)) return;
          this.actionAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.actionAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authClient.getAuthHeader(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new TaskApiError(
        body.error || response.statusText,
        isTaskErrorCode(body.code) ? body.code : undefined
      );
    }
    return body as T;
  }

  private async loadTemplates() {
    try {
      const { templates } = await this.api<{ templates: TaskTemplate[] }>('/api/task-templates');
      this.templates = templates;
    } catch {
      this.templates = [];
    }
  }

  private async loadTasks() {
    try {
      const { tasks } = await this.api<{ tasks: TaskRecord[] }>('/api/tasks');
      this.tasks = tasks;
    } catch {
      this.tasks = [];
    }
  }

  private allTemplates(): TaskTemplate[] {
    return [...builtinTemplates(), ...this.templates];
  }

  private pickTemplate(template: TaskTemplate) {
    this.templateId = template.id;
    this.name = template.name;
    this.prompt = template.prompt;
  }

  private isUserTemplate(): boolean {
    return this.templates.some((tpl) => tpl.id === this.templateId);
  }

  private runAt(): Date | null | 'invalid' {
    if (this.when === 'now') return null;
    if (this.when === 'tonight') return nextNightAt2();
    if (!this.customTime) return 'invalid';
    const date = new Date(this.customTime);
    return Number.isNaN(date.getTime()) ? 'invalid' : date;
  }

  private taskName(): string {
    return (this.name.trim() || this.prompt.trim().split('\n')[0]).slice(0, 80);
  }

  private async submit() {
    if (this.busy || !this.prompt.trim()) return;
    const runAt = this.runAt();
    if (runAt === 'invalid') {
      this.error = t('tasks.pickTime');
      return;
    }
    if (runAt && runAt.getTime() < Date.now() - 60_000) {
      this.error = taskErrorText('pastTime');
      return;
    }
    this.busy = true;
    this.error = '';
    const body = {
      name: this.taskName(),
      prompt: this.prompt.trim(),
      workingDir: this.folder.trim() || '~',
      command: this.options.command,
      agent: 'claude',
      notify: this.notify,
      ...(runAt ? { runAt: runAt.toISOString() } : {}),
    };
    try {
      if (this.editingId) {
        await this.api(`/api/tasks/${encodeURIComponent(this.editingId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        this.editingId = '';
        await this.loadTasks();
        this.tab = 'scheduled';
        return;
      }
      const { task } = await this.api<{ task: TaskRecord }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (task.sessionId && !runAt) {
        this.options.onStarted?.(task.sessionId);
        this.close();
        return;
      }
      await this.loadTasks();
      this.tab = 'scheduled';
    } catch (error) {
      this.error = `${t('tasks.failed')}: ${errorText(error)}`;
    } finally {
      this.busy = false;
    }
  }

  private async saveTemplate() {
    const name = this.taskName();
    if (!name || !this.prompt.trim()) return;
    try {
      if (this.isUserTemplate()) {
        await this.api(`/api/task-templates/${encodeURIComponent(this.templateId)}`, {
          method: 'PUT',
          body: JSON.stringify({ name, prompt: this.prompt }),
        });
      } else {
        const { template } = await this.api<{ template: TaskTemplate }>('/api/task-templates', {
          method: 'POST',
          body: JSON.stringify({ name, prompt: this.prompt }),
        });
        this.templateId = template.id;
      }
      await this.loadTemplates();
    } catch (error) {
      this.error = errorText(error);
    }
  }

  private async deleteTemplate() {
    const template = this.templates.find((tpl) => tpl.id === this.templateId);
    if (!template || !window.confirm(t('tasks.deleteTemplateConfirm', { name: template.name }))) {
      return;
    }
    try {
      await this.api(`/api/task-templates/${encodeURIComponent(template.id)}`, {
        method: 'DELETE',
      });
      this.templateId = '';
      await this.loadTemplates();
    } catch (error) {
      this.error = errorText(error);
    }
  }

  private async removeTask(task: TaskRecord) {
    if (
      task.state === 'scheduled' &&
      !window.confirm(t('tasks.cancelConfirm', { name: task.name }))
    ) {
      return;
    }
    try {
      await this.api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      await this.loadTasks();
    } catch (error) {
      this.error = errorText(error);
    }
  }

  private editTask(task: TaskRecord) {
    this.editingId = task.id;
    this.templateId = '';
    this.name = task.name;
    this.prompt = task.prompt;
    this.folder = task.workingDir;
    this.otherFolder = !this.options.folders.includes(task.workingDir);
    this.notify = task.notify;
    this.when = 'custom';
    this.customTime = toLocalInputValue(new Date(task.runAt));
    this.tab = 'new';
  }

  private formatTime(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private stateLabel(task: TaskRecord): string {
    switch (task.state) {
      case 'scheduled':
        return t('tasks.state.scheduled', { time: this.formatTime(task.runAt) });
      case 'failed':
        return t('tasks.state.failed', { error: taskErrorText(task.errorCode, task.error ?? '') });
      default:
        return t(`tasks.state.${task.state}` as MessageKey);
    }
  }

  private segment<T extends string>(
    label: string,
    value: T,
    options: Array<[T, string]>,
    set: (value: T) => void,
    testid: string
  ) {
    return html`<div class="task-row">
      <span class="task-label">${label}</span>
      <span class="task-seg" role="radiogroup" aria-label=${label} data-testid=${testid}>
        ${options.map(
          ([option, text]) => html`<button
            type="button"
            role="radio"
            aria-checked=${option === value ? 'true' : 'false'}
            class=${option === value ? 'selected' : ''}
            data-value=${option}
            @pointerup=${this.tap(() => set(option))}
            @click=${this.tap(() => set(option))}
          >${text}</button>`
        )}
      </span>
    </div>`;
  }

  private toggle(label: string, on: boolean, set: (on: boolean) => void, testid: string) {
    return html`<button
      type="button"
      role="switch"
      class="task-switch"
      aria-checked=${on ? 'true' : 'false'}
      data-testid=${testid}
      @pointerup=${this.tap(() => set(!on))}
      @click=${this.tap(() => set(!on))}
    >
      <span>${label}</span>
      <span class="task-knob ${on ? 'on' : ''}" aria-hidden="true"><span></span></span>
    </button>`;
  }

  private renderNew() {
    const folders = this.options.folders;
    const editing = this.tasks.find((task) => task.id === this.editingId);
    const primary = this.editingId
      ? t('tasks.saveChanges')
      : this.when === 'now'
        ? t('tasks.runNow')
        : t('tasks.schedule');
    return html`
      ${editing ? html`<div class="task-note">${t('tasks.editing', { name: editing.name })}</div>` : nothing}
      <div class="task-chips" role="listbox" aria-label=${t('tasks.template')} data-testid="task-templates">
        ${this.allTemplates().map(
          (template) => html`<button
            type="button"
            role="option"
            aria-selected=${template.id === this.templateId ? 'true' : 'false'}
            class="task-chip ${template.id === this.templateId ? 'selected' : ''}"
            data-id=${template.id}
            @pointerup=${this.tap(() => this.pickTemplate(template))}
            @click=${this.tap(() => this.pickTemplate(template))}
          >${template.name}</button>`
        )}
      </div>
      <input
        class="task-input"
        data-testid="task-name"
        aria-label=${t('tasks.name')}
        placeholder=${t('tasks.name')}
        maxlength="80"
        .value=${this.name}
        @input=${(e: Event) => {
          this.name = (e.target as HTMLInputElement).value;
        }}
      />
      <textarea
        class="task-input"
        rows="3"
        dir="auto"
        data-testid="task-prompt"
        aria-label=${t('tasks.prompt')}
        placeholder=${t('tasks.prompt')}
        .value=${this.prompt}
        @input=${(e: Event) => {
          this.prompt = (e.target as HTMLTextAreaElement).value;
        }}
      ></textarea>
      <div class="task-hint">${t('tasks.placeholdersHint')}</div>
      <div class="task-tpl-actions">
        ${
          this.prompt.trim()
            ? html`<button
                type="button"
                data-testid="task-save-template"
                @pointerup=${this.tap(() => void this.saveTemplate())}
                @click=${this.tap(() => void this.saveTemplate())}
              >${this.isUserTemplate() ? t('tasks.updateTemplate') : t('tasks.saveTemplate')}</button>`
            : nothing
        }
        ${
          this.isUserTemplate()
            ? html`<button
                type="button"
                class="destructive"
                data-testid="task-delete-template"
                @pointerup=${this.tap(() => void this.deleteTemplate())}
                @click=${this.tap(() => void this.deleteTemplate())}
              >${t('tasks.deleteTemplate')}</button>`
            : nothing
        }
      </div>
      <label class="task-row">
        <span class="task-label">${t('tasks.folder')}</span>
        <select
          class="task-input task-select"
          data-testid="task-folder"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            this.otherFolder = value === '__other__';
            if (!this.otherFolder) this.folder = value;
          }}
        >
          ${folders.map(
            (folder) =>
              html`<option value=${folder} ?selected=${!this.otherFolder && folder === this.folder}>${formatPathForDisplay(folder)}</option>`
          )}
          <option value="__other__" ?selected=${this.otherFolder}>${t('tasks.otherFolder')}</option>
        </select>
      </label>
      ${
        this.otherFolder
          ? html`<input
              class="task-input mono"
              data-testid="task-folder-other"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="~/Projects/app"
              .value=${folders.includes(this.folder) ? '' : this.folder}
              @input=${(e: Event) => {
                this.folder = (e.target as HTMLInputElement).value;
              }}
            />`
          : nothing
      }
      ${this.toggle(
        `🔔 ${t('tasks.notify')}`,
        this.notify,
        (on) => {
          this.notify = on;
        },
        'task-notify'
      )}
      ${this.notify ? html`<div class="task-hint">${t('tasks.notifyHint')}</div>` : nothing}
      ${this.segment<When>(
        t('tasks.when'),
        this.when,
        [
          ['now', t('tasks.whenNow')],
          ['tonight', t('tasks.whenTonight')],
          ['custom', t('tasks.whenCustom')],
        ],
        (when) => {
          this.when = when;
          if (when === 'custom' && !this.customTime) {
            this.customTime = toLocalInputValue(new Date(Date.now() + 60 * 60_000));
          }
        },
        'task-when'
      )}
      ${
        this.when === 'custom'
          ? html`<input
              type="datetime-local"
              class="task-input"
              data-testid="task-time"
              aria-label=${t('tasks.pickTime')}
              min=${toLocalInputValue(new Date())}
              .value=${this.customTime}
              @input=${(e: Event) => {
                this.customTime = (e.target as HTMLInputElement).value;
              }}
              @change=${(e: Event) => {
                this.customTime = (e.target as HTMLInputElement).value;
              }}
            />`
          : nothing
      }
      ${this.error ? html`<div class="task-error" role="alert">${this.error}</div>` : nothing}
      <button
        type="button"
        class="task-primary"
        data-testid="task-submit"
        ?disabled=${this.busy || !this.prompt.trim()}
        @pointerup=${this.tap(() => void this.submit())}
        @click=${this.tap(() => void this.submit())}
      >${primary}</button>
    `;
  }

  private renderScheduled() {
    const order = (task: TaskRecord) => (task.state === 'scheduled' ? 0 : 1);
    const tasks = [...this.tasks].sort(
      (a, b) =>
        order(a) - order(b) ||
        (order(a) === 0
          ? Date.parse(a.runAt) - Date.parse(b.runAt)
          : Date.parse(b.runAt) - Date.parse(a.runAt))
    );
    if (!tasks.length) return html`<div class="task-note">${t('tasks.noScheduled')}</div>`;
    return html`<ul class="task-list" data-testid="task-list">
      ${tasks.map(
        (task) => html`<li class="task-item" data-state=${task.state} data-id=${task.id}>
          <div class="task-item-main">
            <div class="task-item-name">${task.name}</div>
            <div class="task-item-meta"><bdi>${formatPathForDisplay(task.workingDir)}</bdi> · ${this.stateLabel(task)}</div>
          </div>
          <div class="task-item-actions">
            ${
              task.state === 'scheduled'
                ? html`<button
                    type="button"
                    data-action="edit"
                    @pointerup=${this.tap(() => this.editTask(task))}
                    @click=${this.tap(() => this.editTask(task))}
                  >${t('tasks.edit')}</button>`
                : task.sessionId
                  ? html`<button
                      type="button"
                      data-action="open"
                      @pointerup=${this.tap(() => {
                        this.options.onStarted?.(task.sessionId as string);
                        this.close();
                      })}
                      @click=${this.tap(() => {
                        this.options.onStarted?.(task.sessionId as string);
                        this.close();
                      })}
                    >${t('tasks.openSession')}</button>`
                  : nothing
            }
            <button
              type="button"
              class="destructive"
              data-action="remove"
              aria-label=${task.state === 'scheduled' ? t('tasks.cancelTask') : t('tasks.remove')}
              @pointerup=${this.tap(() => void this.removeTask(task))}
              @click=${this.tap(() => void this.removeTask(task))}
            >${task.state === 'scheduled' ? t('tasks.cancelTask') : t('tasks.remove')}</button>
          </div>
        </li>`
      )}
    </ul>`;
  }

  render() {
    const scheduledCount = this.tasks.filter((task) => task.state === 'scheduled').length;
    return html`
      <style>
        .task-sheet { position: fixed; left: max(8px, env(safe-area-inset-left, 0px));
          right: max(8px, env(safe-area-inset-right, 0px)); bottom: calc(8px + env(safe-area-inset-bottom, 0px));
          top: calc(24px + env(safe-area-inset-top, 0px)); max-width: 560px; margin: 0 auto; z-index: 2001;
          display: flex; flex-direction: column; border-radius: 16px; overflow: hidden;
          background: var(--color-bg-elevated); color: var(--color-text); border: 1px solid var(--color-border);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
          transform: translateY(110%); transition: transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1); }
        .task-sheet.open { transform: translateY(0); }
        .task-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px;
          border-bottom: 1px solid var(--color-border-light); }
        .task-tabs { display: flex; flex: 1; gap: 4px; }
        .task-tabs button, .task-close { padding: 8px 12px; border-radius: 10px; font-size: 15px;
          color: var(--color-text-dim); min-height: 40px; }
        .task-tabs button.selected { background: var(--color-bg-tertiary); color: var(--color-text); font-weight: 600; }
        .task-close { color: var(--color-primary-text); }
        .task-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px;
          display: flex; flex-direction: column; gap: 10px; }
        .task-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .task-chip { padding: 8px 12px; border-radius: 999px; font-size: 14px; min-height: 36px;
          background: var(--color-bg-tertiary); color: var(--color-text); border: 1px solid var(--color-border-light); }
        .task-chip.selected { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }
        .task-input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px;
          font-size: 16px; background: var(--color-bg); color: var(--color-text); border: 1px solid var(--color-border); }
        .task-input.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        textarea.task-input { resize: vertical; min-height: 84px; }
        .task-select { flex: 1; width: auto; min-width: 0; }
        .task-hint, .task-note { font-size: 13px; color: var(--color-text-dim); }
        .task-note { padding: 8px 0; }
        .task-tpl-actions { display: flex; gap: 12px; flex-wrap: wrap; }
        .task-tpl-actions button { font-size: 14px; color: var(--color-primary-text); padding: 4px 0; min-height: 32px; }
        .task-sheet .destructive { color: var(--color-status-error); }
        .task-row { display: flex; align-items: center; gap: 10px; }
        .task-label { flex: none; font-size: 14px; color: var(--color-text-dim); min-width: 64px; }
        .task-seg { display: flex; flex: 1; flex-wrap: wrap; gap: 4px; padding: 3px; border-radius: 10px;
          background: var(--color-bg-tertiary); }
        .task-seg button { flex: 1; padding: 8px 6px; border-radius: 8px; font-size: 14px; min-height: 36px;
          color: var(--color-text); white-space: nowrap; }
        .task-seg button.selected { background: var(--color-bg-elevated); font-weight: 600;
          box-shadow: 0 1px 3px rgb(0 0 0 / 0.2); }
        .task-switch { display: flex; align-items: center; justify-content: space-between; gap: 12px;
          width: 100%; padding: 8px 0; font-size: 15px; color: var(--color-text); text-align: start; min-height: 40px; }
        .task-knob { flex: none; width: 42px; height: 26px; border-radius: 13px; position: relative;
          background: var(--color-bg-tertiary); transition: background 0.15s; }
        .task-knob.on { background: var(--color-primary); }
        .task-knob span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%;
          background: white; transition: left 0.15s; }
        .task-knob.on span { left: 19px; }
        [dir='rtl'] .task-knob span { left: auto; right: 3px; }
        [dir='rtl'] .task-knob.on span { right: 19px; }
        .task-error { font-size: 14px; color: var(--color-status-error); }
        /* Pinned to the bottom of the scrolling form, with a band of the sheet's own colour
           around it: on a short phone screen it would sit below the form, out of sight. */
        .task-primary { padding: 14px; border-radius: 12px; font-size: 17px; font-weight: 600;
          background: var(--color-primary); color: #fff;
          position: sticky; bottom: 0; z-index: 1; flex-shrink: 0;
          box-shadow: 0 0 0 12px var(--color-bg-elevated); }
        /* Opaque when disabled: the form scrolls beneath it, and see-through it showed through. */
        .task-primary:disabled { background: color-mix(in srgb, var(--color-primary) 45%, var(--color-bg-elevated)); }
        .task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .task-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px;
          background: var(--color-bg-tertiary); }
        .task-item-main { flex: 1; min-width: 0; }
        .task-item-name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .task-item-meta { font-size: 13px; color: var(--color-text-dim); overflow-wrap: anywhere; }
        .task-item-actions { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
        .task-item-actions button { font-size: 14px; color: var(--color-primary-text); padding: 4px 2px; min-height: 32px; }
      </style>
      <div class="psr-sheet-backdrop" @click=${this.tap(this.close)}></div>
      <div class="task-sheet" role="dialog" aria-modal="true" aria-label=${t('tasks.title')} data-testid="task-sheet">
        <div class="task-head">
          <div class="task-tabs" role="tablist">
            <button
              role="tab"
              aria-selected=${this.tab === 'new' ? 'true' : 'false'}
              class=${this.tab === 'new' ? 'selected' : ''}
              data-testid="task-tab-new"
              @pointerup=${this.tap(() => {
                this.tab = 'new';
              })}
              @click=${this.tap(() => {
                this.tab = 'new';
              })}
            >${this.editingId ? t('tasks.edit') : t('tasks.tabNew')}</button>
            <button
              role="tab"
              aria-selected=${this.tab === 'scheduled' ? 'true' : 'false'}
              class=${this.tab === 'scheduled' ? 'selected' : ''}
              data-testid="task-tab-scheduled"
              @pointerup=${this.tap(() => {
                this.tab = 'scheduled';
                void this.loadTasks();
              })}
              @click=${this.tap(() => {
                this.tab = 'scheduled';
                void this.loadTasks();
              })}
            >${t('tasks.tabScheduled', { n: scheduledCount })}</button>
          </div>
          <button class="task-close" data-testid="task-close" @click=${this.close}>${t('common.close')}</button>
        </div>
        <div class="task-body">${this.tab === 'new' ? this.renderNew() : this.renderScheduled()}</div>
      </div>
    `;
  }
}

/** Open the tasks sheet in <body> (the phone sidebar's transform would trap position:fixed). */
export function openTaskSheet(options: TaskSheetOptions): TaskSheet {
  document.querySelector('task-sheet')?.remove();
  const sheet = document.createElement('task-sheet') as TaskSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'task-sheet': TaskSheet;
  }
}
