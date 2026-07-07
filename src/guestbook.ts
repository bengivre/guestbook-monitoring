import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { pulumiManagedServiceUrl } from "./urls";

export interface GuestbookArgs {
    /** Namespace to deploy the guestbook into. */
    namespace: pulumi.Input<string>;
    /** Expose the frontend as a cloud LoadBalancer (true) or NodePort (false). */
    useLoadBalancer: boolean;
    /** Pinned NodePort for the frontend when useLoadBalancer=false (30000-32767). */
    frontendNodePort?: number;
    /** Provider that installed the Prometheus Operator CRDs (ServiceMonitor). */
    dependsOn?: pulumi.Resource[];
    opts?: pulumi.ComponentResourceOptions;
}

const REDIS_EXPORTER = "oliver006/redis_exporter:v1.62.0";
const APACHE_EXPORTER = "lusotycoon/apache-exporter:v1.0.12";

/** Apache mod_status snippet — localhost-only, required by apache_exporter. */
const APACHE_STATUS_CONF = `<Location "/server-status">
    SetHandler server-status
    Require local
</Location>
ExtendedStatus On
`;

/**
 * The classic Pulumi Kubernetes Guestbook (Redis leader/follower + PHP frontend),
 * extended with operator-native Prometheus scraping:
 *
 *   - each Redis pod runs an `oliver006/redis_exporter` sidecar on :9121
 *   - each frontend pod runs a `lusotycoon/apache-exporter` sidecar on :9117
 *     (scrapes Apache mod_status enabled via a mounted ConfigMap)
 *   - each Service publishes a named `metrics` port
 *   - a ServiceMonitor per tier tells Prometheus to scrape those ports
 *
 * Per-pod CPU/memory are additionally available from the stack's cAdvisor job.
 */
export class Guestbook extends pulumi.ComponentResource {
    public readonly frontendService: k8s.core.v1.Service;
    public readonly frontendUrl: pulumi.Output<string>;

