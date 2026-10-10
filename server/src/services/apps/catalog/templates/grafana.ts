import { field, secretField, type BuiltinTemplate } from './types';

export const grafana: BuiltinTemplate = {
  slug: 'grafana',
  name: 'Grafana',
  icon: 'line-chart',
  category: 'monitoring',
  description: 'Dashboards and visualisation (OSS edition).',
  docsUrl: 'https://grafana.com/docs/grafana/latest/',
  version: '11.2.0-1',
  defaultProxy: { service: 'grafana', port: 3000 },
  minMemoryMb: 256,
  enabled: true,
  fields: [
    field({ key: 'GF_ADMIN_USER', label: 'Administrator login', type: 'string', required: true, default: 'admin', pattern: '^[A-Za-z0-9._-]{1,64}$' }),
    secretField('GF_ADMIN_PASSWORD', 'Administrator password'),
    field({ key: 'GF_ROOT_URL', label: 'Public URL', type: 'url', required: false, description: 'e.g. https://grafana.example.com' }),
  ],
  composeYaml: `services:
  grafana:
    image: grafana/grafana-oss:11.2.0
    restart: unless-stopped
    ports: ["3000"]
    environment:
      GF_SECURITY_ADMIN_USER: \${GF_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: \${GF_ADMIN_PASSWORD:?}
      GF_SERVER_ROOT_URL: \${GF_ROOT_URL:-}
    volumes:
      - data:/var/lib/grafana
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 384m}
volumes:
  data: {}
`,
};
