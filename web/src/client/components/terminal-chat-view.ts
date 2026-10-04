import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import {
  compactDetail,
  optionForTyped,
  parseScreenChoices,
  type ScreenChoices,
  type ScreenLayout,
  sameShownMenu,
  takesReply,
} from '../../shared/claude-screen.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { composerHeightFor } from '../utils/composer-height.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { endsADrag } from '../utils/pointer-drag.js';
import {
  defaultQuickPrompts,
  loadCustomQuickPrompts,
  type QuickPrompt,
  saveQuickPrompts,
  templateText,
} from '../utils/quick-prompts.js';
import { shellQuotePath } from '../utils/shell-quote.js';
import { AttachmentQueue, type AttachmentUploader, uploadAttachment } from './chat-attachments.js';
import type { SentChatMessage, SentChatMessageRef } from './claude-chat-view.js';

/** How often the phone composer looks for a menu on screen. */
const SCREEN_MENU_POLL_MS = 700;

const logger = createLogger('terminal-chat-view');

/** How long after the last hand-written key the composer leaves typing to iOS again. */
const HAND_TYPING_MS = 2000;

/** Claude Code slash commands offered while typing "/" in the phone composer. */
const SLASH_COMMANDS: Array<[string, MessageKey]> = [
  ['/clear', 'slash.clear'],
  ['/compact', 'slash.compact'],
  ['/model', 'slash.model'],
  ['/resume', 'slash.resume'],
  ['/context', 'slash.context'],
  ['/cost', 'slash.cost'],
  ['/usage', 'slash.usage'],
  ['/rewind', 'slash.rewind'],
  ['/review', 'slash.review'],
  ['/init', 'slash.init'],
  ['/memory', 'slash.memory'],
  ['/agents', 'slash.agents'],
  ['/mcp', 'slash.mcp'],
  ['/permissions', 'slash.permissions'],
  ['/config', 'slash.config'],
  ['/status', 'slash.status'],
  ['/export', 'slash.export'],
  ['/help', 'slash.help'],
];

/** OpenAI Codex slash commands, offered instead when the session runs Codex. */
const CODEX_SLASH_COMMANDS: Array<[string, MessageKey]> = [
  ['/new', 'slash.clear'],
  ['/compact', 'slash.compact'],
  ['/model', 'slash.model'],
  ['/approvals', 'codex.slash.approvals'],
  ['/review', 'codex.slash.review'],
  ['/diff', 'codex.slash.diff'],
  ['/resume', 'slash.resume'],
  ['/status', 'slash.status'],
  ['/init', 'codex.slash.init'],
  ['/mcp', 'slash.mcp'],
];

/** Gemini CLI slash commands, offered instead when the session runs Gemini. */
const GEMINI_SLASH_COMMANDS: Array<[string, MessageKey]> = [
  ['/clear', 'slash.clear'],
  ['/compress', 'slash.compact'],
  ['/model', 'slash.model'],
  ['/chat', 'gemini.slash.chat'],
  ['/resume', 'slash.resume'],
  ['/memory', 'gemini.slash.memory'],
  ['/stats', 'gemini.slash.stats'],
  ['/tools', 'gemini.slash.tools'],
  ['/mcp', 'slash.mcp'],
  ['/settings', 'gemini.slash.settings'],
  ['/init', 'gemini.slash.init'],
  ['/help', 'slash.help'],
  ['/quit', 'gemini.slash.quit'],
];

/** The slash commands to offer for the agent a session runs. */
export function slashCommandsFor(agent: string | undefined): Array<[string, MessageKey]> {
  if (agent === 'codex') return CODEX_SLASH_COMMANDS;
  if (agent === 'gemini') return GEMINI_SLASH_COMMANDS;
  return SLASH_COMMANDS;
}

const DRAFT_KEY_PREFIX = 'vt-chat-draft:';

function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY_PREFIX + sessionId) ?? '';
  } catch {
    return '';
  }
}

/** Composer drafts survive a session switch or a reload (storage may be blocked: then not). */
function saveDraft(sessionId: string, text: string) {
  if (!sessionId) return;
  try {
    if (text.trim()) localStorage.setItem(DRAFT_KEY_PREFIX + sessionId, text);
    else localStorage.removeItem(DRAFT_KEY_PREFIX + sessionId);
  } catch {
    // Private mode or storage full: the draft just isn't kept.
  }
}

export { composerHeightFor };

const MAX_MESSAGE_LENGTH = 20_000;

/** A message on its way from the phone composer (see send). */
interface Outgoing {
  command: string;
  /** Uploaded images' paths, shell-quoted: typed before the text, in a write of their own. */
  paths: string;
  /** performance.now() when the send began, for the chat view's timing line. */
  startedAt: number;
  /** Its bubble in the chat view: new, or the one of a message that could not be sent. */
  id?: string;
  /** The chat view has been told this attempt is on its way. */
  announced?: boolean;
  /** A retry from the chat view: the box is not where it comes from. */
  retry?: boolean;
}

let sentCount = 0;

interface ChatMessage {
  type: 'command' | 'output' | 'error' | 'prompt';
  content: string;
  timestamp: Date;
  id: string;
}

interface InteractiveOption {
  label: string;
  response: string;
}

