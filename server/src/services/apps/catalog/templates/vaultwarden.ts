import { field, secretField, type BuiltinTemplate } from './types';

export const vaultwarden: BuiltinTemplate = {
  slug: 'vaultwarden',
  name: 'Vaultwarden',
  icon: 'shield',
  category: 'security',
  description: 'Bitwarden-compatible password manager server.',
  docsUrl: 'https://github.com/dani-garcia/vaultwarden/wiki',
  version: '1.32.0-1',
  defaultProxy: { service: 'vaultwarden', port: 80 },
  minMemoryMb: 128,
  enabled: true,
  fields: [
    field({ key: 'DOMAIN', label: 'Public URL', type: 'url', required: true, description: 'e.g. https://vault.example.com' }),
    field({ key: 'SIGNUPS_ALLOWED', label: 'Allow sign-ups', type: 'boolean', default: false }),
    secretField('ADMIN_TOKEN', 'Admin panel token', 'base64-32'),
  ],
  composeYaml: `services:
  vaultwarden:
    image: vaultwarden/server:1.32.0
    restart: unless-stopped
    ports: ["80"]
    environment:
      DOMAIN: \${DOMAIN:?}
      SIGNUPS_ALLOWED: \${SIGNUPS_ALLOWED:-false}
      ADMIN_TOKEN: \${ADMIN_TOKEN:?}
      WEBSOCKET_ENABLED: "true"
    volumes:
      - data:/data
    cap_add: [NET_BIND_SERVICE]
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 256m}
volumes:
  data: {}
`,
};
