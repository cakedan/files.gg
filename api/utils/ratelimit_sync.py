"""`safety_rate_limits` windows from synchronous code (the domain API runs in a thread)."""

WINDOWS = {'minute': 60, 'hour': 3600, 'day': 86400}


def hit(conn, scope, key, window='hour'):
    """Count one in the current window: (count, seconds until it ends)."""
    row = conn.execute(
        'INSERT INTO safety_rate_limits AS r (scope, key, window_start, count) '
        'VALUES (%s, %s, date_trunc(%s, now()), 1) '
        'ON CONFLICT (scope, key, window_start) DO UPDATE SET count = r.count + 1 '
        'RETURNING count, ceil(extract(epoch FROM (window_start + make_interval(secs => %s) - now())))::int',
        (scope, key, window, WINDOWS[window])).fetchone()
    return row[0], max(1, row[1])