@customElement('terminal-chat-view')
export class TerminalChatView extends LitElement {
  static styles = css`
    :host([composerOnly]) {
      height: auto;
    }

    :host([composerOnly]) .chat-input-container {
      align-items: flex-end;
      /* Home indicator clearance, set by the session view only while the keyboard is down
         (with the keyboard up the composer sits on it; both would leave a gap). */
      padding-bottom: calc(0.625rem + var(--composer-safe-bottom, 0px));
    }

    :host {
      display: block;
      height: 100%;
      width: 100%;
      background-color: var(--color-bg);
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
      position: relative;
      z-index: 10;
      pointer-events: auto !important; /* Ensure interactions work */
    }

    .chat-view-container {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .chat-messages-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 1rem;
      /* Large top padding to ensure first message clears the header on iPad */
      padding-top: 8rem;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch; /* Smooth scrolling on iOS */
      touch-action: pan-y; /* Allow vertical scrolling */
      overscroll-behavior: contain; /* Prevent scroll chaining */
    }

    /* Chat input container (WhatsApp style) */
    .chat-input-container {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.625rem 0.875rem;
      background-color: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
      position: relative;
      z-index: 100;
    }

    .chat-input {
      flex: 1;
      padding: 0.75rem 1.125rem;
      background-color: var(--color-bg-tertiary);
      border: 1px solid var(--color-border);
      border-radius: 1.5rem;
      color: var(--color-text);
      font-family: inherit;
      font-size: 16px; /* Prevent zoom on iOS */
      outline: none;
      -webkit-user-select: text;
      user-select: text;
      opacity: 1;
    }

    .slash-list {
      display: flex;
      flex-direction: column;
      max-height: 14rem;
      overflow-y: auto;
      background: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
    }

    .slash-list button {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 10px 16px;
      border: none;
      border-bottom: 1px solid var(--color-border-light);
      background: none;
      color: var(--color-text);
      text-align: left;
      font-size: 15px;
    }

    .slash-list button span {
      color: var(--color-text-dim);
      font-size: 13px;
    }

    /* A menu on screen that typing cannot answer (trust this folder?): its options as buttons,
       floating over the bottom of the terminal, where the menu itself is drawn. Taking layout
       space, it shrank the terminal; the menu no longer fit there, Claude drew it cut off,
       the block went, the terminal grew back, and round again (with the keyboard open). */
    .screen-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      z-index: 1;
      padding: 8px 14px;
      background-color: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
      box-shadow: 0 -6px 16px rgb(0 0 0 / 0.18);
    }

    .screen-menu-note {
      margin-bottom: 6px;
      color: var(--color-status-error);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.35;
    }

    .screen-menu-detail {
      display: -webkit-box;
      margin-bottom: 2px;
      overflow: hidden;
      color: var(--color-text-dim);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .screen-menu-question {
      margin-bottom: 6px;
      overflow: hidden;
      color: var(--color-text-dim);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .screen-menu-options {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .screen-menu-option {
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--color-primary);
      border-radius: 20px;
      background-color: color-mix(in srgb, var(--color-primary) 12%, transparent);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 15px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }

    .screen-menu-option:active {
      background-color: color-mix(in srgb, var(--color-primary) 24%, transparent);
    }

    .screen-menu-option:disabled {
      opacity: 0.5;
    }

    /* One-tap prompts above the composer; scrolls sideways, hidden while typing. */
    .quick-prompts {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding: 6px 14px 0;
      background-color: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
      scrollbar-width: none;
      touch-action: pan-x;
      overscroll-behavior-x: contain;
    }

    .quick-prompts::-webkit-scrollbar {
      display: none;
    }

    .quick-prompts + .chat-input-container {
      border-top: none;
    }

    .quick-prompt {
      flex-shrink: 0;
      min-height: 36px;
      padding: 0 12px;
      border: 1px solid var(--color-border);
      border-radius: 18px;
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 14px;
      white-space: nowrap;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }

    .quick-prompt:active {
      background-color: var(--color-surface-hover);
    }

    .quick-prompt.edit {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      padding: 0;
      color: var(--color-text-dim);
    }

    .prompt-editor {
      width: min(28rem, calc(100vw - 32px));
      max-height: 85vh;
      padding: 0;
      border: 1px solid var(--color-border);
      border-radius: 14px;
      background-color: var(--color-bg-secondary);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    }

    .prompt-editor::backdrop {
      background: rgba(0, 0, 0, 0.5);
    }

    .prompt-editor h2 {
      margin: 0;
      padding: 14px 16px 4px;
      font-size: 16px;
    }

    .prompt-editor p {
      margin: 0;
      padding: 0 16px 8px;
      color: var(--color-text-dim);
      font-size: 13px;
    }

    .prompt-editor ol {
      list-style: none;
      margin: 0;
      padding: 0 12px;
      max-height: 55vh;
      overflow-y: auto;
    }

    .prompt-editor li {
      display: grid;
      grid-template-columns: 1fr repeat(3, 36px);
      align-items: center;
      gap: 4px 6px;
      padding: 8px 0;
      border-bottom: 1px solid var(--color-border-light);
    }

    .prompt-editor li input {
      grid-column: 1;
      min-width: 0;
      padding: 6px 10px;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      font: inherit;
      font-size: 16px; /* Prevent zoom on iOS */
    }

    .prompt-editor li button {
      grid-row: 1 / span 2;
      height: 36px;
      border: none;
      border-radius: 8px;
      background: none;
      color: var(--color-text-dim);
      font-size: 18px;
    }

    .prompt-editor li button:disabled {
      opacity: 0.3;
    }

    .prompt-editor footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px;
    }

    .prompt-editor footer button {
      min-height: 36px;
      padding: 0 14px;
      border: 1px solid var(--color-border);
      border-radius: 18px;
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      font: inherit;
      font-size: 14px;
    }

    .prompt-editor footer .spacer {
      flex: 1;
    }

    .prompt-editor footer .save {
      border-color: var(--color-primary);
      background-color: var(--color-primary);
      color: white;
    }

    .attach-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.75rem;
      flex-shrink: 0;
      border: none;
      background: none;
      color: var(--color-text-dim);
      -webkit-tap-highlight-color: transparent;
    }

    .composer-input {
      resize: none;
      line-height: 1.35;
      max-height: 8.5rem;
      overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      border-radius: 1.25rem;
      display: block;
    }

    .chat-input:focus {
      border-color: var(--color-primary);
      background-color: var(--color-border);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 20%, transparent);
    }

    .chat-input::placeholder {
      color: var(--color-text-dim);
      opacity: 1;
    }

    .send-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.75rem;
      height: 2.75rem;
      background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-dark) 100%);
      border: none;
      border-radius: 50%;
      color: white;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
      box-shadow: 0 2px 6px color-mix(in srgb, var(--color-primary) 30%, transparent);
    }

    .send-button:hover:not(:disabled) {
      background: linear-gradient(135deg, var(--color-primary-light) 0%, var(--color-primary) 100%);
      transform: scale(1.05);
      box-shadow: 0 3px 10px color-mix(in srgb, var(--color-primary) 40%, transparent);
    }

    .send-button:active:not(:disabled) {
      transform: scale(0.95);
    }

    .send-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Why a send did nothing (an image still uploading or failed). */
    .composer-note {
      margin: 0 12px 6px;
      padding: 6px 10px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.35;
      color: var(--color-text);
      background: var(--color-bg-tertiary);
    }
    .keyboard-dismiss-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      background-color: var(--color-bg-tertiary);
      border: 1px solid var(--color-border);
      border-radius: 50%;
      color: var(--color-text-dim);
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }

    .keyboard-dismiss-button:hover {
      background-color: var(--color-surface-hover);
      color: var(--color-text-muted);
    }

    .keyboard-dismiss-button:active {
      transform: scale(0.95);
    }

    .chat-message {
      margin-bottom: 1rem;
      display: flex;
      flex-direction: column;
      animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin-bottom: 0.25rem;
      font-size: 0.7rem;
      color: var(--color-text-muted);
      padding: 0 0.5rem;
    }

    .message-icon {
      font-size: 0.875rem;
    }

    .message-sender {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }

    .message-separator {
      opacity: 0.4;
    }

    .message-time {
      opacity: 0.6;
    }

    .message-path {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
      opacity: 0.8;
      color: var(--color-primary);
      font-size: 0.65rem;
    }

    .message-bubble {
      padding: 0.875rem 1rem;
      border-radius: 1.125rem;
      max-width: 88%;
      word-wrap: break-word;
      font-size: 0.9rem;
      line-height: 1.5;
      position: relative;
    }

    .message-content {
      /* Terminal output stays left-to-right even in RTL languages. */
      direction: ltr;
      text-align: left;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
    }

    /* Command messages (user) - align right, WhatsApp green style */
    .chat-message.command {
      align-items: flex-end;
    }

    .chat-message.command .message-header {
      justify-content: flex-end;
    }

    .chat-message.command .message-bubble {
      background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-dark) 100%);
      color: white;
      border-radius: 1.125rem 1.125rem 0.25rem 1.125rem;
      box-shadow: 0 1px 3px color-mix(in srgb, var(--color-primary) 30%, transparent);
    }

    /* Output messages (system) - align left, dark bubble */
    .chat-message.output,
    .chat-message.prompt {
      align-items: flex-start;
    }

    .chat-message.output .message-bubble,
    .chat-message.prompt .message-bubble {
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      border-radius: 1.125rem 1.125rem 1.125rem 0.25rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    }

    /* Error messages */
    .chat-message.error {
      align-items: flex-start;
    }

    .chat-message.error .message-bubble {
      background-color: color-mix(in srgb, var(--color-status-error) 15%, var(--color-bg));
      color: var(--color-status-error);
      border-radius: 1.125rem 1.125rem 1.125rem 0.25rem;
      box-shadow: 0 1px 3px color-mix(in srgb, var(--color-status-error) 20%, transparent);
    }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-text-dim);
      text-align: center;
      padding: 2rem;
    }

    .empty-state-icon {
      font-size: 3.5rem;
      margin-bottom: 1.25rem;
      opacity: 0.6;
    }

    .empty-state-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--color-text-muted);
    }

    .empty-state-description {
      font-size: 0.8rem;
      max-width: 320px;
      line-height: 1.5;
      color: var(--color-text-dim);
    }

    /* Scrollbar styling */
    .chat-messages-container::-webkit-scrollbar {
      width: 8px;
    }

    .chat-messages-container::-webkit-scrollbar-track {
      background: var(--color-bg-secondary);
    }

    .chat-messages-container::-webkit-scrollbar-thumb {
      background: var(--color-border);
      border-radius: 4px;
    }

    .chat-messages-container::-webkit-scrollbar-thumb:hover {
      background: var(--color-text-muted);
    }

    /* Interactive options - pill-style bubbles */
    .interactive-options {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.875rem;
      padding-top: 0.75rem;
    }

    .option-button {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 15%, transparent) 0%, color-mix(in srgb, var(--color-primary-dark) 20%, transparent) 100%);
      border: 1.5px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
      border-radius: 1.25rem;
      color: var(--color-primary-light);
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: left;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      white-space: nowrap;
    }

    .option-button:hover {
      background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 25%, transparent) 0%, color-mix(in srgb, var(--color-primary-dark) 30%, transparent) 100%);
      border-color: var(--color-primary);
      transform: scale(1.03);
      box-shadow: 0 2px 8px color-mix(in srgb, var(--color-primary) 25%, transparent);
    }

    .option-button:active {
      transform: scale(0.97);
      background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 35%, transparent) 0%, color-mix(in srgb, var(--color-primary-dark) 40%, transparent) 100%);
    }

    .option-number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      background-color: var(--color-primary);
      color: white;
      border-radius: 50%;
      font-size: 0.7rem;
      font-weight: 700;
      flex-shrink: 0;
    }

    .option-text {
      line-height: 1.3;
    }
  `;

  @property() onSend?: (data: string) => void;
  @property() onPendingInputChange?: (input: string) => void;
  @property() subscribeToOutput?: (listener: (data: string) => void) => () => void;
  @property() getTerminalInputLine?: () => string;
  @property({ type: Boolean }) active = false;
  /** Render only the input bar (phones show the live terminal above it). */
  @property({ type: Boolean }) composerOnly = false;
  @property({ type: String }) pendingInput = '';
  @property({ type: String }) sessionId = '';
  /** Whether the session runs Claude Code, when the parent knows; quick prompts hide only on false. */
  @property({ attribute: false }) claudeSession?: boolean;
  /** The agent the session runs ("codex", "claude", a shell…), when the parent knows. */
  @property({ attribute: false }) agent?: string;
  /**
   * The terminal's last rows. The phone composer reads them for a menu that typing cannot
   * answer (Claude Code's trust-folder dialog), whose options then replace the quick prompts.
   */
  @property({ attribute: false }) getScreenText?: () => string;
  /** How getScreenText's lines are laid out: width, soft-wrapped rows, visible rows. */
  @property({ attribute: false }) getScreenLayout?: () => ScreenLayout | undefined;
  /** Claude Code reports it waits for the user (a permission, a plan to approve, a question). */
  @property({ attribute: false }) claudeWaiting?: boolean;
  /** The chat view above shows the menu's question and options itself: no second set here. */
  @property({ attribute: false }) menuInChat = false;
  /** A selection menu on screen: sending text would confirm its highlighted option. */
  @state() private screenMenu: ScreenChoices | null = null;
  @state() private screenMenuBusy = false;
  private screenMenuTimer?: ReturnType<typeof setInterval>;
  /** The menu just answered, ignored while the screen still shows it (it redraws first). */
  private answeredMenu: { sessionId: string; menu: ScreenChoices; at: number } | null = null;
  /** A message on its way through the server (an answer or a reply to a waiting Claude). */
  @state() private replyInFlight = false;
  /** Polls in a row that found no menu: one miss may be Claude redrawing it. */
  private screenMenuMisses = 0;
  /** The server said the menu changed: the next poll takes what is on screen as it is. */
  private refreshScreenMenu = false;
  /** Why a tap on a menu option did nothing, shown in the menu block (outside, it would resize). */
  @state() private screenMenuNote = '';
  private screenMenuNoteTimer?: ReturnType<typeof setTimeout>;
  /** Messages the chat view shows as not sent, by its bubble id, for its Retry. */
  private failedSends = new Map<string, { command: string; paths: string }>();
  /** Why a send did nothing, shown above the composer for a few seconds. */
  @state() private composerNote = '';
  private composerNoteTimer?: ReturnType<typeof setTimeout>;
  private outputUnsubscribe?: () => void;
  private syncInterval?: ReturnType<typeof setInterval>;
  private delayedTasks = new Set<ReturnType<typeof setTimeout>>();
  private lastInputTime = 0;

