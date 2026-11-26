/**
 * Транспорт-независимый слой Telegram. Вся логика (привязки, роли, карточки, колбэки) работает
 * через эти интерфейсы; grammY подключается тонким адаптером в worker/.
 */
export interface Button {
  text: string;
  /** callback_data, до 64 байт. */
  data: string;
}

export interface Messenger {
  send(chatId: string, text: string, buttons?: Button[][]): Promise<{ messageId: string }>;
  edit(chatId: string, messageId: string, text: string, buttons?: Button[][]): Promise<void>;
}

/** Короткоживущее состояние диалога (например, «жду текст правки»). Redis в воркере, память в тестах. */
export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryState implements StateStore {
  private readonly m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async del(k: string) {
    this.m.delete(k);
  }
}

/** Экранирование для parse_mode=HTML. Весь пользовательский и LLM-текст проходит через него. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
