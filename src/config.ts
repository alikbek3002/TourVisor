import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralized, validated configuration.
 *
 * Every external integration is optional at boot so the service can start in a
 * partially-configured state (useful during setup / local dev). At runtime each
 * module checks whether its own config is present and degrades gracefully,
 * logging a clear warning instead of crashing the whole process.
 */

const bool = (def = false) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Public base URL of THIS backend (used to auto-register the WAHA webhook). */
  PUBLIC_URL: z.string().url().optional(),

  // --- Claude (Anthropic) ---
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5'),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(1024),

  // --- Tourvisor ---
  TOURVISOR_BASE_URL: z.string().url().default('https://tourvisor.ru/xml'),
  TOURVISOR_AUTH_LOGIN: z.string().optional(),
  TOURVISOR_AUTH_PASS: z.string().optional(),
  /** Default departure city id (Tourvisor `departure` reference id). */
  TOURVISOR_DEFAULT_DEPARTURE: z.string().optional(),
  /** Search currency: 0=RUB, 1=USD/EUR, 2=BYN, 3=KZT. */
  TOURVISOR_CURRENCY: z.enum(['0', '1', '2', '3']).default('0'),
  /**
   * Link template for tour results, e.g. https://lalatravel.kg/podbor-tura or
   * https://lalatravel.kg/podbor-tura#tvcartid={cartid}. Placeholders:
   * {cartid} (Tourvisor module cart id — needs TOURVISOR_MODULE_ID), {tourid},
   * {hotelcode}. When unset, falls back to Tourvisor's own link.
   */
  TOUR_LINK_TEMPLATE: z.string().optional(),
  /**
   * Tourvisor search-module id of the agency's site (from the module embed,
   * e.g. `moduleid-9957396`). Enables building per-tour {cartid} deep links.
   */
  TOURVISOR_MODULE_ID: z.string().optional(),

  // --- WAHA (WhatsApp HTTP API) ---
  WAHA_BASE_URL: z.string().url().default('http://localhost:3000'),
  WAHA_API_KEY: z.string().optional(),
  WAHA_SESSION: z.string().default('default'),
  /** Optional shared secret we require on the incoming webhook path. */
  WAHA_WEBHOOK_SECRET: z.string().optional(),
  /**
   * If true, the bot registers its own webhook on the WAHA session at startup
   * (needs PUBLIC_URL). Leave false when WAHA is configured with its own
   * WHATSAPP_HOOK_URL (recommended on Railway) to avoid duplicate deliveries.
   */
  WAHA_AUTOREGISTER: bool(false),

  // --- Telegram (admin alerts) ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Chat id(s) (comma-separated) that receive alerts and may control the bot. */
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  // --- Business / handoff ---
  COMPANY_NAME: z.string().default('Aisuluu Travel'),
  MANAGER_NAME: z.string().default('менеджер'),
  /** Manager phone in international format w/o + (e.g. 996555123456) for wa.me links. */
  MANAGER_WHATSAPP: z.string().optional(),

  /** Comma-separated WhatsApp chatIds/phones allowed to use the bot (empty = everyone). */
  ALLOWLIST: z.string().optional(),

  DISABLE_AI: bool(false),

  /**
   * Debounce window (ms) for batching client messages: after a message, wait
   * this long for more before replying, so a client typing several messages in
   * a row gets ONE coherent answer instead of a reply per line. The timer resets
   * on each new message. 0 disables batching (reply immediately). E.g. 40000.
   */
  MESSAGE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(0),

  /**
   * Postgres connection string for durable conversation storage. When unset the
   * bot keeps conversations in memory only (lost on restart). On Railway, add a
   * Postgres service and reference its DATABASE_URL.
   */
  DATABASE_URL: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

const adminChatIds = (env.TELEGRAM_ADMIN_CHAT_ID ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  allowlist: (env.ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Telegram chat ids (admins) that receive alerts and may control the bot. */
  adminChatIds,
  features: {
    claude: Boolean(env.ANTHROPIC_API_KEY) && !env.DISABLE_AI,
    tourvisor: Boolean(env.TOURVISOR_AUTH_LOGIN && env.TOURVISOR_AUTH_PASS),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN) && adminChatIds.length > 0,
    postgres: Boolean(env.DATABASE_URL),
  },
} as const;

export type Config = typeof config;
