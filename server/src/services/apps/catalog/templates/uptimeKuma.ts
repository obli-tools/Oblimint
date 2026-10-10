import type { BuiltinTemplate } from './types';

export const uptimeKuma: BuiltinTemplate = {
  slug: 'uptime-kuma',
  name: 'Uptime Kuma',
  icon: 'activity',
  category: 'monitoring',
  description: 'Self-hosted uptime monitoring with status pages.',
  docsUrl: 'https://github.com/louislam/uptime-kuma/wiki',
  version: '1.23.13-1',
  defaultProxy: { service: 'uptime-kuma', port: 3001 },
  minMemoryMb: 256,
  enabled: true,
  fields: [],
  composeYaml: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1.23.13
    restart: unless-stopped
    ports: ["3001"]
    volumes:
      - data:/app/data
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 384m}
volumes:
  data: {}
`,
};