  @state() private messages: ChatMessage[] = [];
  @state() private slashMatches: Array<[string, MessageKey]> = [];
  @state() private composerEmpty = true;
  /** Phone composer: images to send with the next message (uploaded in the background). */
  @property({ attribute: false }) attachmentUploader?: AttachmentUploader;
  private attachments = new AttachmentQueue(
    () => this.requestUpdate(),
    (file, onProgress, signal) =>
      (this.attachmentUploader ?? uploadAttachment)(file, onProgress, signal)
  );
  @state() private customPrompts: QuickPrompt[] | null = loadCustomQuickPrompts();
  private quickPromptAt = 0;
  private longPressTimer?: ReturnType<typeof setTimeout>;
  private longPressed = false;
  /** Working copy while the quick-prompt editor is open. */
  @state() private editingPrompts: QuickPrompt[] | null = null;
  protected readonly i18n = new LocaleController(this);

  @query('#chat-input-field')
  private inputElement!: HTMLInputElement | HTMLTextAreaElement;

  @query('.chat-messages-container')
  private messagesContainer!: HTMLElement;

  private messageIdCounter = 0;

  connectedCallback() {
    super.connectedCallback();
    this.subscribeToTerminalOutput();
  }

  disconnectedCallback() {
    clearTimeout(this.longPressTimer);
    clearTimeout(this.composerNoteTimer);
    clearInterval(this.screenMenuTimer);
    this.screenMenuTimer = undefined;
    clearTimeout(this.screenMenuNoteTimer);
    this.unsubscribeFromTerminalOutput();
    this.stopTerminalSync();
    this.clearDelayedTasks();
    this.attachments.clear();
    super.disconnectedCallback();
  }

  private subscribeToTerminalOutput(): void {
    this.unsubscribeFromTerminalOutput();
    // The view stays mounted (hidden) outside chat mode. Listening then appended every
    // byte of output to one ever-growing message; with redraw-heavy apps (Claude Code)
    // the string got so large that rendering it crashed Safari's web process.
    if (!this.active || this.composerOnly || !this.subscribeToOutput || !this.isConnected) return;

    this.outputUnsubscribe = this.subscribeToOutput((data: string) => {
      this.processTerminalOutput(data);
    });
  }

  private unsubscribeFromTerminalOutput(): void {
    this.outputUnsubscribe?.();
    this.outputUnsubscribe = undefined;
  }

  private scheduleDelayedTask(task: () => void, delay: number): void {
    const timeout = setTimeout(() => {
      this.delayedTasks.delete(timeout);
      task();
    }, delay);
    this.delayedTasks.add(timeout);
  }

  private clearDelayedTasks(): void {
    for (const timeout of this.delayedTasks) {
      clearTimeout(timeout);
    }
    this.delayedTasks.clear();
  }

  /**
   * Start periodic sync from terminal to keep lastSentValue in sync
   * This prevents drift between chat input and terminal state
   */
  private startTerminalSync(): void {
    if (this.syncInterval) return; // Already running

    const SYNC_INTERVAL_MS = 300;
    const SYNC_DELAY_AFTER_INPUT_MS = 500; // Wait after user stops typing

    this.syncInterval = setInterval(() => {
      // Only sync if user hasn't typed recently
      const timeSinceLastInput = Date.now() - this.lastInputTime;
      if (timeSinceLastInput < SYNC_DELAY_AFTER_INPUT_MS) {
        return;
      }

      this.syncLastSentValueFromTerminal();
    }, SYNC_INTERVAL_MS);

    logger.debug('Terminal sync started');
  }

