import { SignUpAgreement } from '../../components/TermsAgreement';
import { useMinimumAge } from './authUtils';

/** The sign-up agreement with the visitor's minimum age from `/auth/config` (milestone-7 §11.4). */
export function SignUpTerms() {
  const minimumAge = useMinimumAge();
  return <SignUpAgreement minimumAge={minimumAge} />;
}
