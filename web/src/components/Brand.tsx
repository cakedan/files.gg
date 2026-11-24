interface BrandProps {
  className?: string;
}

/** The mark + wordmark lockup (branding/filesgg-lockup.svg), 315×76. */
export function Lockup({ className = 'h-8 w-auto' }: BrandProps) {
  return <img src="/assets/brand/filesgg-lockup.svg" width={315} height={76} alt="files.gg" className={className} />;
}

/** The folded-tile mark alone. Uses the small variant below 48 px, per branding/README.md. */
export function Mark({ className = 'size-8', small = false }: BrandProps & { small?: boolean }) {
  const src = small ? '/assets/brand/filesgg-mark-small.svg' : '/assets/brand/filesgg-mark.svg';
  return <img src={src} width={64} height={64} alt="files.gg" className={className} />;
}
