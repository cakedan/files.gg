import json

from flask import request
from api.library.responses import APIError


class FilteredData:
    def get(self, key, default=None):
        return getattr(self, key, default)

    def set(self, key, value):
        return setattr(self, key, value)

    def to_dict(self):
        return self.__dict__


def filter_data(include_args=False, include_form=False, ignore_json=False, **template):
    def decorator(func):
        def wrapped(*args, **kwargs):
            try:
                if ignore_json:
                    data = None
                else:
                    data = request.get_json(silent=True)
                if data is None:
                    if not include_args and not include_form:
                        raise APIError(status=400)
                    data = {}

                if isinstance(data, dict):
                    if include_args:
                        for key in request.args:
                            data[key] = request.args[key]
                    if include_form:
                        for key in request.form:
                            data[key] = request.form[key]
                        if not request.is_json:
                            if 'payload_json' in data:
                                try:
                                    payload_json = json.load(data['payload_json'])
                                except:
                                    raise APIError(status=400)
                                if not isinstance(payload_json, dict):
                                    raise APIError(status=400)

                                for key in payload_json:
                                    data[key] = payload_json[key]
                else:
                    raise APIError(status=400)

                filtered = FilteredData()
                for key in template:
                    wanted = template[key]
                    if isinstance(wanted, dict):
                        if key not in data:
                            if wanted.get('required'):
                                raise APIError(status=400)
                            data[key] = wanted.get('default')

                        if wanted.get('type'):
                            wanted_type = wanted['type']
                    else:
                        wanted_type = wanted

                    if data.get(key) is not None and wanted_type is not None:
                        if wanted_type == int:
                            data[key] = int(data[key])
                        elif wanted_type == float:
                            data[key] = float(data[key])
                        elif wanted_type == str:
                            data[key] = str(data[key])
                        elif wanted_type == bool:
                            if isinstance(data[key], str):
                                data[key] = bool(data[key].lower() == 'true')
                            else:
                                data[key] = bool(data[key])
                        elif not isinstance(data[key], wanted_type):
                            raise APIError(status=400)

                    filtered.set(key, data.get(key))

                kwargs['data'] = filtered
                return func(*args, **kwargs)
            except Exception as error:
                if isinstance(error, APIError):
                    raise error
                raise APIError(message=str(error), status=400)

        wrapped.__name__ = func.__name__
        return wrapped
    return decorator
