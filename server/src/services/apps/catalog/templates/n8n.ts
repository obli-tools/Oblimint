import { field, secretField, type BuiltinTemplate } from './types';

export const n8n: BuiltinTemplate = {
  slug: 'n8n',
  name: 'n8n',
  icon: 'workflow',
  category: 'automation',
  description: 'Workflow automation (SQLite storage).',
  docsUrl: 'https://docs.n8n.io/',
  version: '1.62.1-1',
  defaultProxy: { service: 'n8n', port: 5678 },
  minMemoryMb: 512,
  enabled: true,
  fields: [
    field({ key: 'N8N_HOST', label: 'Domain of the instance', type: 'domain', required: true, description: 'e.g. n8n.example.com' }),
    field({ key: 'GENERIC_TIMEZONE', label: 'Time zone', type: 'string', default: 'Europe/Paris', pattern: '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)?(/[A-Za-z0-9_+-]+)?$' }),
    secretField('N8N_ENCRYPTION_KEY', 'Encryption key', 'hex32'),
  ],
  composeYaml: `services:
  n8n:
    image: n8nio/n8n:1.62.1
    restart: unless-stopped
    ports: ["5678"]
    environment:
      N8N_HOST: \${N8N_HOST:?}
      N8N_PROTOCOL: https
      N8N_PORT: "5678"
      WEBHOOK_URL: https://\${N8N_HOST:?}/
      GENERIC_TIMEZONE: \${GENERIC_TIMEZONE:-Europe/Paris}
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY:?}
      N8N_DIAGNOSTICS_ENABLED: "false"
    volumes:
      - data:/home/node/.n8n
    deploy:
      resources:
        limits: {cpus: "1", memory: 768m}
volumes:
  data: {}
`,
};
