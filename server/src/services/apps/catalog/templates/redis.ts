import { secretField, type BuiltinTemplate } from './types';

export const redis: BuiltinTemplate = {
  slug: 'redis',
  name: 'Redis',
  icon: 'database',
  category: 'database',
  description: 'In-memory key-value store (password protected, AOF persistence). Reach it from another app through a network link.',
  docsUrl: 'https://redis.io/docs/',
  version: '7.4-1',
  defaultProxy: null,
  minMemoryMb: 128,
  enabled: true,
  fields: [secretField('REDIS_PASSWORD', 'Password', 'hex32')],
  composeYaml: `services:
  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--requirepass", "\${REDIS_PASSWORD:?}"]
    expose: ["6379"]
    environment:
      REDISCLI_AUTH: \${REDIS_PASSWORD:?}
    volumes:
      - data:/data
    cap_add: [CHOWN, SETGID, SETUID]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits: {cpus: "0.25", memory: 256m}
volumes:
  data: {}
`,
};
