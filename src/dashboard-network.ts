/**
 * Dashboard Network -- Network Monitoring Integration
 *
 * This is a stub module included as an extension point. The full module
 * integrates with pfSense/OPNsense APIs to display network status,
 * interface stats, connected devices, and firewall logs on the dashboard.
 *
 * Implement the functions below to enable the network monitoring panel.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface NetworkStatus {
  cpu: number;
  memory: number;
  uptime: number;
  temperature: number;
}

export interface NetworkInterface {
  name: string;
  status: string;
  bytesIn: number;
  bytesOut: number;
  speed: string;
}

export interface NetworkDevice {
  ip: string;
  hostname: string;
  vendor: string;
  vlan: string;
  mac: string;
  lastSeen: number;
}

export interface FirewallLogEntry {
  time: string;
  action: string;
  interface: string;
  source: string;
  destination: string;
  protocol: string;
}

// ── Functions ───────────────────────────────────────────────────────

/**
 * Get router/firewall system status (CPU, memory, uptime, temperature).
 *
 * Stub: returns null. Implement with your router's API to enable.
 */
export async function getNetworkStatus(): Promise<NetworkStatus | null> {
  return null;
}

/**
 * Get network interface statistics (WAN, LAN, VLANs).
 *
 * Stub: returns empty array. Implement with your router's API to enable.
 */
export async function getNetworkInterfaces(): Promise<NetworkInterface[]> {
  return [];
}

/**
 * Get connected network devices with vendor identification.
 *
 * Stub: returns empty array. Implement with ARP table or DHCP lease data.
 */
export function getNetworkDevices(): NetworkDevice[] {
  return [];
}

/**
 * Get recent firewall log entries.
 *
 * Stub: returns empty array. Implement with your firewall's log API.
 */
export async function getFirewallLog(_limit?: number): Promise<FirewallLogEntry[]> {
  return [];
}
