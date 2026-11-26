import { useMyLimits } from '../../lib/queries';
import { adultRegionBlocked } from '../../lib/upload/options';
import { useAuthConfig } from '../auth/authUtils';

export { ADULT_REGION_TEXT } from '../../lib/upload/options';

/**
 * Milestone 7 §11.4: adult content isn't available from the visitor's country, so the places that
 * offer it show ADULT_REGION_TEXT instead. Signed in, `/users/@me/limits`' `adult_region_blocked`;
 * signed out, `/auth/config`'s `adult_content_available`. False while either is loading.
 */
export function useAdultRegionBlocked(signedIn: boolean): boolean {
  const limits = useMyLimits(signedIn);
  const config = useAuthConfig(!signedIn);
  return adultRegionBlocked({
    anonymous: !signedIn,
    limits: signedIn ? (limits.data ?? null) : null,
    adultContentAvailable: config.data?.adult_content_available,
  });
}