  private stopTerminalSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      logger.debug('Terminal sync stopped');
    }
  }

  /**
   * Sync lastSentValue with what's actually in the terminal
   * This corrects any drift between our tracking and terminal state
   */
  private syncLastSentValueFromTerminal(): void {
    if (!this.getTerminalInputLine) return;

    const terminalInput = this.getTerminalInputLine();
    if (terminalInput === null || terminalInput === undefined) return;

    // Clean up terminal input (remove TUI artifacts)
    // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
    const controlCharPattern = new RegExp('[\\x00-\\x1F\\x7F]', 'g');
    const cleanedInput = terminalInput
      .replace(controlCharPattern, '')
      .replace(/[│┃┆┇┊┋|]/g, ' ')
      .replace(/[─━┄┅┈┉═]/g, '')
      .replace(/[╭╮╰╯┌┐└┘]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Update lastSentValue if different - this fixes drift
    if (this.lastSentValue !== cleanedInput) {
      logger.debug(`Syncing lastSentValue: "${this.lastSentValue}" -> "${cleanedInput}"`);
      this.lastSentValue = cleanedInput;
    }
  }

  /**
   * Sync input from terminal with retry - gives time for buffer to fully load
   */
  private syncFromTerminalWithRetry(attempt = 0): void {
    if (!this.active || !this.isConnected || !this.getTerminalInputLine) return;

    let terminalInput = this.getTerminalInputLine();

    if (terminalInput) {
      // Aggressively clean up TUI artifacts and special characters
      // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
      const ctrlPattern = new RegExp('[\\x00-\\x1F\\x7F]', 'g');
      terminalInput = terminalInput
        .replace(ctrlPattern, '') // Remove control characters
        .replace(/[│┃┆┇┊┋|]/g, ' ') // Replace box-drawing pipes with space
        .replace(/[─━┄┅┈┉═]/g, '') // Remove horizontal lines
        .replace(/[╭╮╰╯┌┐└┘]/g, '') // Remove corners
        .replace(/\s+/g, ' ') // Collapse multiple spaces to one
        .trim();

      if (terminalInput) {
        // Set input value directly on DOM element (not via reactive binding)
        if (this.inputElement) {
          this.inputElement.value = terminalInput;
        }
        return;
      }
    }

    if (attempt < 3) {
      // Retry after a short delay (buffer might still be loading)
      this.scheduleDelayedTask(() => this.syncFromTerminalWithRetry(attempt + 1), 150);
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    this.syncScreenMenuWatch();
    // This view is reused across sessions: another session's images, note, menu and failed
    // sends are not this one's.
    if (changedProperties.has('sessionId') && changedProperties.get('sessionId') !== undefined) {
      this.attachments.clear();
      this.composerNote = '';
      this.screenMenu = null;
      this.screenMenuNote = '';
      this.screenMenuMisses = 0;
      this.answeredMenu = null;
      this.refreshScreenMenu = false;
      // The chat view drops another session's bubbles: there is nothing left to retry.
      this.failedSends.clear();
    }
    super.updated(changedProperties);
    if (changedProperties.has('messages')) {
      this.scrollToBottom();
    }
    // A modal dialog sits in the top layer, clear of the layout's transforms and the keyboard.
    const editor = this.shadowRoot?.querySelector<HTMLDialogElement>('.prompt-editor');
    if (editor && !editor.open) {
      if (typeof editor.showModal === 'function') editor.showModal();
      else editor.setAttribute('open', '');
    }
    if (changedProperties.has('subscribeToOutput') || changedProperties.has('active')) {
      this.subscribeToTerminalOutput();
    }
    // Lit reuses the composer across session switches: a draft belongs to its session, so
    // show the one this session had (kept in storage as it was typed).
    if (this.composerOnly && changedProperties.has('sessionId') && this.inputElement) {
      this.inputElement.value = loadDraft(this.sessionId);
      this.slashMatches = [];
      if (this.inputElement instanceof HTMLTextAreaElement) this.autoSize(this.inputElement);
      this.syncComposerEmpty();
    }
    // Sync input when becoming active
    if (changedProperties.has('active')) {
      if (this.active && this.composerOnly) {
        // Composer: the message is written locally and sent whole, so it never mirrors the
        // terminal's input line (which for Claude Code holds a ghost suggestion).
        this.lastSentValue = '';
        // Leaving chat mode cleared the box; the draft is still in storage.
        if (this.inputElement && !this.inputElement.value) {
          this.inputElement.value = loadDraft(this.sessionId);
          if (this.inputElement instanceof HTMLTextAreaElement) this.autoSize(this.inputElement);
          this.syncComposerEmpty();
        }
      } else if (this.active) {
        // Priority: terminal buffer > pendingInput
        if (this.getTerminalInputLine) {
          // Read from terminal buffer - it has the "truth" of what's on screen
          this.lastSentValue = '';
          if (this.inputElement) {
            this.inputElement.value = '';
          }
          this.syncFromTerminalWithRetry();
          this.syncLastSentValueFromTerminal();
        } else if (this.pendingInput && this.inputElement) {
          // Fallback to pendingInput
          this.inputElement.value = this.pendingInput;
          this.lastSentValue = this.pendingInput;
        } else {
          // No input to sync, start fresh
          this.lastSentValue = '';
          if (this.inputElement) {
            this.inputElement.value = '';
          }
        }

        // Start periodic sync to keep lastSentValue in sync with terminal
        this.startTerminalSync();

        // Focus the input field when chat becomes active - with delay to ensure DOM is ready
        this.scheduleDelayedTask(() => {
          if (this.inputElement && this.active && this.isConnected) {
            this.inputElement.focus();
            logger.log('Chat input focused on activation');
          }
        }, 100);
      } else {
        this.clearDelayedTasks();
        this.lastSentValue = '';
        if (this.inputElement) {
          this.inputElement.value = '';
        }
        // Stop sync when leaving chat mode
        this.stopTerminalSync();
      }
    }
    // NOTE: We intentionally do NOT sync pendingInput back to the input element here.
    // The chat input is the "source of truth" while the user is typing.
    // Syncing from pendingInput (which comes from terminal) would overwrite
    // accented characters that the terminal might not render correctly.
  }

  private processTerminalOutput(data: string) {
    // Strip ANSI codes
    const cleanData = this.stripAnsiCodes(data);

    // Ignore empty data
    if (!cleanData.trim() && !cleanData.includes('\r') && !cleanData.includes('\n')) {
      return;
    }

    // Split by lines to process each one
    const lines = cleanData.split(/\r?\n/);

    // Get the last command sent to filter out its echo
    const lastCommandMsg = this.messages
      .slice()
      .reverse()
      .find((m) => m.type === 'command');
    const lastCommand = lastCommandMsg ? lastCommandMsg.content : '';

    // Get current input value to filter out live echo
    const currentInput = this.inputElement?.value.trim() || '';

    for (const line of lines) {
      let trimmedLine = line.trim();

      // 1. Filter out noise (separators, spinners, system prompts)
      if (!trimmedLine) continue;

      // Filter echo of executed command
      if (lastCommand && (trimmedLine === lastCommand || trimmedLine.endsWith(lastCommand)))
        continue;

      // Filter live echo of current typing
      // We strip common prompt chars and box borders to check if the content matches what we are typing
      const cleanContent = trimmedLine
        .replace(/^[\s│]*[>·$#]\s?/, '') // Remove leading prompt/box
        .replace(/[│\s]*$/, ''); // Remove trailing box/space

      if (currentInput && cleanContent && currentInput.startsWith(cleanContent)) {
        continue;
      }

      // Filter TUI noise (boxes, status bars, spinners)
      if (this.isNoiseLine(trimmedLine)) continue;

      // Clean up leading symbols (spinners, prompts)
      // Includes braille patterns for spinners and various bullets
      trimmedLine = trimmedLine.replace(/^[\s]*[·⏵>⏺✻✽✶✳✢✦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s?/, '');

      // If line became empty after cleaning, skip
      if (!trimmedLine.trim()) continue;

      // 2. Append to current message or create new one
      this.appendOutputToChat(trimmedLine.trim());
    }
  }

  private isNoiseLine(line: string): boolean {
    // Box borders and horizontal lines
    if (line.match(/^[─_━\s╭╮╰╯│]+$/)) return true;

    // Very short lines that are likely noise (single chars like ~, >, etc)
    const trimmed = line.trim();
    if (trimmed.length <= 2 && !trimmed.match(/^[a-zA-Z0-9]$/)) return true;

    // Thinking/processing indicators (Gemini, Claude CLI)
    if (
      line.includes('Thinking') ||
      line.includes('Thought for') ||
      line.includes('ctrl+o to show') ||
      line.match(/^∴/) || // Gemini thinking symbol
      line.match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/) || // Braille spinners
      line.includes('Processing') ||
      line.includes('Generating')
    ) {
      return true;
    }

    // Permission dialogs - keep interactive options visible but filter noise
    if (
      line.includes('current working directory') ||
      line.includes('Shell ') || // Shell command headers
      line.includes('(Cre') || // Truncated "(Create..." etc
      line.includes('(Deleti') || // Truncated "(Deleting..." etc
      line.match(/^[?!]\s+Shell/) || // Permission prompt headers
      line.includes('← │') || // TUI box edges
      line.includes('│ ?') ||
      line.includes('Waiting for user')
    ) {
      return true;
    }

    // Specific Gemini/Claude TUI elements
    if (
      line.includes('Gemini CLI update available') ||
      line.includes('Installed via Homebrew') ||
      line.includes('Using:') || // Gemini "Using: - X GEMINI.md files"
      trimmed === 'Usi' || // Partial "Using:" (streaming)
      trimmed === 'ng:' || // Partial "Using:" continued
      line.includes('GEMINI.md') || // Config file references
      line.includes('CLAUDE.md') || // Config file references
      line.match(/^-\s*\d+\s*(GEMINI|CLAUDE|\.md)/i) || // "- 4 GEMINI.md files" pattern
      line.includes('Type your message or @path') ||
      line.includes('no sandbox') || // Status bar - filter any line with this
      line.includes('Converting coffee into code') ||
      line.includes('Considering the Greeting') ||
      line.includes("I'm Feeling Lucky") ||
      line.includes('esc to cancel') ||
      line.includes('esc to interrupt') ||
      line.includes('bypass permissions on') ||
      line.includes('Marinating') ||
      line.includes('Clauding') ||
      line.includes('Simmering') ||
      line.includes('enable IDE integration') ||
      line.includes('Queued (press') ||
      line.includes('Tip: Open the Command Palette')
    ) {
      return true;
    }

    // Status bar fragments - be more aggressive
    if (line.match(/^~\/.*no sandbox/)) return true;
    if (trimmed === 'auto' || trimmed === 'manual' || trimmed === 'plan') return true;
    if (line.match(/^\s*(auto|manual|plan)\s*$/)) return true;

    // Boxed content (lines starting and ending with │) that looks like noise
    if (line.startsWith('│') && line.endsWith('│')) {
      // Assume it's a TUI box if it's short or matches known patterns
      // (We already caught specific messages above, but this catches generic boxes)
      // To be safe, we only filter if it contains "update" or "Homebrew" which we already did.
      // Let's filter empty box lines
      if (line.replace(/[│\s]/g, '').length === 0) return true;
    }

    return false;
  }

  private appendOutputToChat(content: string) {
    const lastMsg = this.messages[this.messages.length - 1];

    // If last message is from System (output), append to it
    if (lastMsg && lastMsg.type === 'output') {
      const lastLines = lastMsg.content.split('\n');
      const lastLine = lastLines[lastLines.length - 1].trim();

      // Replace only a progressive redraw of the trailing line. Exact repeated output
      // is meaningful terminal content and must remain visible.
      // e.g., lastLine = "Hello", content = "Hello, how are you?"
      if (content.length > lastLine.length && content.startsWith(lastLine) && lastLine.length > 0) {
        // Replace last line with the longer version
        if (lastLines.length > 1) {
          lastLines[lastLines.length - 1] = content;
          lastMsg.content = lastLines.join('\n');
        } else {
          lastMsg.content = content;
        }
        this.requestUpdate();
        this.scrollToBottom();
        return;
      }

      // Normal case: append new content, keeping only the tail of very long output.
      const appended = `${lastMsg.content ? `${lastMsg.content}\n` : ''}${content}`;
      lastMsg.content =
        appended.length > MAX_MESSAGE_LENGTH ? appended.slice(-MAX_MESSAGE_LENGTH) : appended;
      this.requestUpdate();
      this.scrollToBottom();
    } else {
      // Create new system message
      this.addMessage('output', content);
    }
  }

  private stripAnsiCodes(str: string): string {
    // Remove ANSI escape codes but preserve the text
    // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
    const colorCodes = new RegExp('\\x1b\\[[0-9;]*m', 'g');
    // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
    const escapeSeq = new RegExp('\\x1b\\[.*?[@-~]', 'g');
    // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
    const oscSeq = new RegExp('\\x1b\\].*?\\x07', 'g');
    // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
    const otherSeq = new RegExp('\\x1b.*?[\\x40-\\x5a\\x5c\\x5f]', 'g');
    return str
      .replace(colorCodes, '')
      .replace(escapeSeq, '')
      .replace(oscSeq, '')
      .replace(otherSeq, '');
  }

  private addMessage(type: ChatMessage['type'], content: string) {
    if (!content.trim()) return;

    // Detect if this is an error message
    const isError = this.detectError(content);
    const messageType = isError ? 'error' : type;

    this.messages = [
      ...this.messages,
      {
        type: messageType,
        content: content.trim(),
        timestamp: new Date(),
        id: `msg-${this.messageIdCounter++}`,
      },
    ];
  }

  private detectError(str: string): boolean {
    const errorKeywords = [
      'error',
      'failed',
      'cannot',
      'permission denied',
      'not found',
      'fatal',
      'exception',
      'traceback',
    ];
    const lowerStr = str.toLowerCase();
    return errorKeywords.some((keyword) => lowerStr.includes(keyword));
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.messagesContainer) {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
      }
    });
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  private detectInteractiveOptions(content: string): InteractiveOption[] | null {
    // Detect Gemini CLI permission format like:
    // ● 1. Yes, allow once
    //   2. Yes, allow always ...
    //   3. No, suggest changes (esc)
    const geminiPattern = /[●\s]*(\d+)\.\s+(.+?)(?:\s*\.{3}|\s*\(esc\))?$/gm;
    const geminiMatches: InteractiveOption[] = [];

    for (const match of content.matchAll(geminiPattern)) {
      const label = match[2]
        .trim()
        .replace(/\s*\.{3}$/, '')
        .replace(/\s*\(esc\)$/, '');
      geminiMatches.push({ label, response: match[1] });
    }

    if (geminiMatches.length >= 2) {
      return geminiMatches;
    }

    // Detect numbered options like:
    // 1) Option one
    // 2) Option two
    const numberedPattern = /^\s*(\d+)\)\s+(.+)$/gm;
    const matches: InteractiveOption[] = [];

    for (const match of content.matchAll(numberedPattern)) {
      matches.push({ label: match[2].trim(), response: match[1] });
    }

    if (matches.length >= 2) {
      return matches;
    }

    // Detect lettered options like:
    // a) Option one
    // b) Option two
    const letteredPattern = /^\s*([a-z])\)\s+(.+)$/gm;
    const letterMatches: InteractiveOption[] = [];

    for (const match of content.matchAll(letteredPattern)) {
      letterMatches.push({ label: match[2].trim(), response: match[1] });
    }

    if (letterMatches.length >= 2) {
      return letterMatches;
    }

    // Detect bracketed options like:
    // [1] Option one
    // [2] Option two
    const bracketPattern = /^\s*\[(\d+)\]\s+(.+)$/gm;
    const bracketMatches: InteractiveOption[] = [];

    for (const match of content.matchAll(bracketPattern)) {
      bracketMatches.push({ label: match[2].trim(), response: match[1] });
    }

    if (bracketMatches.length >= 2) {
      return bracketMatches;
    }

    // Detect yes/no questions
    if (/\(y\/n\)|\[y\/n\]|yes\/no/i.test(content)) {
      return [
        { label: t('chat.option.yes'), response: 'y' },
        { label: t('chat.option.no'), response: 'n' },
      ];
    }

    // Detect "Allow execution" prompts
    if (/Allow execution of/i.test(content)) {
      return [
        { label: t('chat.option.allowOnce'), response: '1' },
        { label: t('chat.option.allowAlways'), response: '2' },
        { label: t('chat.option.no'), response: '3' },
      ];
    }

    return null;
  }

  private handleOptionClick(option: InteractiveOption) {
    if (!this.onSend) return;

    // Send the option response + enter to the terminal
    const input = `${option.response}\r`;
    this.onSend(input);

    // Mark the current message as "answered" by changing it to show just the selected option
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg && lastMsg.type === 'output') {
      // Replace the message content with just the selected option
      lastMsg.content = t('chat.selected', { option: option.label });
      this.requestUpdate();
    }

    // Force next output to create a new message by adding a placeholder command
    this.addMessage('command', `[Option ${option.response}]`);

    logger.log(`Selected option ${option.response}: ${option.label}`);
  }

  /**
   * Clean up content when showing interactive options
   * Removes shell box content and other noise to show just the question
   */
  private cleanContentForOptions(content: string): string {
    const lines = content.split('\n');
    const cleanLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip shell box frames
      if (
        trimmed.match(/^[╭╮╰╯│─┌┐└┘├┤┬┴┼]+$/) ||
        trimmed.match(/^[─━═]+$/) ||
        trimmed.startsWith('│') ||
        trimmed.endsWith('│')
      ) {
        continue;
      }

      // Skip checkmark lines (shell execution confirmations)
      if (trimmed.startsWith('✓') || trimmed.startsWith('✔')) {
        continue;
      }

      // Skip lines that look like shell commands
      if (trimmed.match(/^Shell\s+/) || trimmed.match(/^(mkdir|rm|mv|cp|cd|ls|cat|echo)\s/)) {
        continue;
      }

      // Skip empty lines
      if (!trimmed) continue;

      // Skip option lines (they'll be rendered as buttons)
      if (
        trimmed.match(/^[●○•]\s*\d+\./) || // Gemini option format
        trimmed.match(/^\d+[.)]\s/) || // Numbered options
        trimmed.match(/^[a-z][.)]\s/i)
      ) {
        // Lettered options
        continue;
      }

      cleanLines.push(trimmed);
    }

    // If nothing remains, return a default prompt
    if (cleanLines.length === 0) {
      return t('chat.chooseOption');
    }

    return cleanLines.join('\n');
  }

  /**
   * Extract working directory path from the beginning of a message
   * Returns { path, content } where path is the extracted path (or null) and content is the remaining text
   */
  private extractPathFromContent(content: string): { path: string | null; content: string } {
    // Match paths like ~/Projects, ~/foo/bar, /Users/something at the start of the message
    const pathMatch = content.match(/^(~\/[^\s\n]+|\/[^\s\n]+)\s*/);
    if (pathMatch) {
      const path = pathMatch[1];
      const remainingContent = content.slice(pathMatch[0].length).trim();
      return { path, content: remainingContent };
    }
    return { path: null, content };
  }

  private renderMessage(msg: ChatMessage) {
    const isCommand = msg.type === 'command';
    const isError = msg.type === 'error';
    const options = !isCommand ? this.detectInteractiveOptions(msg.content) : null;

    // Extract path from system messages to show in header
    let { path, content: messageContent } = !isCommand
      ? this.extractPathFromContent(msg.content)
      : { path: null, content: msg.content };

    // When showing interactive options, clean up the content to show just the relevant question
    // Remove shell box content and noise
    if (options) {
      messageContent = this.cleanContentForOptions(messageContent);
    }

    return html`
      <div
        class="chat-message ${msg.type}"
        data-message-id="${msg.id}"
      >
        <div class="message-header">
          <span class="message-icon">
            ${isCommand ? '💬' : isError ? '❌' : options ? '❓' : '🤖'}
          </span>
          <span class="message-sender">
            ${isCommand ? t('chat.sender.you') : t('chat.sender.system')}
          </span>
          ${
            path
              ? html`
            <span class="message-separator">•</span>
            <span class="message-path">${path}</span>
          `
              : ''
          }
          <span class="message-separator">•</span>
          <span class="message-time">${this.formatTime(msg.timestamp)}</span>
        </div>
        <div class="message-bubble ${msg.type}">
          <pre class="message-content">${messageContent}</pre>
          ${
            options
              ? html`
            <div class="interactive-options">
              ${options.map(
                (option, index) => html`
                <button
                  class="option-button"
                  @click=${() => this.handleOptionClick(option)}
                >
                  <span class="option-number">${index + 1}</span>
                  <span class="option-text">${option.label}</span>
                </button>
              `
              )}
            </div>
          `
              : ''
          }
        </div>
      </div>
    `;
  }

  private handleContainerClick(e: Event) {
    // On iPad, clicking outside the input loses focus and makes it hard to refocus
    // Always refocus the input when clicking anywhere in the chat view
    const target = e.target as HTMLElement;
    // Don't refocus if clicking on a button (send button, option buttons)
    if (target.tagName !== 'BUTTON' && !target.closest('button')) {
      // Use setTimeout to ensure focus happens after any other handlers
      this.scheduleDelayedTask(() => {
        if (this.inputElement && this.active) {
          this.inputElement.focus();
          logger.log('Chat input focused via container click');
        }
      }, 50);
    }
  }

  render() {
    return html`
      <div class="chat-view-container" @click=${this.handleContainerClick}>
        ${
          this.composerOnly
            ? ''
            : html`
        <div class="chat-messages-container">
          ${
            this.messages.length === 0
              ? html`
                <div class="empty-state">
                  <div class="empty-state-icon">💬</div>
                  <div class="empty-state-title">${t('chat.terminal.emptyTitle')}</div>
                  <div class="empty-state-description">
                    ${t('chat.terminal.emptyDescription')}
                  </div>
                </div>
              `
              : this.messages.map((msg) => this.renderMessage(msg))
          }
        </div>
        `
        }
        
        ${
          this.slashMatches.length > 0
            ? html`<div class="slash-list" role="listbox">
                ${this.slashMatches.map(
                  ([command, description]) =>
                    html`<button
                      role="option"
                      @pointerdown=${(e: Event) => e.preventDefault()}
                      @click=${() => this.pickSlashCommand(command)}
                    >
                      <strong dir="ltr">${command}</strong><span>${t(description)}</span>
                    </button>`
                )}
              </div>`
            : nothing
        }
        ${this.renderScreenMenu()} ${this.renderQuickPrompts()} ${this.renderPromptEditor()}
        ${this.renderComposerNote()}
        ${
          this.composerOnly && this.attachments.items.length > 0
            ? html`<chat-attachment-strip
                .items=${this.attachments.items}
                @attachment-remove=${(e: CustomEvent<{ id: string }>) => this.attachments.remove(e.detail.id)}
                @attachment-retry=${(e: CustomEvent<{ id: string }>) => this.attachments.retry(e.detail.id)}
              ></chat-attachment-strip>`
            : nothing
        }
        <!-- Chat input area (WhatsApp style) -->
        <div 
          class="chat-input-container"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
        >
          <!-- Autocorrect is intentional; spellcheck stays off because commands may contain secrets. -->
          ${
            this.composerOnly
              ? html`<button
                  class="attach-button"
                  title=${t('chat.attach')}
                  aria-label=${t('chat.attach')}
                  @click=${() =>
                    this.dispatchEvent(
                      new CustomEvent('composer-attach', { bubbles: true, composed: true })
                    )}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </button>`
              : nothing
          }
          ${
            this.composerOnly
              ? html`<textarea
                  id="chat-input-field"
                  class="chat-input composer-input"
                  rows="1"
                  placeholder=${t('chat.composerPlaceholder')}
                  dir="auto"
                  autocomplete="off"
                  autocorrect="on"
                  autocapitalize="sentences"
                  spellcheck="true"
                  enterkeyhint="send"
                  @keydown=${this.handleInputKeydown}
                  @input=${this.handleInput}
                  @paste=${this.handleComposerPaste}
                  @focus=${this.handleComposerFocus}
                ></textarea>`
              : html`<input
                  id="chat-input-field"
                  type="text"
                  class="chat-input"
                  placeholder=${t('chat.commandPlaceholder')}
                  autocomplete="off"
                  autocorrect="on"
                  autocapitalize="off"
                  spellcheck="false"
                  @keydown=${this.handleInputKeydown}
                  @input=${this.handleInput}
                  @focus=${() => logger.log('Input focused')}
                  @blur=${() => logger.log('Input blurred')}
                />`
          }
          <button
            class="keyboard-dismiss-button"
            @click=${this.handleDismissKeyboard}
            title=${t('chat.hideKeyboard')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/>
              <path d="M12 19l-4 3v-3h-4v-2h16v2h-4v3z" opacity="0.5"/>
            </svg>
          </button>
          <button
            class="send-button"
            @click=${this.handleSend}
            ?disabled=${this.composerOnly && (this.attachments.busy || this.replyInFlight)}
            aria-label=${t('chat.send')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  private showComposerNote(note: string) {
    clearTimeout(this.composerNoteTimer);
    this.composerNote = note;
    if (note) this.composerNoteTimer = setTimeout(() => (this.composerNote = ''), 7000);
  }

  private renderComposerNote() {
    if (!this.composerOnly || !this.composerNote) return nothing;
    return html`<div class="composer-note" role="alert" data-testid="composer-note">
      ${this.composerNote}
    </div>`;
  }

  private updateSlashMatches(value: string) {
    const typed = value.trimStart();
    this.slashMatches =
      typed.startsWith('/') && !/\s/.test(typed)
        ? slashCommandsFor(this.agent)
            .filter(([command]) => command.startsWith(typed.toLowerCase()))
            .slice(0, 6)
        : [];
  }

  private pickSlashCommand(command: string) {
    const input = this.inputElement;
    if (!input) return;
    input.value = `${command} `;
    saveDraft(this.sessionId, input.value);
    this.slashMatches = [];
    this.syncComposerEmpty();
    input.focus();
  }

  /**
   * Phone composer: queue images to go out with the next message. They upload now and show
   * as thumbnails; nothing is typed into the terminal until Send.
   */
  addAttachments(files: File[]) {
    if (files.length === 0) return;
    this.attachments.add(files);
    this.showComposerNote('');
  }

  /** A screenshot pasted into the composer joins the attachments instead of the text. */
  private handleComposerPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    // The session view's document-level paste handler would upload it a second time.
    e.stopPropagation();
    this.addAttachments(files);
  };

  /**
   * A hardware key's character, typed while nothing had the focus: it starts (or continues)
   * the message here, and the composer takes the focus for the keys after it.
   */
  typeFromKeyboard(text: string): boolean {
    const input = this.inputElement;
    if (!this.composerOnly || !input) return false;
    input.focus();
    // The caret after it, not a selection the next key would replace.
    input.setSelectionRange(input.value.length, input.value.length);
    // iOS starts writing into an element focused from a key event late: keys reaching it in
    // the meantime fire keydown and are never written ("Reply" would arrive as "R", its next
    // letter lost). The composer writes them itself until the keys pause.
    this.handTypingUntil = Date.now() + HAND_TYPING_MS;
    this.writeAtCaret(input, text);
    return true;
  }

  /** Until when hardware keys reaching the composer are written by it (see typeFromKeyboard). */
  private handTypingUntil = 0;

  /** A key typed while iOS isn't writing into the composer yet (see typeFromKeyboard). */
  private typeByHand(e: KeyboardEvent): boolean {
    const input = this.inputElement;
    // Option types characters ("@" on some layouts); Ctrl and Cmd are shortcuts.
    if (!input || Date.now() > this.handTypingUntil || e.ctrlKey || e.metaKey) {
      return false;
    }
    if (e.key.length === 1) this.writeAtCaret(input, e.key);
    else if (e.key === 'Backspace') this.eraseAtCaret(input);
    else return false;
    e.preventDefault();
    this.handTypingUntil = Date.now() + HAND_TYPING_MS;
    return true;
  }

  /** Writes typed text at the caret, as typing would (size, draft, suggestions). */
  private writeAtCaret(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
    const start = input.selectionStart ?? input.value.length;
    input.setRangeText(text, start, input.selectionEnd ?? start, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Erases the selection, or the character before the caret (both halves of an emoji). */
  private eraseAtCaret(input: HTMLInputElement | HTMLTextAreaElement) {
    const end = input.selectionEnd ?? input.value.length;
    let start = input.selectionStart ?? end;
    if (start === end) {
      if (start === 0) return;
      start -= /[\uDC00-\uDFFF]/.test(input.value[start - 1]) && start > 1 ? 2 : 1;
    }
    input.setRangeText('', start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Append text (e.g. an uploaded file's path) to the composer. */
  insertText(text: string) {
    const input = this.inputElement;
    if (!input) return;
    const separator = input.value && !input.value.endsWith(' ') ? ' ' : '';
    input.value = `${input.value}${separator}${text} `;
    if (input instanceof HTMLTextAreaElement) this.autoSize(input);
    if (this.composerOnly) saveDraft(this.sessionId, input.value);
    this.syncComposerEmpty();
  }

  private syncComposerEmpty() {
    this.composerEmpty = !this.inputElement?.value.trim();
  }

  /** Watches the screen for a menu while this is the phone composer of an open session. */
  private syncScreenMenuWatch() {
    const watch = this.composerOnly && this.active && Boolean(this.getScreenText);
    if (watch && !this.screenMenuTimer) {
      this.screenMenuTimer = setInterval(this.readScreenMenu, SCREEN_MENU_POLL_MS);
      queueMicrotask(this.readScreenMenu);
    } else if (!watch && this.screenMenuTimer) {
      clearInterval(this.screenMenuTimer);
      this.screenMenuTimer = undefined;
      this.screenMenu = null;
    }
  }

  private readScreenMenu = () => {
    const found = this.isAgentSession() ? this.parseScreen() : null;
    // A selection menu (cursor and key hints): Enter confirms its highlighted option, such as
    // Codex's "Update now" (a global npm install), whatever the user meant. Numbered lists in
    // Claude's answers have neither and stay out of it.
    const menu = found?.cursor !== undefined ? found : null;
    if (
      menu &&
      this.answeredMenu?.sessionId === this.sessionId &&
      sameShownMenu(this.answeredMenu.menu, menu) &&
      Date.now() - this.answeredMenu.at < 3000
    ) {
      this.screenMenu = null;
      return;
    }
    // A poll landing while Claude redraws the menu may find it cut off or gone: the same
    // options keep the block as it is, and it goes only after two polls without a menu.
    if (!menu) {
      this.screenMenuMisses++;
      if (this.screenMenu && this.screenMenuMisses >= 2) this.screenMenu = null;
      return;
    }
    this.screenMenuMisses = 0;
    // A new prompt may ask the same question with the same options (consecutive permissions):
    // keeping the old one showed its detail and sent its key, and every tap got "changed". Its cursor moving, or a read cut off by a redraw, is the same.
    if (this.refreshScreenMenu || !sameShownMenu(menu, this.screenMenu)) {
      this.screenMenu = menu;
      if (!this.refreshScreenMenu) this.screenMenuNote = '';
      this.refreshScreenMenu = false;
    } else if ((menu.key?.length ?? 0) > (this.screenMenu?.key?.length ?? 0)) {
      // The same menu read whole after a cut-off read: its question and detail too.
      this.screenMenu = menu;
    }
  };

  private showScreenMenuNote(note: string) {
    clearTimeout(this.screenMenuNoteTimer);
    this.screenMenuNote = note;
    this.screenMenuNoteTimer = setTimeout(() => (this.screenMenuNote = ''), 6000);
  }

  /** An unnumbered menu on screen: one button per option, since typing cannot answer it. */
  private renderScreenMenu() {
    const menu = this.screenMenu;
    if (!this.composerOnly || !menu || this.menuInChat) return nothing;
    return html`<div
      class="screen-menu"
      role="group"
      aria-label=${menu.question || t('screenMenu.label')}
      data-testid="screen-menu"
      @click=${(e: Event) => e.stopPropagation()}
    >
      ${
        // On top: the block grows upward from the composer, so a note here leaves the buttons
        // where they are (one under them moved them up, then down under the finger at 6 s).
        this.screenMenuNote
          ? html`<div class="screen-menu-note" role="alert" data-testid="screen-menu-note">
              ${this.screenMenuNote}
            </div>`
          : nothing
      }
      ${
        // What it is about ("Bash command · rm -rf dist/"): the same question may be asked of
        // another command next.
        menu.detail?.length
          ? html`<div class="screen-menu-detail" dir="ltr" data-testid="screen-menu-detail">
              ${compactDetail(menu.detail)}
            </div>`
          : nothing
      }
      ${menu.question ? html`<div class="screen-menu-question" dir="auto">${menu.question}</div>` : nothing}
      <div class="screen-menu-options">
        ${menu.options.map(
          (option, index) =>
            html`<button
              class="screen-menu-option"
              dir="auto"
              ?disabled=${this.screenMenuBusy}
              @mousedown=${(e: Event) => e.preventDefault()}
              @contextmenu=${(e: Event) => e.preventDefault()}
              @pointerup=${this.quickPromptTap(() => void this.chooseScreenMenuOption(index))}
              @click=${this.quickPromptTap(() => void this.chooseScreenMenuOption(index))}
            >
              ${option}
            </button>`
        )}
      </div>
    </div>`;
  }

  /** Picks a menu option through the server, which moves the cursor there and presses Enter. */
  private async chooseScreenMenuOption(index: number) {
    const menu = this.screenMenu;
    const sessionId = this.sessionId;
    if (!menu || this.screenMenuBusy || !sessionId) return;
    this.screenMenuBusy = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify({
          option: index + 1,
          question: menu.question,
          options: menu.options,
          key: menu.key,
        }),
      });
      // Another session opened meanwhile: this answer is not about what it shows (its result
      // blanked the new session's menu or said its prompt changed).
      if (this.sessionId !== sessionId) return;
      if (response.ok) {
        this.answeredMenu = { sessionId, menu, at: Date.now() };
        this.screenMenu = null;
      } else {
        const error =
          response.status === 409
            ? ((await response.json().catch(() => ({}))) as { error?: string }).error
            : undefined;
        // A changed menu: the next poll shows the one on screen now, with this note.
        if (response.status === 409 && error !== 'busy') this.refreshScreenMenu = true;
        // "busy": another answer to this session is still on its way, not a changed menu.
        this.showScreenMenuNote(
          t(
            error === 'busy'
              ? 'screenMenu.sending'
              : response.status === 409
                ? 'screenMenu.changed'
                : 'screenMenu.failed'
          )
        );
      }
    } catch {
      if (this.sessionId === sessionId) this.showScreenMenuNote(t('screenMenu.failed'));
    } finally {
      this.screenMenuBusy = false;
    }
  }

  private renderQuickPrompts() {
    // Not while Claude waits on a menu: "Yes" or "Continue" are not answers to it.
    if (!this.composerOnly || !this.composerEmpty || this.screenMenu || this.claudeWaiting) {
      return nothing;
    }
    // Quick prompts are for the agents, not plain shells.
    if (this.claudeSession === false && this.agent !== 'codex' && this.agent !== 'gemini') {
      return nothing;
    }
    const prompts = this.customPrompts ?? defaultQuickPrompts();
    return html`<div
      class="quick-prompts"
      role="toolbar"
      aria-label=${t('prompts.rowLabel')}
      @click=${(e: Event) => e.stopPropagation()}
    >
      ${prompts.map(
        (prompt) =>
          html`<button
            class="quick-prompt"
            dir="auto"
            title=${prompt.text}
            @pointerdown=${this.quickPromptPress}
            @pointercancel=${this.cancelLongPress}
            @mousedown=${(e: Event) => e.preventDefault()}
            @contextmenu=${(e: Event) => e.preventDefault()}
            @pointerup=${this.quickPromptTap(() => this.runQuickPrompt(prompt))}
            @click=${this.quickPromptTap(() => this.runQuickPrompt(prompt))}
          >
            ${prompt.label}
          </button>`
      )}
      <button
        class="quick-prompt edit"
        data-testid="edit-quick-prompts"
        title=${t('prompts.edit')}
        aria-label=${t('prompts.edit')}
        @pointerdown=${(e: Event) => e.preventDefault()}
        @mousedown=${(e: Event) => e.preventDefault()}
        @pointerup=${this.quickPromptTap(this.openPromptEditor)}
        @click=${this.quickPromptTap(this.openPromptEditor)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
    </div>`;
  }

  private openPromptEditor = () => {
    this.editingPrompts = (this.customPrompts ?? defaultQuickPrompts()).map((p) => ({ ...p }));
  };

  private closePromptEditor() {
    this.shadowRoot?.querySelector<HTMLDialogElement>('.prompt-editor')?.close?.();
    this.editingPrompts = null;
  }

  private savePromptEditor() {
    const prompts = (this.editingPrompts ?? [])
      .map((p) => ({ label: p.label.trim() || p.text.trim(), text: p.text.trim() }))
      .filter((p) => p.text);
    saveQuickPrompts(prompts);
    this.customPrompts = prompts;
    this.closePromptEditor();
  }

  private resetPromptEditor() {
    saveQuickPrompts(null);
    this.customPrompts = null;
    this.closePromptEditor();
  }

  private movePrompt(index: number, delta: number) {
    const prompts = [...(this.editingPrompts ?? [])];
    const target = index + delta;
    if (target < 0 || target >= prompts.length) return;
    [prompts[index], prompts[target]] = [prompts[target], prompts[index]];
    this.editingPrompts = prompts;
  }

  private renderPromptEditor() {
    const prompts = this.editingPrompts;
    if (!prompts) return nothing;
    return html`<dialog
      class="prompt-editor"
      aria-label=${t('prompts.edit')}
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.closePromptEditor();
      }}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
      @click=${(e: Event) => e.stopPropagation()}
    >
      <h2>${t('prompts.edit')}</h2>
      <p>${t('prompts.hint')}</p>
      <ol>
        ${prompts.map(
          (prompt, index) => html`<li>
            <input
              class="prompt-label"
              dir="auto"
              placeholder=${t('prompts.label')}
              aria-label=${t('prompts.label')}
              .value=${prompt.label}
              @input=${(e: Event) => {
                prompt.label = (e.target as HTMLInputElement).value;
              }}
            />
            <input
              class="prompt-text"
              dir="auto"
              placeholder=${t('prompts.text')}
              aria-label=${t('prompts.text')}
              .value=${prompt.text}
              @input=${(e: Event) => {
                prompt.text = (e.target as HTMLInputElement).value;
              }}
            />
            <button
              aria-label=${t('prompts.moveUp')}
              title=${t('prompts.moveUp')}
              ?disabled=${index === 0}
              @click=${() => this.movePrompt(index, -1)}
            >↑</button>
            <button
              aria-label=${t('prompts.moveDown')}
              title=${t('prompts.moveDown')}
              ?disabled=${index === prompts.length - 1}
              @click=${() => this.movePrompt(index, 1)}
            >↓</button>
            <button
              class="prompt-remove"
              aria-label=${t('prompts.remove')}
              title=${t('prompts.remove')}
              @click=${() => {
                this.editingPrompts = prompts.filter((_, i) => i !== index);
              }}
            >✕</button>
          </li>`
        )}
      </ol>
      <footer>
        <button
          class="prompt-add"
          @click=${() => {
            this.editingPrompts = [...prompts, { label: '', text: '' }];
          }}
        >
          ${t('prompts.add')}
        </button>
        <button class="prompt-reset" @click=${this.resetPromptEditor}>${t('prompts.reset')}</button>
        <span class="spacer"></span>
        <button @click=${this.closePromptEditor}>${t('common.cancel')}</button>
        <button class="save" @click=${this.savePromptEditor}>${t('common.save')}</button>
      </footer>
    </dialog>`;
  }

  /** Keeps focus (and the keyboard) on the message field. */
  private quickPromptPress = (e: PointerEvent) => {
    e.preventDefault();
    // Holding a chip opens the editor.
    this.cancelLongPress();
    this.longPressed = false;
    this.longPressTimer = setTimeout(() => {
      this.longPressed = true;
      this.openPromptEditor();
    }, 500);
  };

  private cancelLongPress = () => {
    clearTimeout(this.longPressTimer);
    this.longPressTimer = undefined;
  };

  /**
   * Touch acts on pointerup: on iOS the first tap on a button could be taken as a hover and
   * produce no click. The click that may still follow is ignored; mouse and keyboard use it.
   */
  private quickPromptTap(action: () => void) {
    return (e: Event) => {
      if (e.type === 'pointerup') this.cancelLongPress();
      if (this.longPressed && e.type === 'pointerup') {
        // The press already opened the editor: neither its release nor its click is a tap.
        this.longPressed = false;
        this.quickPromptAt = Date.now();
        swallowNextClick();
        return;
      }
      if (e.type === 'pointerup') {
        const pointer = e as PointerEvent;
        if (pointer.pointerType === 'mouse') return;
        // A drag is not a tap: one that scrolled the row, or began on the pencil.
        if (endsADrag(pointer)) return;
        this.quickPromptAt = Date.now();
      } else if (Date.now() - this.quickPromptAt < 700) {
        return;
      }
      action();
    };
  }

  /** Send the prompt as if typed and sent; a "…" template goes into the field instead. */
  private runQuickPrompt(prompt: QuickPrompt) {
    const input = this.inputElement;
    if (!input) return;
    const template = templateText(prompt.text);
    if (template !== null) {
      input.value = template;
      if (input instanceof HTMLTextAreaElement) this.autoSize(input);
      saveDraft(this.sessionId, input.value);
      this.syncComposerEmpty();
      input.focus();
      return;
    }
    input.value = prompt.text;
    this.handleSend();
  }

  /** Lets the session view bring the conversation to its end as the keyboard opens. */
  private handleComposerFocus = () => {
    this.dispatchEvent(new CustomEvent('composer-focus', { bubbles: true, composed: true }));
  };

  /** Grow the composer with its text, up to the CSS max-height (about five lines). */
  private autoSize(textarea: HTMLTextAreaElement) {
    if (!textarea.value) {
      textarea.style.height = '';
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${composerHeightFor(textarea.scrollHeight, getComputedStyle(textarea))}px`;
  }

  private handleInputKeydown(e: KeyboardEvent) {
    // Enter that confirms an IME conversion (Japanese, Chinese...) is not a send.
    if (e.isComposing || e.keyCode === 229) return;
    if (this.typeByHand(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleDismissKeyboard() {
    // Hide keyboard - user can tap input again to refocus if needed
    if (!this.inputElement) return;
    this.inputElement.blur();
  }

  private lastSentValue = '';

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (input instanceof HTMLTextAreaElement) this.autoSize(input);
    if (this.composerOnly) {
      this.updateSlashMatches(input.value);
      saveDraft(this.sessionId, input.value);
      this.syncComposerEmpty();
    }
    if (!this.onSend) return;

    // Track when user last typed - used to pause sync during active typing
    this.lastInputTime = Date.now();

    const newValue = input.value;

    // Composer: keep editing local (autocorrect and dictation rewrite freely); send on Enter.
    if (this.composerOnly) return;

    // Update pending input for InputManager (for display sync)
    this.onPendingInputChange?.(newValue);

    // Send delta to terminal (only the difference from what we already sent)
    this.sendDeltaToTerminal(newValue);
  }

  private sendDeltaToTerminal(newValue: string) {
    if (!this.onSend) return;

    const oldValue = this.lastSentValue;

    // Find common prefix length
    let commonLen = 0;
    while (
      commonLen < oldValue.length &&
      commonLen < newValue.length &&
      oldValue[commonLen] === newValue[commonLen]
    ) {
      commonLen++;
    }

    // Calculate how many characters to delete (backspaces needed)
    const charsToDelete = oldValue.length - commonLen;

    // Characters to add after the common prefix
    const charsToAdd = newValue.slice(commonLen);

    // Build the sequence: backspaces + new characters
    let sequence = '';

    // Send backspaces for deleted characters
    for (let i = 0; i < charsToDelete; i++) {
      sequence += '\x7f'; // DEL character (backspace)
    }

    // Send new characters
    sequence += charsToAdd;

    if (sequence) {
      this.onSend(sequence);
    }

    this.lastSentValue = newValue;
  }

  /** Types the composer's message (and image paths) into the terminal, then Enter. */
  private writeComposer(out: Outgoing) {
    const { command, paths } = out;
    const input = this.inputElement;
    // It leaves the box. A retry from the chat view leaves the box to the message being written
    // in it, unless that is this one again.
    if (!out.retry || input?.value.trim() === command) {
      if (input) {
        input.value = '';
        if (input instanceof HTMLTextAreaElement) this.autoSize(input);
      }
      saveDraft(this.sessionId, '');
      this.slashMatches = [];
      this.syncComposerEmpty();
    }
    if (!out.retry || (paths && this.attachmentPaths() === paths)) this.attachments.clear();
    if (!out.announced) this.announceSent(out);
    const writes = [paths, paths && command ? ` ${command}` : command].filter(Boolean);
    // Separate write so the app sees Enter as a key press, not part of the typed text.
    [...writes, '\r'].forEach((data, i) => {
      if (i === 0) this.write(out, data);
      else setTimeout(() => this.write(out, data), 50 * i);
    });
  }

  /** One write of a message; a write the session view reports as failed marks it not sent. */
  private write(out: Outgoing, data: string) {
    try {
      const result = this.onSend?.(data) as unknown;
      if (result instanceof Promise) result.catch(() => this.announceFailed(out));
    } catch {
      this.announceFailed(out);
    }
  }

  /**
   * The menu on screen right now, read when sending: the watch's copy may be a poll old, or
   * hidden for a moment after an answer while the next menu shows the same options.
   */
  private menuOnScreen(): ScreenChoices | null {
    if (!this.isAgentSession() || !this.getScreenText) return null;
    const found = this.parseScreen();
    return found?.navigate ? found : null;
  }

  /** The screen's menu, read with the terminal's layout (labels, and its key, read right). */
  private parseScreen(): ScreenChoices | null {
    return parseScreenChoices(this.getScreenText?.() ?? '', this.getScreenLayout?.());
  }

  private isAgentSession(): boolean {
    return this.claudeSession === true;
  }

  /**
   * A message for Claude waiting on a menu, sent through the server: an option's number (or a
   * yes/no letter) picks that option; anything else is a reply: Esc (Claude's "tell Claude what
   * to do differently"), then the text once Claude is back at its prompt. The message stays in
   * the box until the server says it was typed. When Claude turns out not to be waiting, it is
   * typed as usual.
   */
  private async sendToWaitingClaude(
    out: Outgoing,
    choices: ScreenChoices | null,
    option: number | null
  ) {
    const { command, paths } = out;
    const sessionId = this.sessionId;
    const [endpoint, body] =
      option !== null && choices
        ? [
            'answer',
            {
              option,
              question: choices.question,
              options: choices.options,
              key: choices.key,
            },
          ]
        : [
            'reply',
            {
              text: [paths, command].filter(Boolean).join(' '),
              question: choices?.question ?? null,
              options: choices?.options ?? null,
              key: choices?.key ?? null,
            },
          ];
    logger.log(`composer: Claude may be waiting on a menu, sent as ${endpoint}`);
    // A reply is a message of the conversation: the chat view shows it at once. An option picked
    // by its number answers the menu and is no message.
    if (endpoint === 'reply') this.announceSent(out);
    this.replyInFlight = true;
    let response: Response | null = null;
    try {
      response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify(body),
      });
    } catch {
      response = null;
    } finally {
      this.replyInFlight = false;
    }
    // Switched to another session meanwhile: its box is not this message's.
    if (this.sessionId !== sessionId) return;
    const input = this.inputElement;
    const unchanged = Boolean(input && input.value.trim() === command);
    if (response?.ok) {
      // Leave anything typed since the send.
      if (input && unchanged) {
        input.value = '';
        if (input instanceof HTMLTextAreaElement) this.autoSize(input);
        saveDraft(this.sessionId, '');
        this.syncComposerEmpty();
      }
      if (paths && (!out.retry || this.attachmentPaths() === paths)) this.attachments.clear();
      return;
    }
    const error = (
      response && !response.ok
        ? ((await response.json().catch(() => ({}))) as { error?: string })
        : {}
    ).error;
    if (error === 'not-waiting') {
      const menu = this.menuOnScreen();
      if (menu) {
        this.showMenuFirst(menu);
        this.announceFailed(out);
      } else if (unchanged || out.retry) {
        this.writeComposer(out);
      } else {
        // Edited while it was on its way: not typed after all, and the chat view says so.
        this.announceFailed(out);
      }
      return;
    }
    const note: MessageKey =
      error === 'busy'
        ? 'screenMenu.sending'
        : error === 'not-delivered'
          ? 'screenMenu.notDelivered'
          : response?.status === 409
            ? 'screenMenu.changed'
            : 'screenMenu.sendFailed';
    this.showComposerNote(t(note));
    this.announceFailed(out);
  }

  /**
   * Sends a message the safe way for what is on screen. A menu takes Enter as confirming its
   * highlighted option, whatever was typed: "Yes" sent to Claude's trust-folder dialog picked
   * "No, exit", a plan correction executed the plan, and Codex's update prompt would have run
   * "Update now". An option's number picks it; a reply to a waiting Claude goes
   * through the server; anything else waits for a tap on one of the options.
   */
  private send(out: Outgoing) {
    const menu = this.menuOnScreen();
    if (menu) {
      // A retry is a message again, never an option's number.
      const option = out.paths || out.retry ? null : optionForTyped(out.command, menu);
      if (option !== null) {
        void this.sendToWaitingClaude(out, menu, option);
      } else if (this.claudeWaiting && takesReply(menu)) {
        void this.sendToWaitingClaude(out, menu, null);
      } else {
        this.showMenuFirst(menu);
      }
      return;
    }
    // Claude waits on something this cannot read (or a yes/no question): the server answers.
    if (this.claudeWaiting) {
      const choices = this.getScreenText ? this.parseScreen() : null;
      const option =
        choices && !out.paths && !out.retry ? optionForTyped(out.command, choices) : null;
      void this.sendToWaitingClaude(out, choices, option);
      return;
    }
    logger.log(`composer: typed into the terminal (claudeWaiting=${this.claudeWaiting})`);
    this.writeComposer(out);
  }

  /**
   * "Retry" on a message the chat view shows as not sent (see claude-chat-view): sent again
   * the way a send would go now, never as an option's number, and whatever is being written in
   * the box stays there.
   */
  resendMessage(ref: SentChatMessageRef) {
    const failed = this.failedSends.get(ref.id);
    if (!this.composerOnly || ref.sessionId !== this.sessionId || !failed) return;
    if (this.replyInFlight) {
      this.showComposerNote(t('screenMenu.sending'));
      return;
    }
    this.send({ ...failed, id: ref.id, retry: true, startedAt: performance.now() });
  }

  /**
   * The chat view shows the message at once, "sending…", until the transcript has it: without
   * this, a sent message showed only once Claude Code had logged it and the chat polled again.
   */
  private announceSent(out: Outgoing) {
    out.id ??= `sent-${++sentCount}`;
    out.announced = true;
    this.failedSends.delete(out.id);
    this.dispatchEvent(
      new CustomEvent<SentChatMessage>('chat-message-sent', {
        detail: {
          sessionId: this.sessionId,
          id: out.id,
          text: [out.paths, out.command].filter(Boolean).join(' '),
          at: Date.now(),
          startedAt: out.startedAt,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** It did not go: the chat view says so and offers to send it again (resendMessage). */
  private announceFailed(out: Outgoing) {
    if (!out.announced || !out.id) return;
    this.failedSends.set(out.id, { command: out.command, paths: out.paths });
    this.dispatchEvent(
      new CustomEvent<SentChatMessageRef>('chat-message-failed', {
        detail: { sessionId: this.sessionId, id: out.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Uploaded images go in the message as their paths (Claude Code turns them into images). */
  /** Shows the menu (even one hidden after an answer) with the note to tap an option. */
  private showMenuFirst(menu: ScreenChoices) {
    if (this.menuInChat) {
      this.showComposerNote(t('screenMenu.pickFirst'));
      return;
    }
    this.answeredMenu = null;
    this.screenMenuMisses = 0;
    if (!sameShownMenu(menu, this.screenMenu)) {
      this.screenMenu = menu;
    }
    this.showScreenMenuNote(t('screenMenu.pickFirst'));
  }
  private attachmentPaths(): string {
    return this.attachments.paths.map(shellQuotePath).join(' ');
  }

  private handleSend() {
    const startedAt = performance.now();
    // Read directly from the input element to avoid reactive binding issues
    const input = this.inputElement;
    if (!input) return;

    const command = input.value.trim();

    if (this.composerOnly) {
      if (this.attachments.busy) {
        this.showComposerNote(t('attach.waitUploads'));
        return;
      }
      if (this.attachments.hasErrors) {
        this.showComposerNote(t('attach.failedSend'));
        return;
      }
      // Typed first and in a write of their own.
      const paths = this.attachmentPaths();
      if (!command && !paths) return;
      // The message the chat view shows as not sent, sent again from the box: the same bubble.
      const failed = [...this.failedSends].find(
        ([, sent]) => sent.command === command && sent.paths === paths
      );
      // A second send while the first is on its way would answer whatever comes next.
      if (this.replyInFlight) {
        this.showComposerNote(t('screenMenu.sending'));
        return;
      }
      this.send({ command, paths, startedAt, id: failed?.[0] });
      return;
    }

    if (!command) return;

    // Add command to chat
    this.addMessage('command', command);

    // Send Enter to execute the command (characters were already sent via delta)
    if (this.onSend) {
      this.onSend('\r');
    }

    // Clear input directly on the DOM element
    input.value = '';
    this.lastSentValue = '';

    // Clear pending input in InputManager
    this.onPendingInputChange?.('');

    // Scroll to show the sent message
    this.scrollToBottom();
  }
}
