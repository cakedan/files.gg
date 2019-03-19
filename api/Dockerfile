FROM python:3.7-alpine

WORKDIR /api

ADD requirements.txt ./
RUN apk update \
  && apk add --virtual build-deps gcc python3-dev musl-dev \
  && apk add postgresql-dev \
  && pip install --no-cache-dir -r requirements.txt \
  && apk del build-deps

ADD . .
CMD ["gunicorn", "app:app", "--worker-class=gevent", "--workers=4", "--log-level=debug", "--bind=0.0.0.0:8080"]