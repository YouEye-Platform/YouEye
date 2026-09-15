import { incusRequest } from '@/lib/incus/server';
import { getSystemStaticIP } from '@/lib/incus/static-ips';

const UI_EGRESS_ACL = 'ye-ui-egress-block';

type InstanceMetadata = {
  devices: Record<string, Record<string, string>>;
};

export async function repairControlPanelProxy(): Promise<void> {
  const res = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-control');
  const devices = { ...(res.metadata.devices || {}) };
  devices.port3000 = {
    type: 'proxy',
    bind: 'host',
    listen: 'tcp:127.0.0.1:3000',
    connect: 'tcp:127.0.0.1:3000',
  };
  await incusRequest('PATCH', '/1.0/instances/youeye-control', { devices });

  const verify = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-control');
  const device = verify.metadata.devices?.port3000;
  if (
    !device ||
    device.listen !== 'tcp:127.0.0.1:3000' ||
    device.connect !== 'tcp:127.0.0.1:3000' ||
    device.bind !== 'host'
  ) {
    throw new Error('Control Panel port3000 proxy did not verify as localhost-only');
  }
}

export async function repairUIEgressAcl(): Promise<void> {
  const [controlIP, pointerIP] = await Promise.all([
    getSystemStaticIP('youeye-control'),
    getSystemStaticIP('youeye-pointer'),
  ]);
  if (!controlIP || !pointerIP) throw new Error('Cannot resolve core service static IPs');

  const body = {
    name: UI_EGRESS_ACL,
    description: 'Block UI container from reaching Control Panel services',
    ingress: [] as unknown[],
    egress: [
      {
        action: 'reject',
        protocol: 'tcp',
        destination: `${controlIP}/32`,
        destination_port: '3000,3001',
        description: 'Block UI from reaching Control Panel services',
      },
      {
        action: 'reject',
        protocol: 'tcp',
        destination: `${pointerIP}/32`,
        destination_port: '4001,4002',
        description: 'Block UI from reaching Pointer directly',
      },
    ],
    config: {},
  };

  try {
    await incusRequest('POST', '/1.0/network-acls', body);
  } catch {
    await incusRequest('PUT', `/1.0/network-acls/${UI_EGRESS_ACL}`, {
      description: body.description,
      ingress: body.ingress,
      egress: body.egress,
      config: {},
    });
  }

  const res = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-ui');
  const devices = { ...(res.metadata.devices || {}) };
  devices.eth0 = {
    ...(devices.eth0 || { type: 'nic', network: 'incusbr0', name: 'eth0' }),
    'security.acls': UI_EGRESS_ACL,
    'security.acls.default.ingress.action': 'allow',
    'security.acls.default.egress.action': 'allow',
  };
  await incusRequest('PATCH', '/1.0/instances/youeye-ui', { devices });

  const verify = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-ui');
  const eth0 = verify.metadata.devices?.eth0;
  if (
    !eth0 ||
    eth0['security.acls'] !== UI_EGRESS_ACL ||
    eth0['security.acls.default.ingress.action'] !== 'allow' ||
    eth0['security.acls.default.egress.action'] !== 'allow'
  ) {
    throw new Error('youeye-ui eth0 did not verify with UI egress ACL attached');
  }
}

export async function repairSystemSecurityPosture(): Promise<void> {
  await repairControlPanelProxy();
  await repairUIEgressAcl();
}
