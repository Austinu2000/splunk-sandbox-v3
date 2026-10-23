import type { InfraNodeInfo, InfraRole } from '@sandbox/shared';
import type { WorldConfig } from './config';

export interface InfraNode extends InfraNodeInfo {
  retired?: boolean;
}

/**
 * Named infrastructure nodes. These are separate from the forwarder fleet and are not seeded:
 * every world has the same tier, laid out across the configured sites.
 */
export function generateInfra(cfg: WorldConfig): InfraNode[] {
  const nodes: InfraNode[] = [];
  const add = (hostname: string, role: InfraRole, siteIdx: number, hostOctet: number) => {
    const site = cfg.sites[siteIdx]!;
    nodes.push({ hostname, role, site: site.id, ip: `10.${site.subnet}.0.${hostOctet}`, status: 'up' });
  };

  // Two indexers per site.
  let idx = 1;
  cfg.sites.forEach((_, s) => {
    for (let k = 0; k < 2; k++, idx++) add(`idx${pad2(idx)}`, 'indexer', s, 20 + k);
  });
  for (let k = 1; k <= 3; k++) add(`sh${pad2(k)}`, 'search_head', 0, 30 + k);
  add('ds01', 'deployment_server', 0, 10);
  add('cm01', 'cluster_manager', 0, 11);
  add('lm01', 'license_manager', 0, 12);
  cfg.sites.forEach((_, s) => add(`hf${pad2(s + 1)}`, 'heavy_forwarder', s, 40));

  // A decommissioned indexer: the machine and its DNS name still exist, but Splunk was removed.
  // Old build images and stale outputs.conf files can still point at it.
  add('idx07', 'indexer', 0, 27);
  Object.assign(nodes[nodes.length - 1]!, { status: 'down', retired: true });

  return nodes;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
