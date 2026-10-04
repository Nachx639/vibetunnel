/**
 * Voice mode: a full-screen sheet over Claude's chat for talking hands-free.
 * It listens until you pause, sends what you said, reads Claude's answer aloud with the
 * server's voice and listens again. Speaking over the answer (or Interrupt) cuts it off;
 * a permission prompt is announced and the loop stops (it's never answered by voice).
 *
 * Open it with `openVoiceMode()` from inside the tap: iOS only allows the microphone and
 * audio playback to start from a user gesture.
 */
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { detectSpeechLanguage, normalizeSpeechLanguage } from '../../shared/tts-text.js';
import { getLocale, LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';
import {
  ReplyWatcher,
  ScreenAwake,
  transcribeUtterance,
  VoiceCapture,
  VoicePlayer,
} from '../utils/voice-io.js';
import { plainForSpeech, VoiceLoop, type VoicePhase } from '../utils/voice-loop.js';

const logger = createLogger('voice-mode');

const PHASE_TEXT: Record<VoicePhase, MessageKey> = {
  idle: 'voice.starting',
  listening: 'voice.listening',
  transcribing: 'voice.transcribing',
  thinking: 'voice.thinking',
  speaking: 'voice.speaking',
  permission: 'voice.permission',
  error: 'voice.error',
  ended: 'voice.ended',
};

const MIC_ICON = html`<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0" /><path d="M12 18v3" /></svg>`;
const SPEAKER_ICON = html`<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 010 7" /><path d="M18.5 5.5a9 9 0 010 13" /></svg>`;
const DOTS_ICON = html`<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>`;
const ALERT_ICON = html`<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19L12 3z" /><path d="M12 10v4" /><path d="M12 17.5v.01" /></svg>`;

/** Act on pointerup (a first tap on iOS can be eaten as hover) and keyboard clicks. */
function onTap(action: () => void) {
  return {
    pointerup: (e: PointerEvent) => {
      if (e.button !== 0) return;
      // A drag that started on the button ends here too: not a tap.
      if (endsADrag(e)) return;
      e.preventDefault();
      swallowNextClick();
      action();
    },
    click: (e: MouseEvent) => {
      if (e.detail === 0) action(); // Enter/Space; real taps were handled on pointerup
    },
  };
}

@customElement('claude-voice-mode')
export class ClaudeVoiceMode extends LitElement {
  static styles = [
    reducedMotionStyles,
    css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      background: var(--color-bg, #0b0b0f);
      color: var(--color-text, #e8e8ea);
      font-family: inherit;
      padding: env(safe-area-inset-top, 0) env(safe-area-inset-right, 0)
        env(safe-area-inset-bottom, 0) env(safe-area-inset-left, 0);
      -webkit-user-select: none;
      user-select: none;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      font-weight: 600;
      font-size: 16px;
    }
    .engine {
      font-size: 12px;
      font-weight: 400;
      color: var(--color-text-muted, #9a9aa2);
    }
    main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 8px 20px;
    }
    .orb {
      margin-top: 4vh;
      width: 148px;
      height: 148px;
      border-radius: 50%;
      border: none;
      display: grid;
      place-items: center;
      color: var(--color-bg, #0b0b0f);
      background: var(--color-primary, #6aa8ff);
      box-shadow: 0 0 0 calc(var(--level, 0) * 28px)
        color-mix(in srgb, var(--color-primary, #6aa8ff) 30%, transparent);
      transition:
        box-shadow 90ms linear,
        background 200ms ease;
      touch-action: manipulation;
      cursor: pointer;
      flex-shrink: 0;
    }
    .orb[data-phase='transcribing'],
    .orb[data-phase='thinking'] {
      background: var(--color-bg-elevated, #1c1c22);
      color: var(--color-primary-text, var(--color-primary, #6aa8ff));
      border: 2px solid var(--color-border, #333);
    }
    .orb[data-phase='speaking'] {
      background: var(--color-status-success, #3fb950);
      animation: pulse 1.4s ease-in-out infinite;
    }
    .orb[data-phase='permission'],
    .orb[data-phase='error'] {
      background: var(--color-status-warning, #d29922);
    }
    .orb[data-phase='ended'],
    .orb[data-phase='idle'] {
      background: var(--color-bg-tertiary, #2a2a31);
      color: var(--color-text-muted, #9a9aa2);
    }
    @keyframes pulse {
      50% {
        transform: scale(1.06);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .orb,
      .dots span {
        animation: none !important;
      }
    }
    .dots {
      display: flex;
      gap: 8px;
    }
    .dots span {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: currentColor;
      animation: blink 1.2s infinite ease-in-out;
    }
    .dots span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .dots span:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes blink {
      0%,
      80%,
      100% {
        opacity: 0.25;
      }
      40% {
        opacity: 1;
      }
    }
    .phase {
      font-size: 22px;
      font-weight: 600;
      text-align: center;
    }
    .hint {
      font-size: 14px;
      color: var(--color-text-muted, #9a9aa2);
      text-align: center;
      max-width: 32ch;
    }
    .transcript {
      width: 100%;
      max-width: 560px;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      -webkit-user-select: text;
      user-select: text;
    }
    .line {
      padding: 10px 12px;
      border-radius: 12px;
      background: var(--color-bg-elevated, #1c1c22);
      border: 1px solid var(--color-border-light, #2a2a31);
      font-size: 15px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .who {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--color-text-muted, #9a9aa2);
      margin-bottom: 2px;
    }
    footer {
      display: flex;
      gap: 12px;
      padding: 12px 16px 16px;
    }
    footer button {
      flex: 1;
      min-height: 52px;
      border-radius: 14px;
      font-size: 17px;
      font-weight: 600;
      border: 1px solid var(--color-border, #333);
      background: var(--color-bg-elevated, #1c1c22);
      color: var(--color-text, #e8e8ea);
      touch-action: manipulation;
      cursor: pointer;
    }
    footer button.primary {
      background: var(--color-primary, #6aa8ff);
      border-color: transparent;
      color: var(--color-bg, #0b0b0f);
    }
    footer button.danger {
      color: var(--color-status-error-text, var(--color-status-error, #f85149));
    }
    button:focus-visible {
      outline: 2px solid var(--color-focus-ring, var(--color-primary, #6aa8ff));
      outline-offset: 2px;
    }
  `,
  ];

  @property({ type: String }) sessionId = '';

  @state() private phase: VoicePhase = 'idle';
  @state() private heard = '';
  @state() private reply = '';
  @state() private problem: MessageKey | null = null;
  @state() private engine = '';
  protected readonly i18n = new LocaleController(this);

  private readonly capture = new VoiceCapture();
  private readonly player = new VoicePlayer(() => authClient.getAuthHeader());
  private readonly awake = new ScreenAwake();
  private loop: VoiceLoop | null = null;
  private micReady: Promise<void> | null = null;
  private level = 0;
  private levelFrame = 0;

  /** Must run synchronously inside the opening tap (mic + audio unlock on iOS). */
  begin(): void {
    this.player.unlock();
    this.micReady = this.capture.open();
    this.capture.onLevel = (level) => {
      this.level = Math.max(level, this.level * 0.8);
      if (!this.levelFrame) {
        this.levelFrame = requestAnimationFrame(() => {
          this.levelFrame = 0;
          this.style.setProperty(
            '--level',
            this.phase === 'listening' ? this.level.toFixed(2) : '0'
          );
        });
      }
    };
    void this.awake.acquire();
    void this.warmUp();
    void this.run();
  }

  private async warmUp() {
    try {
      // Warmed for the UI language only: the first answer in it doesn't wait for the model.
      const lang = encodeURIComponent(getLocale());
      const response = await fetch(`/api/tts/status?warm=1&lang=${lang}`, {
        headers: authClient.getAuthHeader(),
      });
      const status = (await response.json()) as { engine?: string | null };
      this.engine = status.engine ?? '';
    } catch {
      // The reply still reads with the browser's own voice.
    }
  }

  private async run() {
    try {
      await this.micReady;
    } catch (error) {
      const name = (error as { name?: string })?.name;
      logger.warn(`microphone refused: ${name}`);
      this.problem = name === 'NotFoundError' ? 'voice.error.noMic' : 'voice.error.mic';
      this.phase = 'error';
      return;
    }
    if (!this.isConnected) return;
    this.startLoop();
  }

  private startLoop() {
    this.problem = null;
    const watcher = new ReplyWatcher(this.sessionId, () => authClient.getAuthHeader());
    this.loop ??= new VoiceLoop(
      {
        listen: (signal) => {
          this.capture.setBargeIn(false);
          this.capture.onSpeechStart = null;
          return this.capture.next(signal);
        },
        transcribe: (audio, signal) =>
          transcribeUtterance(audio, authClient.getAuthHeader(), signal),
        mark: (signal) => watcher.mark(signal),
        send: (text) => this.send(text),
        waitForReply: (signal) => watcher.wait(signal),
        speak: (text, signal) => this.speak(text, signal),
        permissionText: () => t('voice.permission'),
      },
      {
        onPhase: (phase) => {
          this.phase = phase;
          if (phase === 'error') this.problem ??= 'voice.error.network';
        },
        onHeard: (text) => {
          this.heard = text;
          this.reply = '';
        },
        onReply: (text) => {
          this.reply = text;
        },
        onError: (error) => logger.warn('voice loop step failed', error),
      }
    );
    void this.loop.start();
  }

  /** Types the words into Claude Code and presses Enter (like the chat composer). */
  private send(text: string): Promise<void> {
    const input = (detail: string) =>
      this.dispatchEvent(
        new CustomEvent('claude-chat-input', { detail, bubbles: true, composed: true })
      );
    input(text);
    return new Promise((resolve) =>
      setTimeout(() => {
        input('\r');
        resolve();
      }, 50)
    );
  }

  private languageHint(): string {
    const phone = normalizeSpeechLanguage(navigator.language) ?? 'en';
    return this.heard ? detectSpeechLanguage(this.heard, phone) : phone;
  }

  private async speak(text: string, signal: AbortSignal) {
    const plain = plainForSpeech(text, t('voice.codeOmitted'));
    // While it talks, only clear, sustained speech interrupts it (not its own echo).
    this.capture.setBargeIn(true);
    this.capture.onSpeechStart = () => {
      logger.log('barge-in');
      this.loop?.interrupt();
    };
    try {
      await this.player.speak(plain, this.languageHint(), signal);
    } catch (error) {
      if (signal.aborted) return;
      logger.warn('server voice failed, using the browser voice', error);
      await this.speakOnPhone(plain, signal);
    } finally {
      this.capture.onSpeechStart = null;
      this.capture.setBargeIn(false);
    }
  }

  private speakOnPhone(text: string, signal: AbortSignal): Promise<void> {
    if (typeof window.speechSynthesis === 'undefined') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.languageHint();
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      signal.addEventListener(
        'abort',
        () => {
          window.speechSynthesis.cancel();
          resolve();
        },
        { once: true }
      );
      window.speechSynthesis.speak(utterance);
    });
  }

  private interrupt = () => {
    this.loop?.interrupt();
  };

  private resume = () => {
    if (this.phase === 'error' && !this.loop) {
      // The microphone never opened: try again from this tap.
      this.micReady = this.capture.open();
      void this.run();
      return;
    }
    this.startLoop();
  };

  private finish = () => {
    this.loop?.end();
    this.cleanup();
    this.remove();
    this.dispatchEvent(new CustomEvent('voice-mode-closed', { bubbles: true, composed: true }));
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.finish();
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.onKeyDown);
    this.loop?.end();
    this.cleanup();
  }

  private cleanup() {
    this.capture.close();
    this.player.stop();
    this.awake.release();
    if (this.levelFrame) cancelAnimationFrame(this.levelFrame);
    this.levelFrame = 0;
  }

  firstUpdated() {
    this.renderRoot.querySelector<HTMLElement>('.orb')?.focus({ preventScroll: true });
  }

  private renderOrbIcon() {
    switch (this.phase) {
      case 'speaking':
        return SPEAKER_ICON;
      case 'transcribing':
      case 'thinking':
        return DOTS_ICON;
      case 'permission':
      case 'error':
        return ALERT_ICON;
      default:
        return MIC_ICON;
    }
  }

  private renderFooter() {
    const end = onTap(this.finish);
    const endButton = html`<button class="danger" @pointerup=${end.pointerup} @click=${end.click}>
      ${t('voice.end')}
    </button>`;
    if (this.phase === 'speaking') {
      const stop = onTap(this.interrupt);
      return html`<button class="primary" @pointerup=${stop.pointerup} @click=${stop.click}>
          ${t('voice.interrupt')}</button
        >${endButton}`;
    }
    if (this.phase === 'permission' || this.phase === 'error') {
      const again = onTap(this.resume);
      return html`<button class="primary" @pointerup=${again.pointerup} @click=${again.click}>
          ${t('voice.resume')}</button
        >${endButton}`;
    }
    return endButton;
  }

  render() {
    const orb = onTap(() => {
      if (this.phase === 'speaking') this.interrupt();
    });
    const hint =
      this.problem && this.phase === 'error'
        ? t(this.problem)
        : this.phase === 'permission'
          ? t('voice.permissionHint')
          : this.phase === 'listening' && !this.heard
            ? t('voice.hint')
            : this.phase === 'speaking'
              ? t('voice.interruptHint')
              : '';
    return html`
      <header>
        <span>${t('voice.title')}</span>
        ${this.engine ? html`<span class="engine">${t('voice.engine', { engine: this.engine })}</span>` : nothing}
      </header>
      <main role="dialog" aria-modal="true" aria-label=${t('voice.title')}>
        <button
          class="orb"
          data-phase=${this.phase}
          aria-label=${this.phase === 'speaking' ? t('voice.interrupt') : t(PHASE_TEXT[this.phase])}
          @pointerup=${orb.pointerup}
          @click=${orb.click}
        >
          ${this.renderOrbIcon()}
        </button>
        <div class="phase" role="status" aria-live="polite">${t(PHASE_TEXT[this.phase])}</div>
        ${hint ? html`<div class="hint">${hint}</div>` : nothing}
        <div class="transcript">
          ${this.heard ? html`<div class="line"><span class="who">${t('voice.you')}</span>${this.heard}</div>` : nothing}
          ${this.reply ? html`<div class="line"><span class="who">Claude</span>${this.reply}</div>` : nothing}
        </div>
      </main>
      <footer>${this.renderFooter()}</footer>
    `;
  }
}

/**
 * Open voice mode over `parent` (the chat view's shadow root) for `sessionId`. Call it
 * synchronously from the tap. Its input events bubble out like the chat's own.
 */
export function openVoiceMode(parent: Node, sessionId: string): ClaudeVoiceMode {
  const existing = (parent as ParentNode).querySelector?.('claude-voice-mode');
  if (existing) return existing as ClaudeVoiceMode;
  const sheet = document.createElement('claude-voice-mode');
  sheet.sessionId = sessionId;
  parent.appendChild(sheet);
  sheet.begin();
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-voice-mode': ClaudeVoiceMode;
  }
}

/** Handlers for the chat's Voice mode button: opens voice mode within the tap itself. */
export function voiceModeTap(parent: () => Node, sessionId: () => string) {
  return onTap(() => {
    openVoiceMode(parent(), sessionId());
  });
}
