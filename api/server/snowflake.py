import time

'''
	Offset from Unix Epoch
	Unix Epoch : January 1 1970 00:00:00 GMT
	Epoch Offset : April 1 2018 00:00:00 GMT
'''

class SnowflakeGenerator:
	def __init__(self, **kwargs):
		self.bits_datacenter = 5
		self.bits_worker = 5
		self.bits_sequence = 12

		self.shift_timestamp = self.bits_datacenter + self.bits_worker + self.bits_sequence
		self.shift_datacenter = self.bits_worker + self.bits_sequence
		self.shift_worker = self.bits_sequence

		self.epoch_offset = kwargs.pop('epoch_offset', 1522540800000)
		self.datacenter_id = kwargs.pop('datacenter_id', 0)
		self.worker_id = kwargs.pop('worker_id', 0)

		self.max_sequence = -1 ^ (-1 << self.bits_sequence)
		self.sequence = 0

	def generate(self):
		timestamp = int(self.get_unix_timestamp() - self.epoch_offset)
		sequence = self.get_next_sequence(timestamp)
		return int(
			(timestamp << self.shift_timestamp) |
			(self.datacenter_id << self.shift_datacenter) |
			(self.worker_id << self.shift_worker) |
			sequence
		)

	def get_unix_timestamp(self):
		return int(time.time() * 1000)

	def get_next_sequence(self, timestamp):
		self.sequence = 0 if self.sequence == self.max_sequence else self.sequence + 1
		return self.sequence