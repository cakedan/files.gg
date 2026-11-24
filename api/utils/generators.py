import threading
import time

# The bit layout and epoch are part of every id already stored in production.
# Do not change them.
#
#   63      22 21        17 16    12 11        0
#   timestamp | datacenter | worker | sequence
#
# datacenter + worker (10 bits) are treated as one "node id", leased per
# process from Postgres (see utils/snowflake_nodes.py).

EPOCH = 1550102400000  # 2019-02-14T00:00:00Z, in milliseconds

bits_datacenter = 5
bits_worker = 5
bits_sequence = 12
bits_node = bits_datacenter + bits_worker

shift_timestamp = bits_datacenter + bits_worker + bits_sequence
shift_datacenter = bits_worker + bits_sequence
shift_worker = bits_sequence
shift_node = bits_sequence

max_datacenter = -1 ^ (-1 << bits_datacenter)
max_worker = -1 ^ (-1 << bits_worker)
max_sequence = -1 ^ (-1 << bits_sequence)
max_node = -1 ^ (-1 << bits_node)

# If the wall clock is behind the last timestamp by more than this when the
# sequence overflows, borrow the next millisecond instead of spinning.
MAX_CLOCK_WAIT_MS = 5


def _now_ms():
    return int(time.time() * 1000)


class Snowflake:
    epoch = EPOCH
    worker_id = 0
    datacenter_id = 0
    sequence = 0

    # Optional callable returning the current node id. When set (by a
    # snowflake_nodes.NodeLease), it overrides worker_id/datacenter_id and
    # raises if this process no longer holds a valid lease.
    node_provider = None

    _lock = threading.Lock()
    _last_timestamp = -1

    @classmethod
    def set_epoch(cls, epoch):
        cls.epoch = epoch

    @classmethod
    def set_worker_id(cls, worker_id):
        cls.worker_id = worker_id & max_worker

    @classmethod
    def set_datacenter_id(cls, datacenter_id):
        cls.datacenter_id = datacenter_id & max_datacenter

    @classmethod
    def set_node_id(cls, node_id):
        if not 0 <= node_id <= max_node:
            raise ValueError('node id must be between 0 and {}'.format(max_node))
        cls.datacenter_id = node_id >> bits_worker
        cls.worker_id = node_id & max_worker

    @classmethod
    def set_node_provider(cls, provider):
        cls.node_provider = provider

    @classmethod
    def get_node_id(cls):
        if cls.node_provider is not None:
            return cls.node_provider()
        return (cls.datacenter_id << bits_worker) | cls.worker_id

    @classmethod
    def get_timestamp(cls):
        return _now_ms() - cls.epoch

    @classmethod
    def _wait_next_millisecond(cls, last_timestamp):
        # Busy-wait (no sleep, no await) while holding the lock, so generate()
        # stays synchronous and never yields to the event loop: at most ~1ms.
        while True:
            timestamp = cls.get_timestamp()
            if timestamp > last_timestamp:
                return timestamp
            if last_timestamp - timestamp > MAX_CLOCK_WAIT_MS:
                # the clock went backwards a lot; borrow the next millisecond
                return last_timestamp + 1

    @classmethod
    def generate(cls):
        with cls._lock:
            # node_provider must not do I/O: it only checks in-memory lease state
            node_id = cls.get_node_id()
            timestamp = cls.get_timestamp()
            last_timestamp = cls._last_timestamp
            if timestamp < last_timestamp:
                # clock moved backwards: keep using the last timestamp
                timestamp = last_timestamp

            if timestamp == last_timestamp:
                sequence = (cls.sequence + 1) & max_sequence
                if sequence == 0:
                    timestamp = cls._wait_next_millisecond(last_timestamp)
            else:
                sequence = 0

            cls.sequence = sequence
            cls._last_timestamp = timestamp

        return int(
            (timestamp << shift_timestamp) |
            (node_id << shift_node) |
            sequence
        )

    @classmethod
    def decode(cls, snowflake):
        snowflake = int(snowflake)
        timestamp = snowflake >> shift_timestamp
        return {
            'timestamp': timestamp + cls.epoch,
            'datacenter_id': (snowflake >> shift_datacenter) & max_datacenter,
            'worker_id': (snowflake >> shift_worker) & max_worker,
            'node_id': (snowflake >> shift_node) & max_node,
            'sequence': snowflake & max_sequence,
        }
