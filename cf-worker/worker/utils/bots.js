// Every user-agent rule the Worker has for bots, in one place. Pure, so it is unit-tested.
//
//   - The CDN redirect for `link` files (utils/pages.js, docs/redesign/PLAN.md §1.4 item 3): ShareX
//     always, and of the user agents calling themselves a bot, only Telegram's.
//   - The view-limit refusal (utils/viewlimits.js, milestone-6.md §19.5 and §19.7a): ShareX, anything
//     calling itself a bot, and the link-preview fetchers below, which don't.

// ShareX (its uploads and its previews).
export const SHAREX_USER_AGENT = /sharex/i;
// Anything calling itself a bot.
export const BOT_USER_AGENT = /bot/i;
// The one bot that gets the CDN redirect for `link` files.
export const TELEGRAM_BOT_USER_AGENT = /telegrambot/i;

// Link-preview fetchers without "bot" in their user agent (milestone-6.md §19.7a), matched as
// case-insensitive substrings.
export const LINK_PREVIEW_FETCHERS = Object.freeze([
  'facebookexternalhit',
  'Facebot',
  'WhatsApp',
  'Slack-ImgProxy',
  'SkypeUriPreview',
  'Embedly',
  'Iframely',
  'vkShare',
  'Mastodon',
  'Bluesky Cardyb',
  'Google-InspectionTool',
]);

const LOWER_FETCHERS = LINK_PREVIEW_FETCHERS.map((name) => name.toLowerCase());

export function isShareX(userAgent) {
  return SHAREX_USER_AGENT.test(String(userAgent || ''));
}

export function callsItselfABot(userAgent) {
  return BOT_USER_AGENT.test(String(userAgent || ''));
}

export function isTelegramBot(userAgent) {
  return TELEGRAM_BOT_USER_AGENT.test(String(userAgent || ''));
}

// A user agent that fetches pages to build a link preview: ShareX, anything calling itself a bot,
// or one of LINK_PREVIEW_FETCHERS.
export function isLinkPreviewUserAgent(userAgent) {
  const value = String(userAgent || '');
  if (isShareX(value) || callsItselfABot(value)) {
    return true;
  }
  const lower = value.toLowerCase();
  return LOWER_FETCHERS.some((name) => lower.includes(name));
}