    constructor(name: string, args: GuestbookArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:app:Guestbook", name, {}, opts);
        const parentOpts = { parent: this };
        const ns = args.namespace;

        // ---- Redis leader (writes) -------------------------------------------
        const leaderLabels = { app: "redis", role: "leader", tier: "backend" };
        new k8s.apps.v1.Deployment("redis-leader", {
            metadata: { namespace: ns, labels: leaderLabels },
            spec: {
                replicas: 1,
                selector: { matchLabels: leaderLabels },
                template: {
                    metadata: { labels: leaderLabels },
                    spec: {
                        containers: [
                            {
                                name: "redis-leader",
                                image: "redis:6.2-alpine",
                                resources: { requests: { cpu: "100m", memory: "100Mi" } },
                                ports: [{ containerPort: 6379 }],
                            },
                            {
                                name: "redis-exporter",
                                image: REDIS_EXPORTER,
                                env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
                                resources: { requests: { cpu: "25m", memory: "32Mi" } },
                                ports: [{ name: "metrics", containerPort: 9121 }],
                            },
                        ],
                    },
                },
            },
        }, parentOpts);

        const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
            metadata: { name: "redis-leader", namespace: ns, labels: leaderLabels },
            spec: {
                selector: leaderLabels,
                ports: [
                    { name: "redis", port: 6379, targetPort: 6379 },
                    { name: "metrics", port: 9121, targetPort: "metrics" },
                ],
            },
        }, parentOpts);

        // ---- Redis follower (reads) ------------------------------------------
        const followerLabels = { app: "redis", role: "follower", tier: "backend" };
        new k8s.apps.v1.Deployment("redis-follower", {
            metadata: { namespace: ns, labels: followerLabels },
            spec: {
                replicas: 2,
                selector: { matchLabels: followerLabels },
                template: {
                    metadata: { labels: followerLabels },
                    spec: {
                        containers: [
                            {
                                name: "redis-follower",
                                image: "gcr.io/google_samples/gb-redis-follower:v2",
                                resources: { requests: { cpu: "100m", memory: "100Mi" } },
                                ports: [{ containerPort: 6379 }],
                            },
                            {
                                name: "redis-exporter",
                                image: REDIS_EXPORTER,
                                env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
                                resources: { requests: { cpu: "25m", memory: "32Mi" } },
                                ports: [{ name: "metrics", containerPort: 9121 }],
                            },
                        ],
                    },
                },
            },
        }, parentOpts);

        const redisFollowerService = new k8s.core.v1.Service("redis-follower", {
            metadata: { name: "redis-follower", namespace: ns, labels: followerLabels },
            spec: {
                selector: followerLabels,
                ports: [
                    { name: "redis", port: 6379, targetPort: 6379 },
                    { name: "metrics", port: 9121, targetPort: "metrics" },
                ],
            },
        }, parentOpts);

        // pulumi/guestbook-php-redis reads from DNS name "redis-replica" (not redis-follower).
        new k8s.core.v1.Service("redis-replica", {
            metadata: { name: "redis-replica", namespace: ns, labels: followerLabels },
            spec: {
                selector: followerLabels,
                ports: [
                    { name: "redis", port: 6379, targetPort: 6379 },
                    { name: "metrics", port: 9121, targetPort: "metrics" },
                ],
            },
        }, parentOpts);

        // ---- ServiceMonitors: Prometheus scrapes exporter :metrics ports -------
        const smOpts = { parent: this, dependsOn: args.dependsOn };
        const backendEndpoint = {
            port: "metrics",
            interval: "15s",
            relabelings: [{ targetLabel: "tier", replacement: "backend" }],
        };
        for (const [role] of [["leader", redisLeaderService], ["follower", redisFollowerService]] as const) {
            new k8s.apiextensions.CustomResource(`redis-${role}-sm`, {
                apiVersion: "monitoring.coreos.com/v1",
                kind: "ServiceMonitor",
                metadata: {
                    name: `redis-${role}`,
                    namespace: ns,
                    labels: { app: "redis", role, release: "kps" },
                },
                spec: {
                    selector: { matchLabels: { app: "redis", role } },
                    endpoints: [backendEndpoint],
                },
            }, smOpts);
        }

        // ---- PHP frontend + apache_exporter sidecar ----------------------------
        const frontendLabels = { app: "guestbook", tier: "frontend" };

        const apacheStatusConfig = new k8s.core.v1.ConfigMap("apache-status", {
            metadata: { namespace: ns, labels: frontendLabels },
            data: { "status.conf": APACHE_STATUS_CONF },
        }, parentOpts);

        new k8s.apps.v1.Deployment("frontend", {
            metadata: { namespace: ns, labels: frontendLabels },
            spec: {
                replicas: 3,
                selector: { matchLabels: frontendLabels },
                template: {
                    metadata: { labels: frontendLabels },
                    spec: {
                        volumes: [{
                            name: "apache-status",
                            configMap: { name: apacheStatusConfig.metadata.name },
                        }],
                        containers: [
                            {
                                name: "php-redis",
                                image: "pulumi/guestbook-php-redis",
                                env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                                resources: { requests: { cpu: "100m", memory: "100Mi" } },
                                ports: [{ name: "http", containerPort: 80 }],
                                volumeMounts: [{
                                    name: "apache-status",
                                    mountPath: "/etc/apache2/conf-enabled/status.conf",
                                    subPath: "status.conf",
                                }],
                            },
                            {
                                name: "apache-exporter",
                                image: APACHE_EXPORTER,
                                args: ["--scrape_uri=http://127.0.0.1/server-status?auto"],
                                resources: { requests: { cpu: "25m", memory: "32Mi" } },
                                ports: [{ name: "metrics", containerPort: 9117 }],
                            },
                        ],
                    },
                },
            },
        }, parentOpts);

        this.frontendService = new k8s.core.v1.Service("frontend", {
            metadata: { name: "frontend", namespace: ns, labels: frontendLabels },
            spec: {
                type: args.useLoadBalancer ? "LoadBalancer" : "NodePort",
                selector: frontendLabels,
                ports: [
                    {
                        name: "http",
                        port: 80,
                        targetPort: "http",
                        ...(args.useLoadBalancer ? {} : { nodePort: args.frontendNodePort }),
                    },
                    { name: "metrics", port: 9117, targetPort: "metrics" },
                ],
            },
        }, parentOpts);

        new k8s.apiextensions.CustomResource("frontend-sm", {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: {
                name: "frontend",
                namespace: ns,
                labels: { app: "guestbook", tier: "frontend", release: "kps" },
            },
            spec: {
                selector: { matchLabels: frontendLabels },
                endpoints: [{
                    port: "metrics",
                    interval: "15s",
                    relabelings: [{ targetLabel: "tier", replacement: "frontend" }],
                }],
            },
        }, smOpts);

        this.frontendUrl = pulumiManagedServiceUrl(
            this.frontendService,
            args.useLoadBalancer,
            80,
            args.frontendNodePort,
        );

        this.registerOutputs({
            frontendService: this.frontendService,
            frontendUrl: this.frontendUrl,
        });
    }
}
