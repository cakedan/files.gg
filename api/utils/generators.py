import time

from collections import namedtuple

bits_datacenter = 5
bits_worker = 5
bits_sequence = 12

shift_timestamp = bits_datacenter + bits_worker + bits_sequence
shift_datacenter = bits_worker + bits_sequence
shift_worker = bits_sequence

max_datacenter = -1 ^ (-1 << bits_datacenter)
max_worker = -1 ^ (-1 << bits_worker)
max_sequence = -1 ^ (-1 << bits_sequence)


class Snowflake:
    epoch = 0
    worker_id = 0
    datacenter_id = 0
    sequence = 0

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
    def get_timestamp(cls):
        return int(time.time() * 1000) - cls.epoch

    @classmethod
    def get_next_sequence(cls):
        if cls.sequence < max_sequence:
            cls.sequence = cls.sequence + 1
        else:
            cls.sequence = 0
        return cls.sequence

    @classmethod
    def generate(cls):
        timestamp = cls.get_timestamp()
        datacenter_id = cls.datacenter_id
        worker_id = cls.worker_id
        sequence = cls.get_next_sequence()
        return int(
            (timestamp << shift_timestamp) |
            (datacenter_id << shift_datacenter) |
            (worker_id << shift_worker) |
            sequence
        )
