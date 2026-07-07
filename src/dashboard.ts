/**
 * Grafana dashboard for the Guestbook, delivered as a ConfigMap.
 * The Grafana sidecar shipped with kube-prometheus-stack auto-imports any
 * ConfigMap labelled `grafana_dashboard: "1"`, so no manual import is needed.
 *
 * Layout:
 *   Row 1 — HTTP + Redis request rates
 *   Row 2 — Connections, workers, errors
 *   Row 3 — Redis memory + pod resources
 */
export const guestbookDashboard = {
    title: "Guestbook Overview",
    uid: "guestbook-overview",
    editable: true,
    schemaVersion: 39,
    time: { from: "now-30m", to: "now" },
    refresh: "10s",
    templating: {
        list: [{
            name: "datasource",
            type: "datasource",
            query: "prometheus",
            current: { text: "Prometheus", value: "Prometheus" },
            hide: 0,
        }],
    },
    panels: [
        {
            id: 1,
            title: "HTTP request rate (frontend)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 0, y: 0 },
            fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(rate(apache_accesses_total[1m]))",
                legendFormat: "HTTP req/s",
            }],
        },
        {
            id: 2,
            title: "Redis commands processed (req/s)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 12, y: 0 },
            fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(rate(redis_commands_processed_total[1m])) by (role)",
                legendFormat: "{{role}}",
            }],
        },
        {
            id: 3,
            title: "Redis connected clients",
            type: "stat",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 8, x: 0, y: 8 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(redis_connected_clients)",
                legendFormat: "clients",
            }],
        },
        {
            id: 4,
            title: "Apache busy workers",
            type: "stat",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 8, x: 8, y: 8 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(apache_workers{state=\"busy\"})",
                legendFormat: "busy",
            }],
        },
        {
            id: 5,
            title: "Redis rejected connections (errors/s)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 8, x: 16, y: 8 },
            fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(rate(redis_rejected_connections_total[1m]))",
                legendFormat: "rejected/s",
            }],
        },
        {
            id: 6,
            title: "Redis memory usage",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 0, y: 16 },
            fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(redis_memory_used_bytes) by (role)",
                legendFormat: "{{role}}",
            }],
        },
        {
            id: 7,
            title: "Frontend pod restarts",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 12, y: 16 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(kube_pod_container_status_restarts_total{namespace=\"guestbook\", pod=~\"frontend-.*\"}) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 8,
            title: "Frontend pod CPU (cores)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 0, y: 24 },
            fieldConfig: { defaults: { unit: "short" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(rate(container_cpu_usage_seconds_total{namespace=\"guestbook\", pod=~\"frontend-.*\", container=\"php-redis\"}[1m])) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 9,
            title: "Frontend pod memory (bytes)",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "${datasource}" },
            gridPos: { h: 8, w: 12, x: 12, y: 24 },
            fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "${datasource}" },
                expr: "sum(container_memory_working_set_bytes{namespace=\"guestbook\", pod=~\"frontend-.*\", container=\"php-redis\"}) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
    ],
};
