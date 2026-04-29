export interface QueueMessage {
  kind: "telegram_update";
  payload: TelegramUpdate;
  ts: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  date: number;
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface MenuState {
  section: string;
  taskIds?: string[];
  ts: number;
}
