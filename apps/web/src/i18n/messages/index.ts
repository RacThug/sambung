import type { Locale } from "../locale";
import { en, type Messages, type MessageKey } from "./en";
import { id } from "./id";
import { zh } from "./zh";

export type { Messages, MessageKey };

/** The catalog, keyed by locale. `messages[locale][key]` is always a `string`
 * because `id`/`zh` are typed `Messages` (ADR-0024). */
export const messages: Record<Locale, Messages> = { en, id, zh };
