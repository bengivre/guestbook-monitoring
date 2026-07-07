import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GuestbookAlerts } from "./alerts";
import { Guestbook } from "./guestbook";
import { Monitoring } from "./monitoring";

const cfg = new pulumi.Config();
const useLoadBalancer = cfg.getBoolean("useLoadBalancer") ?? true;
const localKindCluster = cfg.getBoolean("localKindCluster") ?? false;
const grafanaAdminPasswordCfg = cfg.get("grafanaAdminPassword") ?? "prom-operator";
// When useLoadBalancer=false (e.g. kind/Minikube), pin NodePorts so a host
// port-mapping / access script can reach them at a known address.
const grafanaNodePort = cfg.getNumber("grafanaNodePort");
const frontendNodePort = cfg.getNumber("frontendNodePort");

// --- Namespaces --------------------------------------------------------------
const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});
const appNs = new k8s.core.v1.Namespace("guestbook", {
    metadata: { name: "guestbook" },
});

// --- Monitoring stack (installs Prometheus Operator CRDs) --------------------
const monitoring = new Monitoring("monitoring", {
    namespace: monitoringNs.metadata.name,
    grafanaAdminPassword: grafanaAdminPasswordCfg,
    useLoadBalancer,
    grafanaNodePort,
    localKindCluster,
});

// --- Guestbook app (ServiceMonitors depend on the Operator's CRDs) -----------
const guestbook = new Guestbook("guestbook", {
    namespace: appNs.metadata.name,
    useLoadBalancer,
    frontendNodePort,
    dependsOn: [monitoring.release],
});

new GuestbookAlerts("guestbook-alerts", {
    namespace: appNs.metadata.name,
    dependsOn: [monitoring.release],
});

// --- Outputs -----------------------------------------------------------------
export const guestbookUrl = guestbook.frontendUrl;
export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = monitoring.grafanaAdminUser;
export const grafanaAdminPassword = monitoring.grafanaAdminPassword;
