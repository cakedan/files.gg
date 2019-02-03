import importlib
import os

directory = 'server/endpoints'
directory_name = directory.replace('/', '.')
for name in os.listdir(directory):
    if not (name.startswith('e_') and name.endswith('.py')):
        continue
    name = '{}.{}'.format(directory_name, name[:-3])
    importlib.import_module(name)
del name
del directory
del directory_name