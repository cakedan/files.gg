"""Job functions for tests/test_convert_worker.py, imported by the work horses of a real `rq worker-pool` (so this
module imports nothing from the test setup)."""

import asyncio
import time


def record(name):
    """Note that this job ran, in order."""
    from utils.redis import get_sync
    get_sync().rpush('test:order', name)


async def raise_with_busy_executor():
    """Hands the default executor a long task, then raises: rq 3's `asyncio.run` would wait for the task before
    the horse could exit (notsobot's `NotSoJob` fix, convert_worker.ConvertJob)."""
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, time.sleep, 60)
    await asyncio.sleep(0.1)
    raise ValueError('the job failed')


def record_node(name, hold=1.5):
    """Which Snowflake node this horse generates ids with, and the static fallback's, while holding it a moment so
    two pools' horses overlap (the duplicate-id regression)."""
    from utils.generators import Snowflake
    from utils.redis import get_sync
    connection = get_sync()
    leased = Snowflake.node_provider is not None
    node = Snowflake.get_node_id()
    Snowflake.generate()
    connection.rpush('test:nodes', '{}:{}:{}'.format(name, node, int(leased)))
    time.sleep(hold)
