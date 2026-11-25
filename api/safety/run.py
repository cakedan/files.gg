"""Running the synchronous trust & safety code (safety/core.py and friends) from the async API:
in a worker thread, on its own sync connection, inside one transaction. Staff actions, reports
and notices are rare enough that a connection per call costs nothing that matters, and every
rule keeps one implementation shared with the worker."""

import asyncio
import functools

import db


def _call(func, args, kwargs, transaction):
    with db.connect() as conn:
        if not transaction:
            return func(conn, *args, **kwargs)
        with conn.transaction():
            return func(conn, *args, **kwargs)


async def in_thread(func, *args, transaction=True, **kwargs):
    """`func(conn, *args, **kwargs)` in a thread; its return value, or its exception."""
    return await asyncio.get_running_loop().run_in_executor(
        None, functools.partial(_call, func, args, kwargs, transaction))


async def plain(func, *args, **kwargs):
    """Any blocking call (S3 through boto3, ...) in a thread."""
    return await asyncio.get_running_loop().run_in_executor(None, functools.partial(func, *args, **kwargs))
