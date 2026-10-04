import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import type { BrowserSSHAgent } from '../services/ssh-agent.js';
import './modal-wrapper.js';

interface SSHKey {
  id: string;
  name: string;
  publicKey: string;
  algorithm: 'Ed25519';
  encrypted: boolean;
  fingerprint: string;
  createdAt: string;
}

@customElement('ssh-key-manager')
export class SSHKeyManager extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) sshAgent!: BrowserSSHAgent;
  @property({ type: Boolean }) visible = false;
  protected readonly i18n = new LocaleController(this);
  @state() private keys: SSHKey[] = [];
  @state() private loading = false;
  @state() private error = '';
  @state() private success = '';
  @state() private showAddForm = false;
  @state() private newKeyName = '';
  @state() private newKeyPassword = '';
  @state() private importKeyName = '';
  @state() private importKeyContent = '';
  @state() private showInstructions = false;
  @state() private instructionsKeyId = '';
  private documentKeyHandler = (e: KeyboardEvent) => this.handleDocumentKeyDown(e);

  connectedCallback() {
    super.connectedCallback();
    this.refreshKeys();
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    // Handle document keydown events when modal visibility changes
    if (changedProperties.has('visible')) {
      if (this.visible) {
        document.addEventListener('keydown', this.documentKeyHandler);
      } else {
        document.removeEventListener('keydown', this.documentKeyHandler);
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.documentKeyHandler);
  }

  private refreshKeys() {
    this.keys = this.sshAgent.listKeys() as SSHKey[];
  }

  private async handleGenerateKey() {
    if (!this.newKeyName.trim()) {
      this.error = t('ssh.error.nameRequired');
      return;
    }

    this.loading = true;
    this.error = '';

    try {
      const result = await this.sshAgent.generateKeyPair(
        this.newKeyName,
        this.newKeyPassword || undefined
      );

      // Automatically download the private key
      this.downloadPrivateKey(result.privateKeyPEM, this.newKeyName);

      this.success = t('ssh.generated', { name: this.newKeyName });
      this.newKeyName = '';
      this.newKeyPassword = '';
      this.showAddForm = false;
      this.showInstructions = true;
      this.instructionsKeyId = result.keyId;
      this.refreshKeys();
      console.log('Generated key ID:', result.keyId);
    } catch (error) {
      this.error = t('ssh.error.generate', { error: String(error) });
    } finally {
      this.loading = false;
    }
  }

  private downloadPrivateKey(privateKeyPEM: string, keyName: string) {
    const blob = new Blob([privateKeyPEM], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${keyName.replace(/\s+/g, '_')}_private.pem`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private async handleImportKey() {
    if (!this.importKeyName.trim() || !this.importKeyContent.trim()) {
      this.error = t('ssh.error.importRequired');
      return;
    }

    this.loading = true;
    this.error = '';

    try {
      const keyId = await this.sshAgent.addKey(this.importKeyName, this.importKeyContent);
      this.success = t('ssh.imported', { name: this.importKeyName });
      this.importKeyName = '';
      this.importKeyContent = '';
      this.showAddForm = false;
      this.refreshKeys();
      console.log('Imported key ID:', keyId);
    } catch (error) {
      this.error = t('ssh.error.import', { error: String(error) });
    } finally {
      this.loading = false;
    }
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private handleRemoveKey(keyId: string, keyName: string) {
    if (confirm(t('ssh.removeConfirm', { name: keyName }))) {
      this.sshAgent.removeKey(keyId);
      this.success = t('ssh.removed', { name: keyName });
      this.refreshKeys();
    }
  }

  /** Import hint with the two PEM headers rendered as code. */
  private renderImportHint() {
    const parts = t('ssh.importHint', { openssh: '\uE000', pkcs8: '\uE001' }).split(
      /(\uE000|\uE001)/
    );
    return parts.map((part) =>
      part === '\uE000'
        ? html`<code>BEGIN OPENSSH PRIVATE KEY</code>`
        : part === '\uE001'
          ? html`<code>BEGIN PRIVATE KEY</code>`
          : part
    );
  }

  private handleDownloadPublicKey(keyId: string, keyName: string) {
    const publicKey = this.sshAgent.getPublicKey(keyId);
    if (publicKey) {
      const blob = new Blob([publicKey], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${keyName.replace(/\s+/g, '_')}_public.pub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  private handleBackdropClick(e: Event) {
    if (e.target === e.currentTarget) {
      this.handleClose();
    }
  }

  private handleDocumentKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.visible) {
      e.preventDefault();
      this.handleClose();
    }
  }

  render() {
    if (!this.visible) return html``;

    return html`
      <div 
        class="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[1000]"
        @click=${this.handleBackdropClick}
      >
        <div
          class="bg-bg-secondary border border-border rounded-lg p-6 w-full max-w-[95vw] sm:max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl z-[1001]"
          role="dialog"
          aria-modal="true"
          aria-label=${t('ssh.title')}
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="relative mb-8">
            <h2 class="text-2xl font-mono text-primary text-center">🔑 ${t('ssh.title')}</h2>
            <button 
              @click=${this.handleClose} 
              class="absolute top-0 right-0 w-8 h-8 flex items-center justify-center text-text-muted hover:text-primary hover:bg-surface rounded transition-colors"
              title=${t('common.close')}
            >
              ✕
            </button>
          </div>

          ${
            this.error
              ? html`
                <div class="bg-status-error text-bg px-4 py-2 rounded mb-4 font-mono text-sm">
                  ${this.error}
                  <button
                    @click=${() => {
                      this.error = '';
                    }}
                    class="ml-2 text-bg hover:text-primary"
                    aria-label=${t('common.close')}
                  >
                    ✕
                  </button>
                </div>
              `
              : ''
          }
          ${
            this.success
              ? html`
                <div
                  class="bg-status-success text-bg px-4 py-2 rounded mb-4 font-mono text-sm"
                >
                  ${this.success}
                  <button
                    @click=${() => {
                      this.success = '';
                    }}
                    class="ml-2 text-bg hover:text-primary"
                    aria-label=${t('common.close')}
                  >
                    ✕
                  </button>
                </div>
              `
              : ''
          }

          <div class="mb-8">
            <div class="flex items-center justify-between mb-6 pb-3 border-b border-border">
              <h3 class="font-mono text-xl text-primary">${t('ssh.keys')}</h3>
              <button
                @click=${() => {
                  this.showAddForm = !this.showAddForm;
                }}
                class="btn-primary px-4 py-2 font-medium"
                ?disabled=${this.loading}
              >
                ${this.showAddForm ? `✕ ${t('common.cancel')}` : `+ ${t('ssh.addKey')}`}
              </button>
            </div>

            ${
              this.showAddForm
                ? html`
                  <div class="space-y-6 mb-8">
                    <!-- Generate New Key Section -->
                    <div class="bg-surface border border-border rounded-lg p-6">
                      <h4 class="text-primary font-mono text-lg mb-6 flex items-center gap-2 font-semibold">
                        🔑 ${t('ssh.generateTitle')}
                      </h4>

                      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div>
                          <label class="form-label"
                            >${t('ssh.keyName')} <span class="text-accent-red">*</span></label
                          >
                          <input
                            type="text"
                            class="input-field"
                            placeholder=${t('ssh.keyNamePlaceholder')}
                            .value=${this.newKeyName}
                            @input=${(e: Event) => {
                              this.newKeyName = (e.target as HTMLInputElement).value;
                            }}
                            ?disabled=${this.loading}
                          />
                        </div>
                        <div>
                          <label class="form-label">${t('ssh.algorithm')}</label>
                          <div
                            class="input-field bg-bg-secondary text-text-muted cursor-not-allowed"
                          >
                            Ed25519 (${t('ssh.recommended')})
                          </div>
                        </div>
                      </div>

                      <div class="mb-4">
                        <label class="form-label">${t('ssh.passwordOptional')}</label>
                        <input
                          type="password"
                          class="input-field"
                          placeholder=${t('ssh.passwordPlaceholder')}
                          .value=${this.newKeyPassword}
                          @input=${(e: Event) => {
                            this.newKeyPassword = (e.target as HTMLInputElement).value;
                          }}
                          ?disabled=${this.loading}
                        />
                        <p class="text-text-muted text-xs mt-1">
                          💡 ${t('ssh.passwordHint')}
                        </p>
                      </div>
                      <button
                        @click=${this.handleGenerateKey}
                        class="btn-primary"
                        ?disabled=${this.loading || !this.newKeyName.trim()}
                      >
                        ${this.loading ? t('ssh.generating') : t('ssh.generate')}
                      </button>
                    </div>

                    <!-- Import Existing Key Section -->
                    <div class="bg-surface border border-border rounded-lg p-6">
                      <h4 class="text-primary font-mono text-lg mb-6 flex items-center gap-2 font-semibold">
                        📁 ${t('ssh.importTitle')}
                      </h4>

                      <div class="mb-4">
                        <label class="form-label"
                          >${t('ssh.keyName')} <span class="text-accent-red">*</span></label
                        >
                        <input
                          type="text"
                          class="input-field"
                          placeholder=${t('ssh.importNamePlaceholder')}
                          .value=${this.importKeyName}
                          @input=${(e: Event) => {
                            this.importKeyName = (e.target as HTMLInputElement).value;
                          }}
                          ?disabled=${this.loading}
                        />
                      </div>

                      <div class="mb-4">
                        <label class="form-label"
                          >${t('ssh.privateKey')} <span class="text-accent-red">*</span></label
                        >
                        <textarea
                          class="input-field"
                          rows="6"
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----&#10;&#10;or&#10;&#10;-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                          .value=${this.importKeyContent}
                          @input=${(e: Event) => {
                            this.importKeyContent = (e.target as HTMLTextAreaElement).value;
                          }}
                          ?disabled=${this.loading}
                        ></textarea>
                        <p class="text-text-muted text-xs mt-1">
                          💡 ${this.renderImportHint()}
                        </p>
                      </div>

                      <button
                        @click=${this.handleImportKey}
                        class="btn-secondary"
                        ?disabled=${
                          this.loading ||
                          !this.importKeyName.trim() ||
                          !this.importKeyContent.trim()
                        }
                      >
                        ${this.loading ? t('ssh.importing') : t('ssh.import')}
                      </button>
                    </div>
                  </div>
                `
                : ''
            }
          </div>

          <!-- Instructions for new key -->
          ${
            this.showInstructions && this.instructionsKeyId
              ? html`
                <div class="bg-surface border border-border rounded-lg p-6 mb-8">
                  <div class="flex items-center justify-between mb-6">
                    <h4 class="text-primary font-mono text-lg font-semibold flex items-center gap-2">
                      📋 ${t('ssh.setupTitle')}
                    </h4>
                    <button
                      @click=${() => {
                        this.showInstructions = false;
                      }}
                      class="w-8 h-8 flex items-center justify-center text-text-muted hover:text-primary hover:bg-bg rounded transition-colors"
                      title=${t('ssh.closeInstructions')}
                    >
                      ✕
                    </button>
                  </div>
                  <div class="space-y-6">
                    <div class="bg-bg border border-border rounded-lg p-4">
                      <p class="text-text-muted text-sm mb-3 font-medium">
                        ${t('ssh.step1')}
                      </p>
                      <div class="relative">
                        <pre
                          class="bg-secondary p-3 rounded-lg text-xs overflow-x-auto text-primary pr-20 font-mono"
                        >
echo "${this.sshAgent.getPublicKey(this.instructionsKeyId)}" >> ~/.ssh/authorized_keys</pre
                        >
                        <button
                          @click=${async () => {
                            const publicKey = this.sshAgent.getPublicKey(this.instructionsKeyId);
                            const command = `echo "${publicKey}" >> ~/.ssh/authorized_keys`;
                            await navigator.clipboard.writeText(command);
                            this.success = t('ssh.commandCopied');
                          }}
                          class="absolute top-2 right-2 btn-ghost text-xs"
                          title=${t('ssh.copyCommand')}
                        >
                          📋
                        </button>
                      </div>
                    </div>
                    <div class="bg-bg border border-border rounded-lg p-4">
                      <p class="text-text-muted text-sm mb-3 font-medium">${t('ssh.step2')}</p>
                      <div class="relative">
                        <pre
                          class="bg-secondary p-3 rounded-lg text-xs overflow-x-auto text-primary pr-20 font-mono"
                        >
${this.sshAgent.getPublicKey(this.instructionsKeyId)}</pre
                        >
                        <button
                          @click=${async () => {
                            const publicKey = this.sshAgent.getPublicKey(this.instructionsKeyId);
                            if (publicKey) {
                              await navigator.clipboard.writeText(publicKey);
                              this.success = t('ssh.publicKeyCopied');
                            }
                          }}
                          class="absolute top-2 right-2 btn-ghost text-xs"
                          title=${t('ssh.copyToClipboard')}
                        >
                          📋 ${t('ssh.copy')}
                        </button>
                      </div>
                    </div>
                    <div class="bg-status-info/10 border border-status-info/30 rounded-lg p-3">
                      <p class="text-status-info text-sm font-mono flex items-center gap-2">
                        💡 <strong>${t('ssh.tip')}</strong> ${t('ssh.tipText')}
                      </p>
                    </div>
                  </div>
                </div>
              `
              : ''
          }

          <!-- Keys List -->
          <div class="space-y-4">
            ${
              this.keys.length === 0
                ? html`
                  <div class="text-center py-12 text-text-muted border border-border rounded-lg bg-surface">
                    <div class="text-4xl mb-4">🔑</div>
                    <p class="font-mono text-lg mb-2 text-primary">${t('ssh.empty')}</p>
                    <p class="text-sm">${t('ssh.emptyHint')}</p>
                  </div>
                `
                : this.keys.map(
                    (key) => html`
                    <div class="ssh-key-item border border-border rounded-lg p-4 bg-surface hover:bg-bg transition-colors">
                      <div class="flex items-start justify-between">
                        <div class="flex-1">
                          <div class="flex items-center gap-2 mb-2">
                            <h4 class="font-mono font-semibold text-primary">${key.name}</h4>
                            <span class="badge badge-ed25519">${key.algorithm}</span>
                            ${
                              key.encrypted
                                ? html`<span class="badge badge-encrypted">🔒 ${t('ssh.encrypted')}</span>`
                                : ''
                            }
                          </div>
                          <div class="text-sm text-text-muted font-mono space-y-1">
                            <div>ID: ${key.id}</div>
                            <div>${t('ssh.fingerprint', { value: key.fingerprint })}</div>
                            <div>${t('ssh.created', { date: new Date(key.createdAt).toLocaleString() })}</div>
                          </div>
                        </div>
                        <div class="flex gap-2">
                          <button
                            @click=${() => this.handleDownloadPublicKey(key.id, key.name)}
                            class="btn-ghost text-xs"
                            title=${t('ssh.downloadPublic')}
                          >
                            📥 ${t('ssh.public')}
                          </button>
                          <button
                            @click=${() => this.handleRemoveKey(key.id, key.name)}
                            class="btn-ghost text-xs text-status-error hover:bg-status-error hover:text-bg"
                            title=${t('ssh.removeKey')}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    </div>
                  `
                  )
            }
          </div>
        </div>
      </div>
    `;
  }
}
