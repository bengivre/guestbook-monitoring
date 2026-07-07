import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface GuestbookAlertsArgs {
    /** Namespace where Guestbook workloads run (rules match guestbook metrics). */
    namespace: pulumi.Input<string>;
    /** Helm release name for kube-prometheus-stack (labels PrometheusRule for discovery). */
    releaseName?: string;
    dependsOn?: pulumi.Resource[];
    opts?: pulumi.ComponentResourceOptions;
}

/**
 * PrometheusRule CRs for Guestbook health — evaluated by the stack's Prometheus.
 */
export class GuestbookAlerts extends pulumi.ComponentResource {
    constructor(name: string, args: GuestbookAlertsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:monitoring:GuestbookAlerts", name, {}, opts);
        const parentOpts = { parent: this, dependsOn: args.dependsOn };
        const release = args.releaseName ?? "kps";

        new k8s.apiextensions.CustomResource("guestbook-alerts", {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "PrometheusRule",
            metadata: {
                name: "guestbook-alerts",
                namespace: args.namespace,
                labels: { release },
            },
            spec: {
                groups: [{
                    name: "guestbook.rules",
                    rules: [
                        {
                            alert: "GuestbookRedisDown",
                            expr: "redis_up == 0",
                            for: "2m",
                            labels: { severity: "critical" },
                            annotations: {
                                summary: "Redis instance is down",
                                description: "redis_up is 0 for {{ $labels.instance }} (role {{ $labels.role }}).",
                            },
                        },
                        {
                            alert: "GuestbookHighRedisErrorRate",
                            expr: "sum(rate(redis_rejected_connections_total[5m])) > 0",
                            for: "5m",
                            labels: { severity: "warning" },
                            annotations: {
                                summary: "Redis is rejecting connections",
                                description: "redis_rejected_connections_total is increasing — check Redis capacity and client limits.",
                            },
                        },
                        {
                            alert: "GuestbookNoTraffic",
                            expr: [
                                "sum(rate(apache_accesses_total[10m])) == 0",
                                "and",
                                "kube_deployment_status_replicas_available{namespace=\"guestbook\", deployment=\"frontend\"} > 0",
                            ].join(" "),
                            for: "15m",
                            labels: { severity: "info" },
                            annotations: {
                                summary: "Guestbook frontend has no HTTP traffic",
                                description: "apache_accesses_total has been flat for 10m while frontend replicas are available.",
                            },
                        },
                    ],
                }],
            },
        }, parentOpts);

        this.registerOutputs({});
    }
}
