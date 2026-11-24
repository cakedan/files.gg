import { Link } from 'react-router';

export default function NotFoundPage() {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted">There's nothing at this address in the dashboard.</p>
      <Link to="/" className="mt-2 text-gg hover:underline">
        Back to Overview
      </Link>
    </section>
  );
}
