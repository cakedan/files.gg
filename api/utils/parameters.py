def snowflake(snowflake_id):
  try:
    snowflake_id = int(snowflake_id)
  except:
    raise ValueError('{} is not a valid snowflake'.format(snowflake_id))
  if snowflake_id < 0 or 9223372036854775807 < snowflake_id:
    raise ValueError('snowflake value should be 0 <= snowflake and snowflake <= 9223372036854775807')
  return snowflake_id
