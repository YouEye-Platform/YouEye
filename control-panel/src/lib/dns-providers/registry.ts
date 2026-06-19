import type { DnsProviderDefinition, DnsProviderId } from './types';

export const DNS_PROVIDER_DEFINITIONS: DnsProviderDefinition[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    tokenLabel: 'Cloudflare API token',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    requiredPermissions: ['Zone - Zone - Read', 'Zone - DNS - Edit'],
    capabilities: {
      aRecords: true,
      wildcardRecords: true,
      txtRecords: true,
      zoneAutoDetect: true,
    },
    helpSteps: [
      {
        title: 'Open API Tokens',
        body: 'In Cloudflare, open My Profile, then API Tokens.',
      },
      {
        title: 'Create a scoped token',
        body: 'Use the Edit zone DNS template and scope it to the DNS zone for this domain.',
      },
      {
        title: 'Grant two permissions',
        body: 'The token needs Zone - Zone - Read and Zone - DNS - Edit.',
      },
      {
        title: 'Paste once',
        body: 'YouEye stores the token locally as a server secret and will not show it again.',
      },
    ],
  },
];

export function getProviderDefinition(id: DnsProviderId): DnsProviderDefinition {
  const provider = DNS_PROVIDER_DEFINITIONS.find((item) => item.id === id);
  if (!provider) throw new Error(`Unsupported DNS provider: ${id}`);
  return provider;
}
