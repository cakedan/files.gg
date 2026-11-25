// Bot and embed routing: which files.gg/<vanity> requests go straight to the file's cdn_url
// instead of the viewer page (docs/redesign/PLAN.md §1.4 item 3). Pure, so it is unit-tested.
// The user-agent rules are utils/bots.js's, shared with the view-limit refusal.

import { callsItselfABot, isShareX, isTelegramBot } from './bots.js';


export const EMBED_MIMETYPES = Object.freeze({
  audio: ['audio/mpeg', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-pn-wav', 'audio/x-wav'],
  image: ['image/png', 'image/x-citrix-png', 'image/x-png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/x-citrix-jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/ogg', 'video/avi', 'video/msvideo'],
});


// True when files.gg/<vanity> should 302 to the CDN instead of rendering the page:
// ShareX and Telegram, requests without Accept-Language or Accept, and `Accept: <type>/*` embeds.
export function shouldRedirectToCdn(headers, file) {
  const userAgent = headers.get('user-agent') || '';
  const mime = file.mimetype.split('/').shift();

  if (isShareX(userAgent)) {
    return true;
  }
  if (callsItselfABot(userAgent)) {
    // deal with special bots here
    return isTelegramBot(userAgent);
  }
  if (!headers.get('accept-language')) {
    // might be a forum embed, browsers usually have this when initially requesting
    return true;
  }

  const accepted = (headers.get('accept') || '').split(',').map((x) => x.split(';').shift().trim()).filter((v) => v);
  // Browsers always have this header, redirect if not here
  if (!accepted.length) {
    return true;
  }

  // Check if this is a forum embed request ({type}/*)
  return (mime in EMBED_MIMETYPES) && accepted.some((x) => x === `${mime}/*`);
}
