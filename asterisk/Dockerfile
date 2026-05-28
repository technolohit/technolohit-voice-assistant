FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      software-properties-common \
      ca-certificates \
      gettext-base \
 && add-apt-repository universe \
 && apt-get update \
 && apt-get install -y --no-install-recommends asterisk \
 && rm -rf /var/lib/apt/lists/*

COPY templates/ /etc/asterisk/templates/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY easybell-registration-keeper.sh /usr/local/bin/easybell-registration-keeper.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/easybell-registration-keeper.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
