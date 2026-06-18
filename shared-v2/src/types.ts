export interface QueueMessage {
  kind: "telegram_update" | "fuel_alert";
  payload: TelegramUpdate | { events: FuelEvent[] };
  ts: number;
}

export interface FuelEvent {
  name: string;
  company: string;
  litros: number;
  lat?: number;
  lon?: number;
  waze?: string | null;
  kind: "alert" | "reminder";
  since: number | null;
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
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  caption?: string;
  location?: { latitude: number; longitude: number };
  reply_to_message?: TelegramMessage;
  web_app_data?: { data: string; button_text: string };
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
