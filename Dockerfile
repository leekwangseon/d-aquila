FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV D_AQUILA_PROMETHEUS_URL=http://localhost:9090
ENV D_AQUILA_ENABLE_SUBMIT=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libpam-modules \
      libpam0g \
      munge \
      slurm-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

EXPOSE 8000

CMD ["uvicorn", "backend.d_aquila:app", "--host", "0.0.0.0", "--port", "8000"]
