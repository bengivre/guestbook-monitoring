import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { guestbookDashboard } from "./dashboard";
import { helmManagedServiceUrl } from "./urls";

export interface MonitoringArgs {
    /** Namespace to install the monitoring stack into (created here). */
    namespace: pulumi.Input<string>;
    /** Grafana admin password. */
    grafanaAdminPassword: pulumi.Input<string>;
    /** Expose Grafana as a cloud LoadBalancer (true) or NodePort (false). */
    useLoadBalancer: boolean;
    /** Pinned NodePort for Grafana when useLoadBalancer=false (30000-32767). */
    grafanaNodePort?: number;
    /** kind clusters cannot scrape control-plane metrics; omit those targets. */
    localKindCluster?: boolean;
}

/**
 * Installs the kube-prometheus-stack Helm chart, which bundles:
 *   - Prometheus + the Prometheus Operator (ServiceMonitor / PodMonitor CRDs)
 *   - Grafana (pre-wired to Prometheus as its default datasource)
 *   - node-exporter, kube-state-metrics and cAdvisor scrape configs
 *
 * The Operator is configured to pick up ServiceMonitors from ALL namespaces
 * (not just those bearing Helm's release labels), so the Guestbook's Redis
 * ServiceMonitors are discovered automatically.
 */
export class Monitoring extends pulumi.ComponentResource {
    /** Helm release; depend on this so ServiceMonitor CRDs exist first. */
    public readonly release: k8s.helm.v3.Release;
    public readonly grafanaUrl: pulumi.Output<string>;
    public readonly grafanaAdminUser = "admin";
    public readonly grafanaAdminPassword: pulumi.Output<string>;

    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:monitoring:Monitoring", name, {}, opts);
        const parentOpts = { parent: this };
        const releaseName = "kps";
        const localKindCluster = args.localKindCluster ?? false;

        // Auto-imported Grafana dashboard (sidecar watches this label).
        new k8s.core.v1.ConfigMap("guestbook-dashboard", {
            metadata: {
                namespace: args.namespace,
                labels: { grafana_dashboard: "1" },
            },
            data: { "guestbook.json": JSON.stringify(guestbookDashboard) },
        }, parentOpts);

        this.release = new k8s.helm.v3.Release(releaseName, {
            name: releaseName,
            chart: "kube-prometheus-stack",
            version: "62.3.0",
            namespace: args.namespace,
            repositoryOpts: {
                repo: "https://prometheus-community.github.io/helm-charts",
            },
            // Give CRD install + operator time to become ready.
            timeout: 900,
            values: {
                ...(localKindCluster ? {
                    // Static pods on kind do not expose scrapeable control-plane metrics.
                    kubeControllerManager: { enabled: false },
                    kubeEtcd: { enabled: false },
                    kubeProxy: { enabled: false },
                    kubeScheduler: { enabled: false },
                    defaultRules: {
                        rules: {
                            etcd: false,
                            kubeControllerManager: false,
                            kubeProxy: false,
                            kubeSchedulerAlerting: false,
                        },
                    },
                } : {}),
                grafana: {
                    adminUser: this.grafanaAdminUser,
                    adminPassword: args.grafanaAdminPassword,
                    service: {
                        type: args.useLoadBalancer ? "LoadBalancer" : "NodePort",
                        port: 80,
                        ...(args.useLoadBalancer ? {} : { nodePort: args.grafanaNodePort }),
                    },
                    // Watch ConfigMaps cluster-wide for `grafana_dashboard` label.
                    sidecar: {
                        dashboards: { enabled: true, searchNamespace: "ALL" },
                    },
                },
                prometheus: {
                    prometheusSpec: {
                        // Discover ServiceMonitors / PodMonitors regardless of the
                        // Helm release label — required for our Redis monitors.
                        serviceMonitorSelectorNilUsesHelmValues: false,
                        podMonitorSelectorNilUsesHelmValues: false,
                        ruleSelectorNilUsesHelmValues: false,
                        retention: "6h",
                    },
                },
            },
        }, parentOpts);

        const grafanaServiceName = `${releaseName}-grafana`;
        this.grafanaAdminPassword = pulumi.secret(pulumi.output(args.grafanaAdminPassword));
        this.grafanaUrl = helmManagedServiceUrl(
            args.useLoadBalancer,
            args.grafanaNodePort,
            80,
            args.namespace,
            grafanaServiceName,
        );

        this.registerOutputs({
            grafanaUrl: this.grafanaUrl,
            grafanaAdminUser: this.grafanaAdminUser,
        });
    }
}
