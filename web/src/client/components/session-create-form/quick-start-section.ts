/**
 * Quick Start Section Component
 *
 * Displays quick start command buttons and manages editing mode
 * for customizing quick start commands. A quick start whose program is not installed is
 * dimmed, "Not installed"; tapping it says so instead of selecting it.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { quickStartProgram } from '../../../shared/quick-start.js';
import type { QuickStartCommand } from '../../../types/config.js';
import { LocaleController, t } from '../../i18n/index.js';
import {
  isQuickStartAvailable,
  type QuickStartAvailability,
} from '../../services/quick-start-availability.js';
import { announce } from '../../utils/announce.js';
import '../quick-start-editor.js';

export interface QuickStartItem {
  label: string;
  command: string;
}

@customElement('quick-start-section')
export class QuickStartSection extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) commands: QuickStartItem[] = [];
  @property({ type: String }) selectedCommand = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) isCreating = false;
  /** Programs known to be missing on the server ({ gemini: false }); {} while unknown. */
  @property({ type: Object }) availability: QuickStartAvailability = {};

  @state() private editMode = false;
  /** The missing program last tapped, explained under the buttons. */
  @state() private unavailableProgram = '';
  protected readonly i18n = new LocaleController(this);

  private handleQuickStartClick(command: string) {
    if (!isQuickStartAvailable(this.availability, command)) {
      this.unavailableProgram = quickStartProgram(command);
      announce(t('quickStart.notInstalledOnServer', { name: this.unavailableProgram }));
      return;
    }
    this.unavailableProgram = '';
    this.dispatchEvent(
      new CustomEvent('quick-start-selected', {
        detail: { command },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleQuickStartChanged(e: CustomEvent<QuickStartCommand[]>) {
    this.dispatchEvent(
      new CustomEvent('quick-start-changed', {
        detail: e.detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleEditingChanged(e: CustomEvent) {
    this.editMode = e.detail.editing;
  }

  render() {
    return html`
      <div class="${this.editMode ? 'mt-3 sm:mt-4 mb-3 sm:mb-4' : 'mb-3 sm:mb-4'}">
        ${
          this.editMode
            ? html`
            <!-- Full width editor when in edit mode -->
            <div class="-mx-3 sm:-mx-4 lg:-mx-6">
              <quick-start-editor
                .commands=${this.commands.map((cmd) => ({
                  name: cmd.label === cmd.command ? undefined : cmd.label,
                  command: cmd.command,
                }))}
                .editing=${true}
                @quick-start-changed=${this.handleQuickStartChanged}
                @editing-changed=${this.handleEditingChanged}
              ></quick-start-editor>
            </div>
          `
            : html`
            <!-- Normal mode with Edit button -->
            <div class="flex items-center justify-between mb-1 sm:mb-2 mt-3 sm:mt-4">
              <label class="form-label text-text-muted uppercase text-[9px] sm:text-[10px] lg:text-xs tracking-wider">
                ${t('create.quickStart')}
              </label>
              <quick-start-editor
                .commands=${this.commands.map((cmd) => ({
                  name: cmd.label === cmd.command ? undefined : cmd.label,
                  command: cmd.command,
                }))}
                .editing=${false}
                @quick-start-changed=${this.handleQuickStartChanged}
                @editing-changed=${this.handleEditingChanged}
              ></quick-start-editor>
            </div>
          `
        }
        ${
          !this.editMode
            ? html`
            <div class="grid grid-cols-2 gap-2 sm:gap-2.5 lg:gap-3 mt-1.5 sm:mt-2">
              ${this.commands.map(({ label, command }) => {
                const available = isQuickStartAvailable(this.availability, command);
                return html`
                  <button
                    @click=${() => this.handleQuickStartClick(command)}
                    class="${
                      this.selectedCommand === command
                        ? 'px-2 py-1.5 sm:px-3 sm:py-2 lg:px-4 lg:py-3 rounded-lg border text-left transition-all bg-primary/10 border-primary/50 text-primary hover:bg-primary/20 font-medium text-[10px] sm:text-xs lg:text-sm'
                        : 'px-2 py-1.5 sm:px-3 sm:py-2 lg:px-4 lg:py-3 rounded-lg border text-left transition-all bg-bg-elevated border-border/50 text-text hover:bg-hover hover:border-primary/50 hover:text-primary text-[10px] sm:text-xs lg:text-sm'
                    }${available ? '' : ' opacity-50'}"
                    ?disabled=${this.disabled || this.isCreating}
                    aria-disabled=${available ? nothing : 'true'}
                    type="button"
                  >
                    ${label}
                    ${
                      available
                        ? nothing
                        : html`<span class="block text-[9px] sm:text-[10px] lg:text-xs font-normal text-text-muted">
                            ${t('quickStart.notInstalled')}
                          </span>`
                    }
                  </button>
                `;
              })}
            </div>
            ${
              this.unavailableProgram
                ? html`<p
                    id="quick-start-unavailable-notice"
                    class="mt-1.5 sm:mt-2 text-[10px] sm:text-xs text-status-warning"
                  >
                    ${t('quickStart.notInstalledOnServer', { name: this.unavailableProgram })}
                  </p>`
                : nothing
            }
          `
            : ''
        }
      </div>
    `;
  }
}
