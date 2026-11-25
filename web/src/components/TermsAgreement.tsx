import { PRIVACY_PATH, TERMS_PATH } from './SiteFooter';

const link = 'text-gg hover:underline';

/** Under **Create account**, on email and Discord sign-up (milestone-5 §19.2). No checkbox: the button is the agreement. */
export function SignUpAgreement() {
  return (
    <p className="text-center text-xs text-muted">
      By creating an account, you agree to the{' '}
      <a href={TERMS_PATH} className={link}>
        Terms
      </a>{' '}
      and the{' '}
      <a href={PRIVACY_PATH} className={link}>
        Privacy Policy
      </a>
      , and confirm you’re 13 or older.
    </p>
  );
}

/** Under the button of an anonymous upload or conversion (milestone-5 §19.2). */
export function UploadAgreement({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-muted ${className}`}>
      By uploading, you agree to the{' '}
      <a href={TERMS_PATH} className={link}>
        Terms
      </a>
      .
    </p>
  );
}
